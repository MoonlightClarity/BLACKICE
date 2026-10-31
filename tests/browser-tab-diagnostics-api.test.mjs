import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { connectorBrowserOwner } from '../lib/connector-browser-owner.mjs';
import { DirectExecutionAPI, validDirectArguments } from '../lib/direct-execution-api.mjs';
test('direct diagnostics stay read-scoped, durable, idempotent and ownership-guarded even with a pending dialog', async t => {
 const directory=await mkdtemp(path.join(tmpdir(),'blackice-debug-api-'));
 const client={id:'debug-client',label:'Debug fixture',kind:'chatgpt',scopes:['read','browser:read','browser:write']};
 const owner=connectorBrowserOwner(client.id), calls=[]; let inspections=0;
 const driver={status:()=>({available:true,contained:true,tabs:[{tabId:'owned',contained:true,owner,url:'https://example.test/'},{tabId:'other',contained:true,owner:{taskId:'other',runId:'other',nodeId:'other'},url:'https://other.test/'}]}),
  async perform(args){calls.push(args); return {tabId:args.tabId,url:'https://example.test/',documentId:'owned:1',debug:{events:[{sequence:1,kind:'console',message:'TypeError fixture'}],cursor:1}};},async close(){}};
 const browser=new BrowserWorkspace({driver}),api=new DirectExecutionAPI({dataDir:directory,allowedRoot:directory,browser,inspectBrowserInteraction:async()=>{inspections++;return {kind:'javascript_dialog',status:'pending'};}});
 await api.init();t.after(async()=>{await api.close();await browser.close();await rm(directory,{recursive:true,force:true});});
 const read=api.tools().find(x=>x.name==='blackice_browser_read'), action=api.tools().find(x=>x.name==='blackice_browser_action');
 const args={requestId:'read-debug-fixture',action:'diagnostics',tabId:'owned',after:0,limit:12};
 assert.equal(validDirectArguments(args,read.inputSchema),true);
 assert.equal(validDirectArguments({...args,limit:257},read.inputSchema),false);
 assert.ok(action.inputSchema.properties.action.enum.includes('stop'));assert.ok(action.inputSchema.properties.action.enum.includes('debug_reset'));
 await assert.rejects(api.call('blackice_browser_read',{...args,requestId:'foreign-debug-fixture',tabId:'other'},client),{code:'BROWSER_TAB_OWNERSHIP'});
 await assert.rejects(api.call('blackice_browser_action',{requestId:'missing-stop-guard',action:'stop',tabId:'owned'},client),{code:'DIRECT_REQUEST_INVALID'});
 const job=await api.call('blackice_browser_read',args,client);let done;
 for(let i=0;i<100;i++){done=await api.getJob(job.jobId,client);if(done.settled)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(done.status,'succeeded');assert.equal(inspections,0);assert.equal(calls.length,1);
 assert.deepEqual(done.effects,{possible:false,confirmed:false});assert.match(done.result.text.text,/TypeError fixture/);
 assert.match(await readFile(path.join(directory,'direct-execution-jobs',job.jobId+'.json'),'utf8'),/TypeError fixture/);
 assert.equal((await api.call('blackice_browser_read',args,client)).existing,true);assert.equal(calls.length,1);
});
