import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {CodexRuntime} from './lib/codex.mjs';

function fixture() {
  let changed=false, replacements=0, writes=[];
  const rt = new CodexRuntime({
    nativeModelMetadata:false,
    resolveCommand:()=> changed?'new':'old',
    assessRuntime:()=> changed?{state:'moved',command:'new'}:{state:'current'},
  });
  rt.command='old';
  rt.info.connected=true;
  rt.info.authenticated=true;
  rt.info.connection.phase='ready';
  rt.info.defaultModel='model';
  rt.info.models=[{id:'model',model:'model'}];
  const old=new EventEmitter();
  old.exitCode=null;
  old.signalCode=null;
  old.stdin={
    writable:true,
    end(){ old.exitCode=0; old.emit('exit',0,null); },
    write(data, callback){writes.push({data,callback});return true;},
  };
  old.kill=()=>true;
  rt.child=old;
  rt._startWithRecovery=async()=>{
    replacements++;
    rt.info.connected=true;
    rt.info.authenticated=true;
    rt.info.connection.phase='ready';
    return rt.status();
  };
  return {rt,old,writes,move:()=>{changed=true;},replacements:()=>replacements};
}

test('cancellation of one protected preflight waiter does not let runtime retire its still-active preflight',async()=>{
  const {rt,old,move,replacements}=fixture();
  let release, entered;
  const inPreflight=new Promise(resolve=>{entered=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  rt._planningFeatureList=async()=>{entered();await gate;throw new Error('fixture completes without starting a model');};
  const controller=new AbortController();
  const verify=rt.ensureHostOnlyToolDispatch({model:'model',cwd:path.resolve('.'),signal:controller.signal});
  await inPreflight;
  assert.equal(rt.hostOnlyPreflights.size,1,'registered preflight persists independently of waiter');
  controller.abort();
  await assert.rejects(verify,{name:'AbortError'});
  assert.equal(rt.hostOnlyPreflights.size,1,'cancelled waiter must not destroy the outstanding preflight');
  move();
  let outcome='replaced';
  try {await rt.start();}catch(error){outcome=error.code;}
  release();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(outcome,'CODEX_RUNTIME_CHANGED_BUSY','still-running native preflight must fence old-process replacement');
  assert.equal(replacements(),0);
  assert.equal(rt.child,old);
});

test('an admitted local tool still processing its effect prevents runtime replacement',async()=>{
  const {rt,old,move,replacements}=fixture();
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  rt._request=async()=>({});
  const state={
    threadId:'t',turnId:'t1',done:false,settled:false, dynamicTools:[{type:'function',name:'do'}],
    onToolCall:async()=>{started();await gate;return{success:true,contentItems:[]};},
    toolController:new AbortController(),toolCalls:new Set(),approvalCancels:new Set(),messages:new Map(),
    cancelDeadline:()=>{},resolve:()=>{},reject:()=>{},codexHistory:'relay',inputImageCount:0,
  };
  rt.threads.set('t',state);
  const dispatched=rt._dynamicToolCall({id:42,params:{threadId:'t',turnId:'t1',tool:'do',arguments:'{}'}});
  await entered;
  const settling=rt._finish(state);
  move();
  let outcome='replaced';
  try{await rt.start();}catch(error){outcome=error.code;}
  assert.equal(outcome,'CODEX_RUNTIME_CHANGED_BUSY');
  assert.equal(replacements(),0);
  assert.equal(rt.child,old);
  release();
  await Promise.allSettled([dispatched,settling]);
});

test('a tool response awaiting stream-write callback fences retirement until its receipt callback settles',async()=>{
  const {rt,old,writes,move,replacements}=fixture();
  rt._request=async()=>({});
  let delivered=0;
  const state={
    threadId:'t',turnId:'t1',done:false,settled:false, dynamicTools:[{type:'function',name:'do'}],
    onToolCall:async()=>({success:true,contentItems:[]}),
    onToolResultDelivered:()=>{delivered++;},
    toolController:new AbortController(),toolCalls:new Set(),approvalCancels:new Set(),messages:new Map(),
    cancelDeadline:()=>{},resolve:()=>{},reject:()=>{},codexHistory:'relay',inputImageCount:0,
  };
  rt.threads.set('t',state);
  await rt._dynamicToolCall({id:42,params:{threadId:'t',turnId:'t1',tool:'do',arguments:'{}'}});
  assert.equal(writes.length,1);
  assert.equal(delivered,0);
  await rt._finish(state);
  move();
  let outcome='replaced';
  try{await rt.start();}catch(error){outcome=error.code;}
  assert.equal(outcome,'CODEX_RUNTIME_CHANGED_BUSY','pending native write acknowledgment must fence replacement');
  assert.equal(replacements(),0);
  assert.equal(rt.child,old);
  writes[0].callback();
  assert.equal(delivered,1);
});

test('simultaneous new turns do not cause all start admissions to deadlock on one shared startPromise',async()=>{
  const {rt,move}=fixture();
  rt._sessionConfig=async()=>{throw new Error('fixture stop after start');};
  move();
  const options={cwd:path.resolve('.'),prompt:'test',model:'model'};
  const outcomes=await Promise.all([rt.runAgent(options),rt.runAgent(options)].map(v=>v.then(()=>({code:'OK'}),err=>({code:err.code||err.message}))));
  assert.ok(outcomes.some(o=>o.code!=='CODEX_RUNTIME_CHANGED_BUSY'), 'one turn should be able to initialize a healthy new process while another waits or fails');
  assert.equal(rt.preThreadAdmissions.size,0,'every rejected or settled caller must release its admission');
});

test('a canceled admission releases its guard but does not cancel a shared caller startup',async()=>{
  const {rt}=fixture();
  let release,entered;
  const pending=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  rt._startWithRecovery=async()=>{entered();await pending;rt.info.connected=true;rt.info.authenticated=true;rt._connectionPhase('ready');return rt.status();};
  rt.info.connected=false;
  rt._sessionConfig=async()=>{throw new Error('fixture stop');};
  const controller=new AbortController();
  const options={cwd:path.resolve('.'),prompt:'test',model:'model'};
  const cancelled=rt.runAgent({...options,signal:controller.signal});
  const surviving=rt.runAgent(options);
  await started;
  controller.abort();
  await assert.rejects(cancelled,{name:'AbortError'});
  assert.equal(rt.preThreadAdmissions.size,1,'aborted waiter must release only its own claim');
  release();
  await assert.rejects(surviving,/fixture stop/);
  assert.equal(rt.preThreadAdmissions.size,0);
});

test('an orphaned process whose retirement was unconfirmed cannot be overwritten after discovery returns to its former command',async()=>{
  const {rt,old,replacements}=fixture();
  rt.info.connected=false;
  rt.info.authenticated=false;
  old.stdin.end=()=>{};
  old.kill=()=>false;
  await assert.rejects(rt.start(),{code:'CODEX_RUNTIME_RETIRE_UNCONFIRMED'});
  assert.equal(replacements(),0,'cannot spawn on top of a retained, unexited old child');
  assert.equal(rt.child,old,'retain the old process for reconciliation');
});

test('late write completion after connection loss never becomes a delivered receipt',async()=>{
  const {rt,old,writes}=fixture();
  let ack=0;
  rt._send({id:12,result:{accepted:true}},()=>{ack++;});
  assert.equal(rt.pendingNativeWrites.size,1);
  rt._connectionFailed(Object.assign(new Error('disconnected'),{code:'CODEX_DISCONNECTED'}),old);
  assert.equal(rt.pendingNativeWrites.size,0);
  assert.equal(rt.child,null);
  writes[0].callback();
  assert.equal(ack,0,'stale callbacks must never be acknowledged under a replacement');
});

test('tool writes without a planning delivery hook also retain retirement ownership', async()=>{
  const {rt,old,writes,move,replacements}=fixture();
  rt._request=async()=>({});
  const state={
    threadId:'t',turnId:'t1',done:false,settled:false,
    dynamicTools:[{type:'function',name:'do'}],
    onToolCall:async()=>({success:true,contentItems:[]}),
    toolController:new AbortController(),toolCalls:new Set(),approvalCancels:new Set(),messages:new Map(),
    cancelDeadline:()=>{},resolve:()=>{},reject:()=>{},codexHistory:'relay',inputImageCount:0,
  };
  rt.threads.set('t',state);
  await rt._dynamicToolCall({id:5,params:{threadId:'t',turnId:'t1',tool:'do',arguments:'{}'}});
  assert.equal(writes.length,1);
  await rt._finish(state);
  move();
  await assert.rejects(rt.start(),{code:'CODEX_RUNTIME_CHANGED_BUSY'});
  assert.equal(replacements(),0);
  assert.equal(rt.child,old);
  writes[0].callback();
  assert.equal(rt.pendingNativeWrites.size,0);
});