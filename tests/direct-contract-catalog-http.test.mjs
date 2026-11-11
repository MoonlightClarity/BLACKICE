import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createHarnessServer } from '../server.mjs';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';

class Runtime extends EventEmitter {
  agentCalls = 0;
  status() { return { connected: false, authenticated: false, models: [] }; }
  async start() { return this.status(); } async close() {}
  async runAgent() { this.agentCalls++; throw Error('Connector management must not invoke a model.'); }
}
async function fixture(t, { prepare, serverOptions = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-connector-http-')), dataDir = path.join(root, 'data'); await fs.mkdir(dataDir);
  await prepare?.(dataDir);
  const transport = createRemoteTransportFixture(), remoteAccess = new RemoteAccessManager({ dataDir, transport: transport.transport, defaultHttpsPort: 8443 });
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false }); desktop.setEnabled = async () => desktop.status();
  const runtime = new Runtime();
  const app = await createHarnessServer({ port: 0, dataDir, defaultCwd: path.join(root, 'workspace'), runtime, desktop, remoteAccess, autoAttachDesktop: false, ...serverOptions });
  const url = await app.listen(), home = await fetch(url), cookie = home.headers.get('set-cookie').split(';')[0]; await home.text();
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const request = (route, { body, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) => fetch(url + route, { method, headers: { Cookie: cookie, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { root, dataDir, app, runtime, url, request, cookie, transport };
}

const setupRoute = '/api/chatgpt-connector/open-chatgpt';
const pluginUrl = 'https://chatgpt.com/plugins';
const prepareRoute = '/api/chatgpt-connector/prepare';
const checkRoute = '/api/chatgpt-connector/check-connection';
const confirmRoute = '/api/chatgpt-connector/confirm-connection';
const prepareConnection = async f => { const response = await f.request(prepareRoute, { body: { confirmPublic: true } }); assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).setup.ready, true); };
const connectorGrantIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
async function approvedDirectGrants(f) {
  await prepareConnection(f);
  const now = new Date().toISOString(), expiresAt = new Date(Date.now() + 86400000).toISOString();
  const scopes = ['read', 'files:read', 'files:write', 'commands:run', 'browser:read', 'browser:write', 'planning:write'];
  const tokens = ['a', 'b'].map(character => 'blackice_at_' + character.repeat(43));
  // Disposable owner-approved grants exercise real authentication and scope lookup.
  await f.app.chatGPTOAuth.persist(connectorGrantIds.map((id, index) => ({ id, clientId: 'https://chatgpt.com/oauth/client.json', label: 'ChatGPT', resource: f.app.chatGPTConnector.origin + '/mcp/chatgpt', scopes: index ? ['read', 'files:read'] : [...scopes], createdAt: now, expiresAt, lastUsedAt: now, accessTokens: [{ hash: createHash('sha256').update(tokens[index]).digest('hex'), expiresAt }], refresh: { hash: String(index + 1).repeat(64), expiresAt, usedHashes: [] } })));
  return connectorGrantIds.map((id, index) => ({ client: f.app.chatGPTOAuth.getClient(id), token: tokens[index] }));
}
async function connectorResponse(f, grant, name, args) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 'fixture-tool', method: 'tools/call', params: { name, arguments: args } });
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.app.remoteAccess.gateway.port, path: '/mcp/chatgpt', method: 'POST', headers: { Host: new URL(f.app.chatGPTConnector.origin).host, Authorization: 'Bearer ' + grant.token, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    });
    req.once('error', reject); req.end(payload);
  });
  return response;
}
async function connectorTool(f, grant, name, args) {
  const response = await connectorResponse(f, grant, name, args);
  assert.equal(response.status, 200); assert.equal(response.body.error, undefined);
  return response.body.result;
}
async function settledConnectorJob(f, grant, jobId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await connectorTool(f, grant, 'blackice_get_job', { jobId });
    assert.equal(result.isError, false); const job = result.structuredContent;
    if (job.settled) return job;
    assert.notEqual(job.status, 'awaiting_input', 'authorized work must not request local approval');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The disposable direct action did not settle.');
}


