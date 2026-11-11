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

test('fresh task reads expose response-only guidance without catalog refresh or changing legacy receipts, contract bytes or explicit gates', async t => {
  const mocked = mockBrowser(), f = await fixture(t, { serverOptions: { browser: mocked.browser } }), [grant] = await approvedDirectGrants(f);
  const catalogBefore = JSON.stringify((await mcp(f, grant, 'tools/list')).body.result.tools);
  const intent = taskContract();
  intent.instructions = [
    { id: 'explicit-limit', text: 'The user requires a total cost no greater than $25.', handling: 'preserve' },
    { id: 'caller-assumption', text: 'Reject every opportunity whose qualification list includes an undocumented preference.', handling: 'audit' },
  ];
  const created = await action(f, grant, 'blackice_task_contract', { requestId: 'guidance-create', action: 'create', taskId: 'guidance-existing', contract: intent });
  assert.equal(created.contractInterpretation.provenance.contractSource, 'authenticated-caller-supplied');
  const outcomes = f.app.directExecution.taskRuntime.outcomes;
  const storedBefore = await fs.readFile(outcomes.file);
  const extension = f.app.directExecution.extensions.get('blackice_task_contract'), execute = extension.execute;
  // Emulate a saved pre-upgrade result. Its durable bytes must not be retrofitted.
  extension.execute = async (...args) => {
    const result = await execute(...args);
    const value = JSON.parse(result.contentItems[0].text);
    delete value.contractInterpretation;
    return { ...result, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
  };
  const legacyArgs = { requestId: 'guidance-legacy-read', action: 'read', taskId: 'guidance-existing' };
  let legacyJobId, legacy;
  try {
    const reply = await connectorTool(f, grant, 'blackice_task_contract', legacyArgs);
    legacyJobId = reply.structuredContent.jobId;
    legacy = await settledConnectorJob(f, grant, legacyJobId);
    assert.equal(JSON.parse(legacy.result.text.text).contractInterpretation, undefined);
  } finally { extension.execute = execute; }
  // Existing tool knowledge suffices: no tools/list call occurs before this fresh read.
  const fresh = await action(f, grant, 'blackice_task_contract', { ...legacyArgs, requestId: 'guidance-fresh-read' });
  assert.equal(fresh.contractInterpretation.provenance.userAuthorshipVerified, false);
  assert.equal(fresh.contractInterpretation.provenance.semanticConflictsChecked, false);
  assert.deepEqual(fresh.result.contract.instructions, intent.instructions);
  assert.deepEqual(await fs.readFile(outcomes.file), storedBefore);
  const replay = await connectorTool(f, grant, 'blackice_task_contract', legacyArgs);
  assert.equal(replay.structuredContent.jobId, legacyJobId);
  assert.equal((await settledConnectorJob(f, grant, legacyJobId)).result.text.text, legacy.result.text.text);
  assert.deepEqual(await fs.readFile(outcomes.file), storedBefore);
  const revised = structuredClone(intent);
  revised.workItems[0].objective = 'Use useful bounded judgment within unchanged user limits';
  const updated = await action(f, grant, 'blackice_task_contract', { requestId: 'guidance-update', action: 'update', taskId: 'guidance-existing', expectedRevision: fresh.result.revision, contract: revised });
  assert.ok(updated.contractInterpretation);
  assert.deepEqual(updated.result.contract.instructions, intent.instructions);
  const storedUpdated = await fs.readFile(outcomes.file);
  const readUpdated = await action(f, grant, 'blackice_task_contract', { ...legacyArgs, requestId: 'guidance-updated-read' });
  assert.deepEqual(readUpdated.result, updated.result);
  assert.deepEqual(await fs.readFile(outcomes.file), storedUpdated);
  assert.equal(JSON.stringify((await mcp(f, grant, 'tools/list')).body.result.tools), catalogBefore);
  assert.deepEqual(mocked.counts(), { commits: 0, reads: 0 });
  assert.equal(f.runtime.agentCalls, 0);
});

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

import {TaskStateStore} from '../lib/task-state.mjs';
test('authenticated canonical create_contract is atomic, visible to UI, and bindable without a provider or submission',async t=>{
 const mocked=mockBrowser(),f=await fixture(t,{serverOptions:{browser:mocked.browser}}),[grant]=await approvedDirectGrants(f);
 const listed=(await mcp(f,grant,'tools/list')).body.result.tools;
 const editSchema=listed.find(tool=>tool.name==='blackice_edit_plan').inputSchema;
 const createSchema=editSchema.properties.operations.items.oneOf.find(item=>item.properties.type.const==='create_contract');
 assert.equal(createSchema.properties.contract.properties.workItems.items.type,'object');
 const request={taskId:'created-canonical',expectedRevision:0,operations:[{type:'create_contract',contract:taskContract()}]};
 const result=await connectorTool(f,grant,'blackice_edit_plan',request);
 assert.equal(result.isError,false,JSON.stringify(result));
 const state=result.structuredContent;assert.equal(state.revision,1);assert.equal(state.taskSchemaVersion,14);
 assert.equal(state.contract.planEpoch,1);assert.equal(state.standalonePlan.kind,'standalone');assert.equal(state.provenance.actor.id,grant.client.id);
 assert.equal((await f.app.tasks.load(state.taskId)).history.length,1);
 const detail=await connectorTool(f,grant,'blackice_get_plan',{taskId:state.taskId});
 assert.equal(detail.isError,false);assert.deepEqual(detail.structuredContent.contract,state.contract);
 const listing=await connectorTool(f,grant,'blackice_list_plans',{taskId:state.taskId});
 assert.equal(listing.isError,false);assert.equal(listing.structuredContent.plans[0].documentKind,'standalone');
 const ui=await f.request('/api/planning?taskId='+state.taskId);
 assert.equal(ui.status,200);assert.equal((await ui.json()).plans[0].taskId,state.taskId);
 const linked=await action(f,grant,'blackice_task_contract',{requestId:'created-link',action:'bind_plan',sourceTaskId:state.taskId,expectedSourceRevision:1});
 await action(f,grant,'blackice_task_contract',{requestId:'created-bind',action:'bind',taskId:linked.result.taskId,tabId,workItemId:'apply',criterionId:'receipt',identityFields:['subject','role'],ref:'submit',expectedUrl:target,expectedDocumentId:documentId});
 const projected=await connectorTool(f,grant,'blackice_get_plan',{taskId:state.taskId});
 assert.equal(projected.structuredContent.directExecution.sourceStatus,'current');
 assert.equal(projected.structuredContent.directExecution.bindings.length,1);
 const repeated=await connectorTool(f,grant,'blackice_edit_plan',request);assert.equal(repeated.isError,true);
 assert.equal((await f.app.tasks.get(state.taskId)).revision,1);
 for(const operations of [
  [{type:'create_contract',contract:taskContract(),steps:[]}],
  [{type:'create_contract',contract:{...taskContract(),planEpoch:99}}],
  [{type:'create_contract',contract:taskContract()},{type:'create',goal:'mixed',steps:[{id:'x',title:'x'}]}],
  [{type:'create_contract',contract:{...taskContract(),workItems:[]}}],
 ]){
  const invalid=await connectorTool(f,grant,'blackice_edit_plan',{taskId:'invalid-canonical',expectedRevision:0,operations});
  assert.equal(invalid.isError,true,JSON.stringify(invalid));
 }
 assert.equal(await f.app.tasks.load('invalid-canonical',true),null);
 assert.equal(f.runtime.agentCalls,0);assert.deepEqual(mocked.counts(),{commits:0,reads:0});
 assert.equal((await f.app.tasks.load(state.taskId)).history.length,1);
});
test('two stores enforce canonical creation CAS, reopen provenance, and reject existing legacy state without migration',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'canonical-create-cas-'));
 const a=await new TaskStateStore({dataDir:root}).init(),b=await new TaskStateStore({dataDir:root}).init();
 t.after(async()=>{await a.close();await b.close();await fs.rm(root,{recursive:true,force:true});});
 const actor={type:'external-agent',id:'test-owner',name:'Test owner'},options={expectedRevision:0,cwd:root,source:'external-agent',actor};
 const userAgency={version:1,audience:'internal',userBenefit:'Prepare the requested measurable plan.',representation:{actualQuestion:'Create fixture plan',requiredFacts:[],relevantClaims:[],privateFindings:[],userReport:[]},action:'proceed',decisionRequired:false,decisionReason:'Routine authorized plan creation without execution.',decisions:[],chosenDecisionId:null};
 const outcomes=await Promise.allSettled([a.createCanonicalPlanningDocument('atomic',{contract:taskContract(),userAgency},options),b.createCanonicalPlanningDocument('atomic',{contract:taskContract(),userAgency},options)]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'TASK_STATE_CONFLICT');
 const saved=await b.get('atomic');assert.equal(saved.revision,1);assert.deepEqual(saved.provenance.actor,actor);assert.deepEqual(saved.userAgency,userAgency);
 assert.equal((await b.load('atomic')).history.length,1);assert.equal(saved.contractRuntime.operations.length,0);
 await a.createPlanningDocument('legacy',{goal:'Retain legacy',steps:[{id:'old',title:'Old work',doneWhen:'Observe its result'}]},options);
 const old=await a.get('legacy');
 await assert.rejects(b.createCanonicalPlanningDocument('legacy',{contract:taskContract()},options),{code:'TASK_STATE_CONFLICT'});
 assert.deepEqual(await a.get('legacy'),old);
 for(const value of [{contract:taskContract(),steps:[]},{contract:{...taskContract(),planEpoch:2}},{contract:{...taskContract(),workItems:[]}}])
  await assert.rejects(async()=>a.createCanonicalPlanningDocument('invalid',value,options));
 assert.equal(await a.load('invalid',true),null);
 await assert.rejects(async()=>a.createCanonicalPlanningDocument('wrong-revision',{contract:taskContract()},{...options,expectedRevision:1}));
 await assert.rejects(async()=>a.createCanonicalPlanningDocument('wrong-actor',{contract:taskContract()},{...options,actor:{type:'human-client',id:'person'}}));
 await a.close();await b.close();
 const reopened=await new TaskStateStore({dataDir:root}).init();
 try{const persisted=await reopened.get('atomic');assert.deepEqual(persisted.userAgency,userAgency);assert.deepEqual(persisted.provenance.actor,actor);assert.equal(persisted.revision,1);assert.equal(persisted.contract.planEpoch,1);}
 finally{await reopened.close();}
});
