import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {CodexRuntime} from '../lib/codex.mjs';

function fixture({exitOnEnd=true}={}){
  let now=0,spawns=0,delivered=0;
  const writes=[],events=[];
  const runtime=new CodexRuntime({nativeModelMetadata:false,nativeWriteStallMs:50,
    nativeWriteNow:()=>now,resolveCommand:()=> 'codex',assessRuntime:()=>({state:'current'})});
  runtime.info.connected=true; runtime.info.authenticated=true;runtime.info.connection.phase='ready';
  runtime.info.defaultModel='model'; runtime.info.models=[{id:'model',model:'model'}];
  const old=new EventEmitter();
  old.pid=29114; old.exitCode=null;old.signalCode=null;old.killed=false;
  old.stdin={writable:true,write(data,cb){writes.push({data,cb});},
    end(){if(exitOnEnd){old.exitCode=0;old.emit('exit',0,null);}}};
  old.kill=()=>false;runtime.child=old;
  runtime._startWithRecovery=async()=>{
    spawns++;const fresh=new EventEmitter();fresh.pid=29115;fresh.stdin={writable:true,write(){}};
    fresh.exitCode=null; fresh.signalCode=null;runtime.child=fresh;
    runtime.info.connected=true;runtime.info.authenticated=true;runtime._connectionPhase('ready');
    return runtime.status();
  };
  const state={threadId:'thread1',turnId:'turn1',onEvent:e=>events.push(e),
    onToolResultDelivered:()=>{delivered++;}};
  const send=()=>runtime._send({id:42,result:{success:true,contentItems:[]}},()=>state.onToolResultDelivered(),
    {kind:'tool-result',tool:'relay_workspace',callId:'call42',threadId:'thread1',turnId:'turn1',state});
  return{runtime,old,writes,events,state,send,advance:ms=>now=ms,spawns:()=>spawns,delivered:()=>delivered};
}

test('runtime reports stall, refuses implicit new work, and independently reconnects only after confirmed exit',async()=>{
  const f=fixture();f.send();f.advance(51);
  assert.equal(f.runtime.status().nativeWrites.oldestWriteId,1);
  await assert.rejects(f.runtime.start(),{code:'CODEX_NATIVE_WRITE_STALLED'});
  assert.equal(f.spawns(),0);
  const result=await f.runtime.recoverStalledNativeWrites({expectedWriteId:1,expectedPid:29114});
  assert.equal(result.status,'retired');
  assert.equal(result.deliveryStatus,'unknown');
  assert.equal(f.runtime.child,null);
  assert.equal(f.delivered(),0);
  assert.equal(f.events.filter(e=>e.type==='native.write.uncertain').length,1);
  assert.equal(f.runtime.nativeWriteUncertaintyReceipts().length,1);
  f.writes[0].cb();
  assert.equal(f.delivered(),0,'late local callback must not upgrade uncertain result');
  assert.equal((await f.runtime.start()).connected,true);
  assert.equal(f.spawns(),1);
  assert.notEqual(f.runtime.child,f.old);
});

test('explicit recovery without old-process exit retains handle and error, even after a late callback',async()=>{
  const f=fixture({exitOnEnd:false});f.send();f.advance(51);
  await assert.rejects(f.runtime.recoverStalledNativeWrites({expectedWriteId:1}),{code:'CODEX_NATIVE_WRITE_RETIRE_UNCONFIRMED'});
  assert.equal(f.runtime.child,f.old);
  assert.equal(f.runtime.info.connected,false);
  assert.equal(f.runtime.nativeWriteStatus().uncertainCount,1);
  await assert.rejects(f.runtime.start(),{code:'CODEX_NATIVE_WRITE_RETIRE_UNCONFIRMED'});
  f.writes[0].cb();
  assert.equal(f.delivered(),0);
  assert.equal(f.runtime.nativeWriteStatus().uncertainCount,1);
});

test('canceling a protected preflight waiter cannot permit recovery while its actual promise runs',async()=>{
  const f=fixture();
  let entered,release;
  const started=new Promise(resolve=>entered=resolve);
  const gate=new Promise(resolve=>release=resolve);
  f.runtime._planningFeatureList=async()=>{entered();await gate;throw new Error('preflight deliberately ended');};
  const controller=new AbortController();
  const preflight=f.runtime.ensureHostOnlyToolDispatch({model:'model',cwd:path.resolve('.'),signal:controller.signal});
  await started;
  controller.abort();await assert.rejects(preflight,{name:'AbortError'});
  assert.equal(f.runtime.hostOnlyPreflights.size,1);
  f.send();f.advance(51);
  await assert.rejects(f.runtime.recoverStalledNativeWrites({expectedWriteId:1}),{code:'CODEX_NATIVE_WRITE_RECOVERY_BUSY'});
  release();
  for(let i=0;i<10&&f.runtime.hostOnlyPreflights.size;i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(f.runtime.hostOnlyPreflights.size,0);
  const result=await f.runtime.recoverStalledNativeWrites({expectedWriteId:1});
  assert.equal(result.status,'retired');
});

test('failed callback records UNKNOWN even when no planning delivery observer exists',async()=>{
  const f=fixture();
  f.runtime._send({id:8,result:{}},()=>{},
    {kind:'tool-result',tool:'relay_workspace',callId:'no-hook',threadId:'thread1',turnId:'turn1',state:f.state});
  assert.equal(f.runtime.nativeWriteStatus().pendingCount,1);
  f.writes[0].cb(new Error('stream failure'));
  const unknown=f.runtime.nativeWriteUncertaintyReceipts();
  assert.equal(unknown.length,1);
  assert.equal(unknown[0].reason,'write-callback-error');
  assert.equal(unknown[0].providerAcknowledged,false);
  assert.equal(unknown[0].replayAllowed,false);
});

test('local tool effect must settle before recovery can retire the native process',async()=>{
  const f=fixture();f.send();f.advance(51);
  const state={threadId:'thread1',toolCalls:new Set([Promise.resolve()]),imageJobs:new Map()};
  f.runtime.threads.set('thread1',state);
  await assert.rejects(f.runtime.recoverStalledNativeWrites({expectedWriteId:1}),{code:'CODEX_NATIVE_WRITE_RECOVERY_BUSY'});
  assert.equal(f.runtime.child,f.old);
  assert.equal(f.runtime.nativeWriteStatus().uncertainCount,0);
  f.runtime.threads.clear();
});