import {BrowserWorkspace} from '../lib/browser.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const target='https://fixture.invalid/apply',tabId='relay:fixture',documentId='fixture:1',origin='origin:https://fixture.invalid';
function taskContract(){return {contractVersion:2,goal:'Verify one fixture outcome',criteria:[{id:'receipt',kind:'external-confirmation',description:'One host-confirmed outcome',targetCount:1,receiptBinding:{version:1,format:'dom',resourceKey:origin,record:'#receipt',status:'data-status',confirmedValues:['confirmed'],absentValues:['absent'],outcomeId:'data-outcome',destination:'data-form-action',history:false,prior:{field:'data-prior',values:['true']},identity:[{field:'data-subject',formField:'subject'},{field:'data-role',formField:'role'}]}}],workItems:[{id:'apply',title:'Apply',objective:'Submit and verify fixture only',owner:'main',resourceKeys:[origin],effects:['observe','interact','commit'],dependsOn:[],criterionIds:['receipt']}],instructions:[]};}
function mockBrowser(){
 let commits=0,reads=0;
 const fields=[['subject','fixture-person'],['role','fixture-role']];
 const driver={status:()=>({available:true,contained:true,containedAvailable:true,activeTab:tabId,tabs:[{browser:'relay',tabId,url:target,documentId,purpose:'user'}]}),
  observeOperation:async(args,options={})=>({current:(!options.expectedDocumentId||options.expectedDocumentId===documentId)&&(!options.expectedUrl||options.expectedUrl===target),tabId,documentId,url:target,frameId:'frame',loaderId:'loader',
   ...(args.action==='click'?{control:{ref:args.ref,kind:'form-submit',form:{id:'form',documentId,action:target,method:'POST',enctype:'application/x-www-form-urlencoded',target:'_self',payloadDigest:digest(fields),attachmentDigests:[],identityDigests:fields.map(([name,value])=>({name,digest:digest(value)}))}}}:{}),receipts:[]}),
  perform:async args=>{if(args.action!=='read'){commits++;throw Error('This fixture must never dispatch a submission or mutation.');}reads++;return {tabId,documentId,url:target,text:'Unsubmitted fixture application',frames:[]};}};
 return {browser:new BrowserWorkspace({driver}),counts:()=>({commits,reads})};
}
async function mcp(f,grant,method,params={}){
 const payload=JSON.stringify({jsonrpc:'2.0',id:'catalog-fixture',method,params});
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:f.app.remoteAccess.gateway.port,path:'/mcp/chatgpt',method:'POST',headers:{Host:new URL(f.app.chatGPTConnector.origin).host,...(grant?{Authorization:'Bearer '+grant.token}:{}),Accept:'application/json, text/event-stream','Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{
   let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.once('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});
  req.once('error',reject);req.end(payload);
 });
}
async function action(f,grant,name,args){
 const reply=await connectorTool(f,grant,name,args);assert.equal(reply.isError,false,JSON.stringify(reply));
 const saved=await settledConnectorJob(f,grant,reply.structuredContent.jobId);
 assert.equal(saved.status,'succeeded',JSON.stringify(saved));
 return JSON.parse(saved.result.text.text);
}
test('authenticated served MCP catalog preserves complete contract/context schemas and non-submitting binding roundtrip',async t=>{
 const mocked=mockBrowser(),f=await fixture(t,{serverOptions:{browser:mocked.browser}}),[grant,limited]=await approvedDirectGrants(f);
 assert.equal((await mcp(f,null,'tools/list')).status,401);
 const served=await mcp(f,grant,'tools/list');assert.equal(served.status,200);assert.equal(served.body.error,undefined);
 const catalog=served.body.result.tools,byName=new Map(catalog.map(tool=>[tool.name,tool]));
 const contractTool=byName.get('blackice_task_contract'),contextTool=byName.get('blackice_task_context');
 assert.ok(contractTool);assert.ok(contextTool);
 const branch=(tool,name)=>tool.inputSchema.oneOf.find(item=>item.properties.action.const===name);
 for(const name of ['create','bind_plan','bind','reconcile','read','measure'])assert.ok(branch(contractTool,name),name);
 const create=branch(contractTool,'create');
 assert.equal(create.properties.contract.type,'object');
 assert.equal(create.properties.contract.properties.workItems.type,'array');
 assert.equal(create.properties.contract.properties.workItems.items.type,'object');
 assert.ok(create.properties.contract.properties.workItems.items.properties.criterionIds);
 assert.ok(branch(contractTool,'bind_plan').properties.expectedSourceRevision);
 assert.equal(branch(contractTool,'bind').properties.identityFields.items.type,'string');
 assert.deepEqual(branch(contextTool,'issue').properties.adapters.items.enum,['relay_browser','relay_workspace']);
 assert.ok(byName.get('blackice_browser_action').inputSchema.properties.taskContext);
 assert.ok(byName.get('blackice_browser_read').inputSchema.properties.taskContext);
 assert.equal(create.properties.contract.properties.criteria.items.type,'object');
 assert.ok(create.properties.contract.properties.criteria.items.properties.receiptBinding);
 // The gateway's existing authenticated grant policy is unchanged by this regression.
 const createArgs={requestId:'fixture-create',action:'create',taskId:'fixture-direct',contract:taskContract()};
 const created=await action(f,grant,'blackice_task_contract',createArgs);assert.equal(created.result.taskId,'fixture-direct');
 const bindArgs={requestId:'fixture-bind',action:'bind',taskId:'fixture-direct',tabId,workItemId:'apply',criterionId:'receipt',identityFields:['subject','role'],ref:'submit',expectedUrl:target,expectedDocumentId:documentId};
 const bound=await action(f,grant,'blackice_task_contract',bindArgs);assert.equal(bound.result.workItemId,'apply');assert.equal(mocked.counts().commits,0);
 const read=await action(f,grant,'blackice_task_contract',{requestId:'fixture-read',action:'read',taskId:'fixture-direct'});
 const issued=await action(f,grant,'blackice_task_context',{requestId:'fixture-issue',action:'issue',taskId:'fixture-direct',expectedRevision:read.result.revision,workItemId:'apply',criterionId:'receipt',bindingId:bound.result.bindingId,adapters:['relay_browser']});
 const handle=issued.result.taskContext;assert.match(handle,/^taskctx_/);
 const context=await action(f,grant,'blackice_task_context',{requestId:'fixture-context-read',action:'read',taskContext:handle});
 assert.equal(context.result.valid,true);
 await action(f,grant,'blackice_browser_read',{requestId:'fixture-page-read',action:'read',tabId,taskContext:handle});
 assert.deepEqual(mocked.counts(),{commits:0,reads:1});assert.equal(f.runtime.agentCalls,0);
 // Canonical source fixture: the transport must bind the exact host-owned source, not a copied contract.
 let canonical=await f.app.tasks.ensure({taskId:'fixture-canonical',runId:'fixture-run',cwd:f.root,schemaVersion:14});
 canonical=await f.app.tasks.setContract('fixture-canonical',taskContract(),{expectedRevision:canonical.revision,schemaVersion:14});
 const linked=await action(f,grant,'blackice_task_contract',{requestId:'fixture-bind-plan',action:'bind_plan',sourceTaskId:'fixture-canonical',expectedSourceRevision:canonical.revision});
 assert.equal(linked.result.source.taskId,'fixture-canonical');assert.equal(linked.result.source.revision,canonical.revision);
 const canonicalBound=await action(f,grant,'blackice_task_contract',{...bindArgs,requestId:'fixture-canonical-bind',taskId:linked.result.taskId});
 assert.equal(canonicalBound.result.workItemId,'apply');
 const visible=await f.app.directExecution.planSource.projectState(await f.app.tasks.get('fixture-canonical'),{client:grant.client});
 assert.ok(visible.directExecution);
 assert.equal(visible.directExecution.source.taskId,'fixture-canonical');
 assert.equal((await f.app.tasks.get('fixture-canonical')).revision,canonical.revision);
 assert.deepEqual(mocked.counts(),{commits:0,reads:1});assert.equal(f.runtime.agentCalls,0);
});
