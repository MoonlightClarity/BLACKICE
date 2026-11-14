import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {NativeWriteRecovery} from './native-write-recovery.mjs';

function fixture({exitOnEnd=true, now=0}={}) {
  const events=[], writes=[], callbackRecords=[], pid=48271;
  let currentTime=now, spawned=0;
  const rt=new EventEmitter();
  const old=new EventEmitter();
  old.pid=pid; old.exitCode=null;old.signalCode=null;old.killed=false;
  old.stdin={writable:true,write(data,callback){writes.push({data,callback});},
    end(){if(exitOnEnd){old.exitCode=0;old.emit('exit',0,null);}}};
  old.kill=()=>false;
  Object.assign(rt,{
    child:old, info:{connected:true,authenticated:true,connection:{phase:'ready'}},closing:false,
    threads:new Map(), openingThreads:new Set(), preThreadAdmissions:new Set(),
    pending:new Map(), hostOnlyPreflights:new Map(), pendingNativeWrites:new Set(),
    modelCheck:null,catalogRefresh:null,startPromise:null,
    _connectionPhase(phase){this.info.connection.phase=phase;},
    _emitRun(state,event){state.onEvent?.(event); events.push(event);},
    async _retireReplacedProcess(child){child.stdin.end();return child.exitCode!=null;},
    _connectionFailed(error,child){
      this.nativeWriteRecovery.connectionLost(child);
      if(this.child===child)this.child=null;
      this.info.connected=false;this.info.authenticated=false;
      this.info.connection.phase='failed';
      this.info.lastError=error.message;
    },
    status(){return {nativeWrites:this.nativeWriteRecovery.status()};},
    async start(){this.nativeWriteRecovery.assertStartAllowed();spawned++;return {connected:true};},
  });
  const recovery=rt.nativeWriteRecovery=new NativeWriteRecovery(rt,{now:()=>currentTime,stallMs:50});
  function begin({onEvent,provenance={}}={}){
    const state={threadId:'thread1',turnId:'turn1',onEvent:onEvent||((event)=>events.push(event))};
    const entry=recovery.track(old,{kind:'tool-result',tool:'relay_workspace',callId:'call_13',threadId:'thread1',turnId:'turn1',state,...provenance});
    const w={entry,callback:null};
    old.stdin.write('native test response',{call:entry.writeId}); // no callback needed in helper-only tests
    w.callback=(cause)=>callbackRecords.push(recovery.settledCallback(entry,cause));
    return w;
  }
  return {rt,recovery,old,events,writes,callbackRecords,begin,
    tick:t=>currentTime=t,spawned:()=>spawned};
}

test('normal local callback clears pending and never claims unknown provider delivery',()=>{
  const f=fixture();const w=f.begin();
  assert.equal(f.recovery.status().pendingCount,1);
  assert.equal(f.recovery.settledCallback(w.entry),true);
  assert.equal(f.recovery.status().pendingCount,0);
  assert.equal(f.recovery.status().uncertainCount,0);
});

test('stalled result is observable and must be explicitly retired by token',async()=>{
  const f=fixture();const w=f.begin();f.tick(51);
  const status=f.recovery.status();
  assert.equal(status.stalledCount,1);
  assert.equal(status.oldestWriteId,1);
  assert.equal(status.oldestAgeMs,51);
  assert.throws(()=>f.recovery.assertStartAllowed(),{code:'CODEX_NATIVE_WRITE_STALLED'});
  const result=await f.recovery.recover({expectedWriteId:1,expectedPid:48271});
  assert.equal(result.status,'retired');
  assert.equal(result.reconnectRequired,true);
  assert.equal(result.replayAllowed,false);
  assert.equal(f.rt.child,null);
  assert.equal(f.spawned(),0);
  assert.equal(f.recovery.status().uncertainCount,1);
  const unknown=f.recovery.allUncertain()[0];
  assert.equal(unknown.deliveryStatus,'unknown');
  assert.equal(unknown.providerAcknowledged,false);
  assert.equal(unknown.effectStatus,'reconciliation-required');
  assert.equal('arguments' in unknown,false);
  assert.equal('result' in unknown,false);
  assert.equal(f.events.some(event=>event.type==='native.write.uncertain'),true);
  assert.equal(f.recovery.settledCallback(w.entry),false,'late success cannot retroactively claim provider delivery');
  assert.equal(f.recovery.allUncertain()[0].localWriteCallback,'completed-after-unknown');
  assert.equal(f.recovery.allUncertain().length,1);
});

