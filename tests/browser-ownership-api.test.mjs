import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectExecutionAPI, DIRECT_EXECUTION_SCOPES } from '../lib/direct-execution-api.mjs';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { ownershipChange } from '../lib/browser-ownership.mjs';
test('direct ownership actions durably replay same request without retransfer', async t => {
  const dir = await mkdtemp(path.join(tmpdir(),'blackice-ownership-api-'));
  const tab = {tabId:'one',url:'https://example.com/',documentId:'one:1',folderId:'user',owner:null};
  let count=0;
  const driver = {status:()=>({contained:true,tabs:[{...tab}],folders:[{id:'user',kind:'user'}]}), async perform(args,{owner}) { count++; const change=ownershipChange(args,this.status(),owner); tab.owner=change.owner; return {ownershipReceipt:{tabId:tab.tabId,owner:tab.owner},tabs:this.status().tabs}; }};
  const browser = new BrowserWorkspace({driver});
  const api = new DirectExecutionAPI({dataDir:dir,allowedRoot:dir,browser}); await api.init();
  t.after(async()=>{await api.close();await browser.close();await rm(dir,{recursive:true,force:true});});
  const client={id:'ownership-grant',kind:'chatgpt',scopes:[...DIRECT_EXECUTION_SCOPES]};
  const args={requestId:'take-exact',action:'take_ownership',tabId:'one',expectedUrl:tab.url,expectedDocumentId:tab.documentId};
  const admitted=await api.call('blackice_browser_action',args,client);
  let result; for(let n=0;n<100;n++){result=await api.getJob(admitted.jobId,client);if(result.settled)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(result.status,'succeeded',JSON.stringify(result)); assert.equal(count,1); assert.ok(tab.owner);
  const transfer=await api.call('blackice_browser_action',{...args,requestId:'return-exact',action:'transfer_ownership',destination:'user'},client);
  for(let n=0;n<100;n++){result=await api.getJob(transfer.jobId,client);if(result.settled)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(result.status,'succeeded',JSON.stringify(result)); assert.equal(count,2); assert.equal(tab.owner,null);
  const repeated=await api.call('blackice_browser_action',args,client);
  assert.equal(repeated.jobId,admitted.jobId); assert.equal(repeated.existing,true);assert.equal(count,2);assert.equal(tab.owner,null);
  await assert.rejects(api.call('blackice_browser_action',{...args,expectedUrl:'https://different.example/'},client),{code:'DIRECT_REQUEST_CONFLICT'});
});
