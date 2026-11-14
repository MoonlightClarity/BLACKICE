import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

test('local session cookie gates the exact goal effect receipt and resolution',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'goal-effects-http-'));const cwd=path.join(dir,'workspace');await mkdir(cwd);
  class Runtime extends EventEmitter {status(){return {connected:true,authenticated:true,models:[]};}async start(){return this.status();}async runAgent(){throw Error('No model turn is expected.');}async close(){}}
  const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:path.join(dir,'data'),defaultCwd:cwd,remoteAccess:false});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const url=await app.listen(),root='fixture-root';app.goals.resolve=async()=>root;
  const row={id:'receipt',signature:'a'.repeat(64),at:'2026-11-14T00:00:00Z',kind:'uncertain_external_effect',tool:'relay_browser',action:'click'};
  await app.conversations.changeState(root,{goalUnresolvedEffects:[row]});
  let welcome;try{welcome=await fetch(url);}catch(error){throw Object.assign(new Error('Disposable localhost fetch failed: '+(error.cause?.code||error.message)),{cause:error});}
  const cookie=welcome.headers.get('set-cookie').split(';')[0],route=url+'/api/conversations/'+root+'/goal-effects';
  assert.equal((await fetch(route)).status,401);
  const read=await fetch(route,{headers:{cookie}});assert.equal(read.status,200);assert.equal((await read.json()).receipts[0].id,row.id);
  const body={receiptId:row.id,signature:row.signature,observedAt:row.at,expectedResolutionCount:0,outcome:'unknown',evidence:'No receipt found during fixture inspection.'};
  const send=headers=>fetch(route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await send({})).status,401);assert.equal((await send({cookie,'x-blackice-remote':'1'})).status,403);
  const resolved=await send({cookie});assert.equal(resolved.status,200);const result=await resolved.json();assert.equal(result.receipt.resolution.outcome,'unknown');assert.equal(result.replayed,false);
  assert.equal((await send({cookie})).status,409);
});