test('unconfirmed old exit blocks new startup and preserves an explicit retry target',async()=>{
  const f=fixture({exitOnEnd:false});const w=f.begin();f.tick(51);
  await assert.rejects(f.recovery.recover({expectedWriteId:w.entry.writeId}),{code:'CODEX_NATIVE_WRITE_RETIRE_UNCONFIRMED'});
  assert.equal(f.rt.child,f.old);
  assert.equal(f.recovery.status().blocked,true);
  assert.throws(()=>f.recovery.assertStartAllowed(),{code:'CODEX_NATIVE_WRITE_RETIRE_UNCONFIRMED'});
  assert.equal(f.recovery.status().uncertainCount,1);
  f.recovery.settledCallback(w.entry);
  // A callback can arrive, but it does not clear the uncertain-retirement fence.
  assert.equal(f.recovery.status().pendingCount,0);
  assert.equal(f.recovery.status().blocked,true);
  f.rt._retireReplacedProcess=async child=>{child.exitCode=0;child.emit('exit',0);return true;};
  const retry=await f.recovery.recover({expectedWriteId:w.entry.writeId});
  assert.equal(retry.status,'retired');
  assert.equal(f.rt.child,null);
  assert.equal(f.recovery.status().uncertainCount,1);
});

test('recovery before threshold, stale token or stale process identity fails without unknown records',async()=>{
  const f=fixture();const w=f.begin();
  await assert.rejects(f.recovery.recover({expectedWriteId:1}),{code:'CODEX_NATIVE_WRITE_NOT_STALLED'});
  f.tick(51);
  await assert.rejects(f.recovery.recover({expectedWriteId:2}),{code:'CODEX_NATIVE_WRITE_RECOVERY_STALE'});
  await assert.rejects(f.recovery.recover({expectedWriteId:1,expectedPid:9}),{code:'CODEX_NATIVE_WRITE_RECOVERY_STALE'});
  assert.equal(f.recovery.status().uncertainCount,0);
  assert.equal(f.rt.child,f.old);
  assert.equal(f.recovery.settledCallback(w.entry),true);
});

test('canceled preflight waiter does not release the shared underlying preflight',async()=>{
  const f=fixture();f.begin();f.tick(51);
  let release;const inProgress=new Promise(resolve=>release=resolve);
  f.rt.hostOnlyPreflights.set('workspace',{child:f.old,promise:inProgress});
  await assert.rejects(f.recovery.recover({expectedWriteId:1}),{code:'CODEX_NATIVE_WRITE_RECOVERY_BUSY'});
  assert.equal(f.rt.child,f.old);
  f.rt.hostOnlyPreflights.delete('workspace');
  release();
  const completed=await f.recovery.recover({expectedWriteId:1});
  assert.equal(completed.status,'retired');
});

test('in-flight local callback, foreign native turn, and pending protocol request all block retirement',async()=>{
  const f=fixture();f.begin();f.tick(51);
  const state={threadId:'thread1',toolCalls:new Set([Promise.resolve()]),imageJobs:new Map()};
  f.rt.threads.set('thread1',state);
  await assert.rejects(f.recovery.recover({expectedWriteId:1}),{code:'CODEX_NATIVE_WRITE_RECOVERY_BUSY'});
  f.rt.threads.delete('thread1');
  f.rt.threads.set('elsewhere',{threadId:'elsewhere',toolCalls:new Set()});
  await assert.rejects(f.recovery.recover({expectedWriteId:1}),{code:'CODEX_NATIVE_WRITE_RECOVERY_BUSY'});
  f.rt.threads.clear();
  f.rt.pending.set(27,{method:'thread/start'});
  await assert.rejects(f.recovery.recover({expectedWriteId:1}),{code:'CODEX_NATIVE_WRITE_RECOVERY_BUSY'});
  f.rt.pending.clear();
  assert.equal(f.recovery.status().uncertainCount,0);
});

