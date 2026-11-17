import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {CodexRuntime} from '../lib/codex.mjs';
import {handleNativeWriteRecoveryHttp} from '../lib/native-write-recovery-http.mjs';
import {createNativeWriteRecovery} from '../public/next/workspaces/native-write-recovery.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

test('operator route requires exact identity, preserves failure and flushes uncertainty',async()=>{
  const calls=[],state={pid:42,oldestWriteId:7,recoveryRequired:true};
  const codex={nativeWriteStatus:()=>state,nativeWriteUncertaintyReceipts:()=>[],recoverStalledNativeWrites:async value=>{calls.push(value);if(value.expectedWriteId!==7||value.expectedPid!==42)throw Object.assign(Error('Stale observation'),{code:'CODEX_NATIVE_WRITE_RECOVERY_STALE'});return {status:'retired',deliveryStatus:'unknown',replayAllowed:false};}};
  let writes=0;const engine={persist:async()=>{writes++;}},json=(_res,status,data)=>({status,data});
  const route=async(method,value,remote=false)=>handleNativeWriteRecoveryHttp({req:{method,headers:remote?{'x-blackice-remote':'1'}:{}},res:{},pathname:'/api/codex/native-write-recovery',runtime:{codex},engine,body:async()=>value,json});
  assert.equal((await route('GET')).data.status.oldestWriteId,7);
  assert.equal((await route('POST',{expectedWriteId:7})).status,400);
  assert.equal((await route('POST',{expectedWriteId:7,expectedPid:42},true)).status,403);
  assert.equal((await route('POST',{expectedWriteId:8,expectedPid:42})).data.code,'CODEX_NATIVE_WRITE_RECOVERY_STALE');
  const result=await route('POST',{expectedWriteId:7,expectedPid:42});
  assert.equal(result.data.result.deliveryStatus,'unknown');assert.equal(result.data.result.replayAllowed,false);
  assert.equal(calls.length,2);assert.equal(writes,2);
  engine.persist=async()=>{throw Error('disk unavailable');};
  assert.equal((await route('POST',{expectedWriteId:7,expectedPid:42})).data.code,'CODEX_RECOVERY_PERSIST_FAILED');
});

test('operator UI binds the observed token and PID and never repeats automatically',async t=>{
  const dom=planningDOM(t),calls=[];
  const api=async(route,method='GET',body)=>{calls.push({route,method,body});return method==='GET'?{status:{recoveryRequired:true,oldestWriteId:7,pid:42,uncertainCount:1}}:{result:{status:'retired'}};};
  const ui=createNativeWriteRecovery({mount:dom.mount,api});t.after(()=>ui.destroy());
  const buttons=dom.mount.querySelectorAll('button');assert.equal(buttons[1].disabled,true);
  await buttons[0].dispatch('click',{},true);assert.equal(buttons[1].disabled,false);
  await buttons[1].dispatch('click',{},true);assert.deepEqual(calls[1].body,{expectedWriteId:7,expectedPid:42});
  assert.equal(buttons[1].disabled,true);assert.equal(calls.length,2);
});

test('operator can identify uncertain calls without rendering markup and sees list bounds',async t=>{
  const dom=planningDOM(t),records=Array.from({length:65},(_,i)=>({writeId:i+1,kind:'tool-result',tool:'<example>',threadId:'thread-'+i,callId:'call-'+i,reason:'write-callback-error'}));
  const ui=createNativeWriteRecovery({mount:dom.mount,api:async()=>({status:{recoveryRequired:false,uncertainCount:65},uncertain:records})});t.after(()=>ui.destroy());
  await dom.mount.querySelectorAll('button')[0].dispatch('click',{},true);
  const list=dom.mount.querySelector('ul');assert.equal(list.getAttribute('aria-label'),'Uncertain native deliveries');
  assert.equal(list.children.length,64);assert.match(list.children[0].textContent,/thread-1; call call-1/);
  assert.match(list.children.at(-1).textContent,/tool <example>.*thread-64; call call-64/);
  assert.equal(list.children.at(-1).children.length,0,'identifiers must remain text');
  assert.match(dom.mount.textContent,/Showing 2–65 of 65 unconfirmed tool results/);
  const buttons=dom.mount.querySelectorAll('button');await buttons[2].dispatch('click',{},true);
  assert.equal(list.children.length,1);assert.match(list.children[0].textContent,/thread-0; call call-0/);
  await buttons[3].dispatch('click',{},true);assert.equal(list.children.length,64);
});

test('uncertain native delivery after cancellation persists and survives engine reopen',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'native-write-persist-'));const cwd=path.join(dir,'workspace'),dataDir=path.join(dir,'data');await mkdir(cwd);
  let onEvent,started;const entered=new Promise(resolve=>started=resolve);
  class Runtime extends EventEmitter {status(){return {connected:true,authenticated:true,defaultModel:'test-model',models:[{id:'test-model'}]};} async runAgent(options){onEvent=options.onEvent;started();return await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(Error('Cancelled'),{name:'AbortError'})),{once:true}));}}
  const runtime=new Runtime(),engine=await new HarnessEngine({runtime,dataDir,defaultCwd:cwd}).init();let reopened;
  t.after(async()=>{if(reopened)await reopened.close();await engine.close();await rm(dir,{recursive:true,force:true});});
  const graph={id:'recovery-fixture',name:'Recovery fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'test-model',prompt:'Work'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off',maxParallel:1}};
  const run=engine.startRun({workflow:graph,input:'Do a disposable task.'});await entered;engine.cancelRun(run.id);await engine.executions.get(run.id);
  const native=new CodexRuntime({nativeModelMetadata:false,nativeWriteStallMs:0,resolveCommand:()=> 'codex',assessRuntime:()=>({state:'current'})});
  const child=new EventEmitter();child.pid=42;child.exitCode=null;child.signalCode=null;child.killed=false;
  child.stdin={writable:true,write(){},end(){child.exitCode=0;child.emit('exit',0,null);}};child.kill=()=>false;native.child=child;
  native._send({id:7,result:{}},()=>assert.fail('Uncertain delivery cannot be acknowledged'),{kind:'tool-result',threadId:'thread',callId:'call',state:{threadId:'thread',onEvent}});
  const response=await handleNativeWriteRecoveryHttp({req:{method:'POST',headers:{}},res:{},pathname:'/api/codex/native-write-recovery',runtime:{codex:native},engine,body:async()=>({expectedWriteId:1,expectedPid:42}),json:(_res,status,data)=>({status,data})});
  assert.equal(response.status,200);assert.equal(response.data.result.deliveryStatus,'unknown');
  reopened=await new HarnessEngine({runtime:new Runtime(),dataDir,defaultCwd:cwd}).init();
  const restored=reopened.getRun(run.id);assert.equal(restored.status,'cancelled');
  assert.equal(restored.nodes.agent.nativeWriteUncertain[0].deliveryStatus,'unknown');
  assert.equal(restored.nodes.agent.nativeWriteUncertain[0].replayAllowed,false);
});
