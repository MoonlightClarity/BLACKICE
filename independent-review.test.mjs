import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {CodexRuntime} from './lib/codex.mjs';

test('runtime change between start resolution and turn admission preserves the original process', async () => {
 let changed=false,replaced=false;
 const rt=new CodexRuntime({nativeModelMetadata:false,resolveCommand:()=>changed?'new':'old',assessRuntime:()=>changed?{state:'moved',command:'new'}:{state:'current'}});
 rt.command='old'; rt.info.connected=true; rt.info.authenticated=true;rt.info.defaultModel='model';rt.info.models=[{id:'model',model:'model'}];rt.info.connection.phase='ready';
 const old=new EventEmitter();old.exitCode=null;old.signalCode=null;old.stdin={end(){old.exitCode=0;old.emit('exit',0)}};old.kill=()=>{};rt.child=old;
 rt._startWithRecovery=async()=>{replaced=true;rt.info.connected=true;rt.info.authenticated=true;return rt.status();};
 const originalStart=rt.start.bind(rt);let once=false;
 rt.start=async(...args)=>{const result=await originalStart(...args);if(!once){once=true;changed=true;try{await originalStart();}catch{}}return result;};
 rt._sessionConfig=async()=>{throw new Error('test stop');};
 await rt.runAgent({cwd:path.resolve('.'),prompt:'test',model:'model'}).catch(()=>{});
 assert.equal(replaced,false,'another caller must not retire the runtime in the start-to-admission gap');
});

test('a turn in pre-thread setup retains its process during an update', async () => {
  let changed=false, entered; const setupEntered=new Promise(r=>entered=r);
  let release; const setupGate=new Promise(r=>release=r);
  const rt=new CodexRuntime({nativeModelMetadata:false,resolveCommand:()=>changed?'new':'old',assessRuntime:()=>changed?{state:'moved',command:'new'}:{state:'current'}});
  rt.command='old'; rt.info.connected=true; rt.info.authenticated=true; rt.info.defaultModel='model'; rt.info.models=[{id:'model',model:'model'}];
  const old=new EventEmitter(); old.exitCode=null; old.signalCode=null; old.stdin={end(){old.exitCode=0;old.emit('exit',0)}};old.kill=()=>{};rt.child=old;
  rt._sessionConfig=async()=>{entered(); await setupGate; throw new Error('test stop');};
  rt._startWithRecovery=async()=>({});
  const turn=rt.runAgent({cwd:path.resolve('.'),prompt:'test',model:'model'}).catch(e=>e);
  await setupEntered; changed=true;
  let result; try {await rt.start(); result='replaced';} catch(e){result=e.code;}
  release(); await turn;
  assert.equal(result,'CODEX_RUNTIME_CHANGED_BUSY','must not close the process during a turn setup');
});

test('a missing replacement does not leave connection phase starting', async () => {
  const rt=new CodexRuntime({nativeModelMetadata:false,resolveCommand:()=> 'codex',assessRuntime:()=>({state:'missing'})});
  await assert.rejects(rt.start(),{code:'CODEX_RUNTIME_MISSING'});
  assert.notEqual(rt.info.connection.phase,'starting');
});

test('reusing a healthy connection preserves its ready phase', async () => {
  const rt=new CodexRuntime({nativeModelMetadata:false,resolveCommand:()=> 'codex',assessRuntime:()=>({state:'current'})});
  rt.info.connected=true;rt.info.connection.phase='ready';
  await rt.start();
  assert.equal(rt.info.connection.phase,'ready');
});

test('replacement is not started before old process exit is observed', async () => {
  const rt=new CodexRuntime({nativeModelMetadata:false,resolveCommand:()=> 'new',assessRuntime:()=>({state:'moved',command:'new'})});
  rt.command='old'; rt.info.connected=true;
  const old=new EventEmitter();old.exitCode=null;old.signalCode=null;old.stdin={end(){}};old.kill=()=>false;rt.child=old;
  let started=false;rt._startWithRecovery=async()=>{started=true;return {};};
  await assert.rejects(rt.start(),{code:'CODEX_RUNTIME_RETIRE_UNCONFIRMED'});
  assert.equal(started,false,'failed termination must not be treated as observed exit');
});

test('a turn reports the real process-retirement blocker', async () => {
 const rt=new CodexRuntime({nativeModelMetadata:false,resolveCommand:()=> 'new',assessRuntime:()=>({state:'moved',command:'new'})});
 rt.command='old';rt.info.connected=true;rt.info.authenticated=true;
 const old=new EventEmitter();old.exitCode=null;old.signalCode=null;old.stdin={end(){}};old.kill=()=>false;rt.child=old;
 await assert.rejects(rt.runAgent({cwd:path.resolve('.'),prompt:'test',model:'model'}),{code:'CODEX_RUNTIME_RETIRE_UNCONFIRMED'});
});

test('a replacement that fails to spawn can be retried without replaying a turn', async () => {
  const unavailable=path.join(path.resolve('.'),'does-not-exist-codex.exe');
  const rt=new CodexRuntime({nativeModelMetadata:false,resolveCommand:()=>unavailable,
    assessRuntime:({current})=>current===unavailable?{state:'current'}:{state:'moved',command:unavailable}});
  rt.command=path.resolve('previous-codex.exe');
  await assert.rejects(rt.start(), {code:'ENOENT'});
  assert.equal(rt.child,null);
  assert.equal(rt.threads.size,0);
  let retryCount=0;rt._startWithRecovery=async()=>{retryCount++;return {connected:true};};
  assert.equal((await rt.start()).connected,true);
  assert.equal(retryCount,1);
});