test('write callback error preserves UNKNOWN delivery and requires explicit process retirement',async()=>{
  const f=fixture();const w=f.begin();
  assert.equal(f.recovery.settledCallback(w.entry,new Error('write failed')),false);
  assert.equal(f.recovery.status().uncertainCount,1);
  assert.equal(f.recovery.status().uncertain[0].reason,'write-callback-error');
  assert.equal(f.recovery.status().blocked,true);
  assert.throws(()=>f.recovery.assertStartAllowed(),{code:'CODEX_NATIVE_WRITE_RETIRE_UNCONFIRMED'});
  const result=await f.recovery.recover({expectedWriteId:w.entry.writeId});
  assert.equal(result.status,'retired');
  assert.equal(f.rt.child,null);
});

test('lost connection records unconfirmed result and late success cannot acknowledge the new process',()=>{
  const f=fixture();const w=f.begin();
  f.recovery.connectionLost(f.old);f.rt.child=null;
  assert.equal(f.recovery.status().uncertainCount,1);
  assert.equal(f.recovery.settledCallback(w.entry),false);
  assert.equal(f.recovery.status().uncertain[0].deliveryStatus,'unknown');
});

test('two simultaneous explicit recoveries cannot retire the same process twice',async()=>{
  const f=fixture();f.begin();f.tick(51);
  let release;const exitGate=new Promise(resolve=>release=resolve);
  f.rt._retireReplacedProcess=async child=>{await exitGate;child.exitCode=0;return true;};
  const recovering=f.recovery.recover({expectedWriteId:1});
  assert.equal(f.recovery.status().recovery.state,'retiring');
  await assert.rejects(f.recovery.recover({expectedWriteId:1}),{code:'CODEX_NATIVE_WRITE_RECOVERY_BUSY'});
  assert.throws(()=>f.recovery.assertStartAllowed(),{code:'CODEX_NATIVE_WRITE_RECOVERY_BUSY'});
  assert.throws(()=>f.recovery.track(f.old,{}),{code:'CODEX_NATIVE_WRITE_RECOVERY_BUSY'});
  release();
  const result=await recovering;
  assert.equal(result.status,'retired');
  assert.equal(f.recovery.allUncertain().length,1);
});

test('complete redacted uncertainty ledger is retained beyond bounded status view',()=>{
  const f=fixture();
  for(let i=0;i<70;i++){
    const e=f.recovery.track(f.old,{kind:'tool-result',callId:'c'+i,threadId:'t'});
    f.recovery.rememberUnknown(e,'simulated-connection-loss');
    f.recovery.settledCallback(e,new Error('lost'));
  }
  assert.equal(f.recovery.status().uncertain.length,64);
  assert.equal(f.recovery.status().uncertainCount,70);
  assert.equal(f.recovery.allUncertain().length,70);
});

test('a retirement helper that never settles cannot hold explicit recovery forever',async()=>{
  const f=fixture();f.begin();f.tick(51);
  f.recovery.retireTimeoutMs=12;
  f.rt._retireReplacedProcess=async()=>new Promise(()=>{});
  const before=Date.now();
  await assert.rejects(f.recovery.recover({expectedWriteId:1}),{code:'CODEX_NATIVE_WRITE_RETIRE_UNCONFIRMED'});
  assert.ok(Date.now()-before<700,'recovery must terminate on its own deadline');
  assert.equal(f.recovery.status().blocked,true);
  assert.equal(f.rt.child,f.old);
  assert.equal(f.recovery.status().uncertainCount,1);
});

test('a throwing retirement implementation is treated as unconfirmed exit, not as permission to reconnect',async()=>{
  const f=fixture();f.begin();f.tick(51);
  f.rt._retireReplacedProcess=async()=>{throw new Error('old handle could not be closed');};
  await assert.rejects(f.recovery.recover({expectedWriteId:1}),{code:'CODEX_NATIVE_WRITE_RETIRE_UNCONFIRMED'});
  assert.equal(f.recovery.status().blocked,true);
  assert.equal(f.rt.child,f.old);
  assert.equal(f.recovery.status().uncertainCount,1);
});
