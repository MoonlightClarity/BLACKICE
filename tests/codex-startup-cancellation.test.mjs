import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexRuntime } from '../lib/codex.mjs';

test('close during an unanswered initialization settles startup without retry or model work', async t => {
  let spawns=0, initialized;
  const seenInitialization=new Promise(resolve=>initialized=resolve), requests=[];
  const runtime=new CodexRuntime({command:'fixture',nativeModelMetadata:false,requestTimeoutMs:5000,
    spawnImpl(){
      spawns++;
      const child=new EventEmitter();
      child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('exit',0,null));};
      child.stdin.on('finish',()=>queueMicrotask(()=>child.emit('exit',0,null)));
      child.stdin.on('data',data=>{
        for(const line of String(data).trim().split('\n')){
          const row=JSON.parse(line);requests.push(row.method);
          if(row.method==='initialize')initialized();
        }
      });
      return child;
    }});
  t.after(()=>runtime.close());
  const first=runtime.start(),second=runtime.start();
  const results=Promise.allSettled([first,second]);
  await seenInitialization;
  await runtime.close();
  const settled=await results;
  assert.ok(settled.every(value=>value.status==='rejected'&&value.reason.code==='CODEX_CLOSED'));
  assert.equal(spawns,1);
  assert.deepEqual(requests,['initialize']);
  assert.equal(runtime.startRecoveryController,null);
  assert.equal(runtime.startPromise,null);
  assert.equal(runtime.pending.size,0);
});
