import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexRuntime} from './lib/codex.mjs';

function oldProcess({onEnd} = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = {end() {onEnd?.(child);}};
  child.kill = () => false;
  return child;
}

test('unconfirmed old-process exit returns non-ready status without spawning replacement or changing command', async () => {
  const rt = new CodexRuntime({nativeModelMetadata:false, resolveCommand:()=> 'new-codex',
    assessRuntime:()=>({state:'moved',command:'new-codex'})});
  const old=oldProcess();
  rt.child=old;rt.command='old-codex';rt.info.connected=true;rt.info.authenticated=true;
  let replacements=0;
  rt._startWithRecovery=async()=>{replacements++;return {connected:true};};
  await assert.rejects(rt.start(),{code:'CODEX_RUNTIME_RETIRE_UNCONFIRMED'});
  const result=rt.status();
  assert.equal(replacements,0);
  assert.equal(result.connected,false);
  assert.equal(result.authenticated,false);
  assert.equal(result.connection.phase,'failed');
  assert.equal(rt.child,old,'keep the old handle until exit is observed');
  assert.equal(rt.command,'old-codex','do not switch command until retirement');
});

test('observed exit retires old process before starting replacement', async () => {
  const rt = new CodexRuntime({nativeModelMetadata:false, resolveCommand:()=> 'new-codex',
    assessRuntime:()=>({state:'moved',command:'new-codex'})});
  const old=oldProcess({onEnd:child=>queueMicrotask(()=>{child.exitCode=0;child.emit('exit',0,null);})});
  rt.child=old;rt.command='old-codex';rt.info.connected=true;rt.info.authenticated=true;
  let replacements=0;
  rt._startWithRecovery=async()=>{
    assert.equal(old.exitCode,0);
    assert.equal(rt.child,null);
    replacements++;
    rt.info.connected=true;
    rt.info.authenticated=true;
    rt._connectionPhase('ready');
    return rt.status();
  };
  const result=await rt.start();
  assert.equal(result.connected,true);
  assert.equal(result.connection.phase,'ready');
  assert.equal(rt.command,'new-codex');
  assert.equal(replacements,1);
});

test('failed cold startup is not left in the starting phase and remains retryable', async () => {
  const rt=new CodexRuntime({nativeModelMetadata:false,resolveCommand:()=> 'candidate',
    assessRuntime:()=>({state:'current'})});
  let attempts=0;
  rt._startWithRecovery=async()=>{attempts++;if(attempts===1)throw new Error('start failed');rt.info.connected=true;rt._connectionPhase('ready');return rt.status();};
  await assert.rejects(rt.start(),/start failed/);
  assert.equal(rt.info.connection.phase,'failed');
  assert.equal((await rt.start()).connection.phase,'ready');
  assert.equal(attempts,2);
});
