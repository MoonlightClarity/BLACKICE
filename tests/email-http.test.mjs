import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {AgentEmailStore} from '../lib/agent-email.mjs';
import {recordFixturePlan} from './fixture-task-plan.mjs';

class Runtime extends EventEmitter {
  status(){return {connected:false,authenticated:false,models:[]};}
  async start(){return this.status();} async close(){}
  async runAgent(){throw Error('Email settings must not call a model.');}
}
class Desktop extends EventEmitter {status(){return {available:false,enabled:false};} async setEnabled(){return this.status();}}
async function fixture(t,{prepare,runtime,emailClient,defaultEmailStore=false}={}){
  const root=await mkdtemp(path.join(tmpdir(),'blackice-email-http-')),dataDir=path.join(root,'data');await mkdir(dataDir);
  await prepare?.({root,dataDir});
  let cliCalls=0;
  const email=defaultEmailStore?undefined:await new AgentEmailStore({dataDir,runner:async()=>{cliCalls++;throw Error('Unexpected CLI request in local-draft fixture.');}}).init();
  const app=await createHarnessServer({port:0,dataDir,defaultCwd:path.join(root,'workspace'),runtime:runtime||new Runtime(),desktop:new Desktop(),email,emailClient,autoAttachDesktop:false});
  await app.learning.updateSettings({mode:'manual'});
  const url=await app.listen(),page=await fetch(url),cookie=page.headers.get('set-cookie').split(';')[0];await page.text();
  t.after(async()=>{await app.close();assert.equal(cliCalls,0);await rm(root,{recursive:true,force:true});});
  const request=(route,{method='GET',body,headers={}}={})=>fetch(url+route,{method,headers:{Cookie:cookie,...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {root,dataDir,email:app.email,app,url,request};
}

test('local email drafts work without mailbox setup, deduplicate retries and survive restart',async t=>{
  const f=await fixture(t),input={requestId:'draft-http-one',to:['fixture@example.test'],subject:'A local result',body:'This is an unsent fixture draft.'};
  const initial=await(await f.request('/api/email')).json();assert.equal(initial.configured,false);assert.equal(initial.capabilities.send,false);
  const reader=await f.request('/email-reader.mjs');assert.equal(reader.status,200);assert.match(reader.headers.get('content-type'),/javascript/);assert.match(await reader.text(),/export function emailMessagePresentation/);
  const response=await f.request('/api/email/drafts',{method:'POST',body:input});assert.equal(response.status,201);
  const first=(await response.json()).draft;assert.equal(first.sent,false);assert.equal(first.state,'local_draft');
  assert.equal(await readFile(first.path,'utf8'),first.eml);
  const again=(await(await f.request('/api/email/drafts',{method:'POST',body:input})).json()).draft;assert.equal(again.id,first.id);assert.equal(again.duplicate,true);
  assert.equal((await f.request('/api/email/drafts',{method:'POST',body:{...input,body:'Conflicting content'}})).status,409);
  const listed=await(await f.request('/api/email')).json();assert.equal(listed.drafts.length,1);assert.equal(listed.drafts[0].requestId,input.requestId);assert.equal(listed.account.observed,false);
  await f.app.close();
  const restored=await new AgentEmailStore({dataDir:f.dataDir}).init();assert.equal(restored.getDraft(first.id).body,input.body);assert.equal(restored.status().cli.checked,false);await restored.close();
});

test('mailbox discovery rejects unrelated message arguments without launching a client',async t=>{
  const f=await fixture(t);
  for(const extra of [{folder:'INBOX'},{id:'message-id'},{query:'subject fixture'},{page:1},{limit:20}]){
    const response=await f.request('/api/email/action',{method:'POST',body:{action:'mailboxes',...extra}});
    assert.equal(response.status,400);
    const result=await response.json();
    assert.match(result.error,/Mailbox discovery accepts no message or folder arguments/);
  }
  assert.equal(f.email.status().account.observed,false);
});

test('Thunderbird handoff is explicit, host-only, and does not grant mailbox access or send mail', async t => {
  const calls = [];
  const emailClient = { status: async () => ({ id: 'thunderbird', name: 'Thunderbird', available: true, supported: true, capabilities: { open: true, compose: true }, accountReuse: false }),
    open: async value => { calls.push(value); return { requested: true, action: value.action, application: 'Thunderbird', nativeWindow: true, windowVerified: false, sent: false }; }, close() {} };
  const f = await fixture(t, { emailClient });
  assert.equal((await fetch(f.url + '/api/email/client')).status, 401);
  assert.equal((await (await f.request('/api/email/client')).json()).available, true); assert.deepEqual(calls, []);
  const action = body => ({ method: 'POST', body });
  assert.equal((await f.request('/api/email/client/open', { ...action({ action: 'open' }), headers: { 'x-blackice-remote': '1' } })).status, 403);
  for (const body of [{ action: 'send' }, { action: 'compose', to: 'someone@example.test' }, { action: 'open', executable: 'arbitrary.exe' }]) assert.equal((await f.request('/api/email/client/open', action(body))).status, 400);
  for (const value of ['open', 'compose']) { const response = await f.request('/api/email/client/open', action({ action: value })); assert.equal(response.status, 200); const receipt = await response.json(); assert.equal(receipt.sent, false); assert.equal(receipt.windowVerified, false); }
  assert.deepEqual(calls, [{ action: 'open' }, { action: 'compose' }]); assert.equal(f.email.status().account.observed, false);
  await f.app.beginMaintenance(); assert.equal((await f.request('/api/email/client/open', action({ action: 'open' }))).status, 503); f.app.endMaintenance();
  assert.equal(calls.length, 2);
});

test('email HTTP guards prevent unsupported sends, mailbox access before checks and stale setup writes',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.url+'/api/email')).status,401);
  assert.equal((await fetch(f.url+'/api/email',{headers:{Origin:'https://unrelated.example'}})).status,403);
  assert.equal((await f.request('/api/email/action',{method:'POST',body:{action:'send'}})).status,400);
  assert.equal((await f.request('/api/email/action',{method:'POST',body:{action:'list',folder:'INBOX'}})).status,409);
  assert.equal((await f.request('/api/email/action',{method:'POST',body:{action:'mailboxes'}})).status,409);
  assert.equal((await f.request('/api/email/config',{method:'PUT',body:{config:{enabled:false}}})).status,400);
  const saved=await f.request('/api/email/config',{method:'PUT',body:{config:{enabled:false,account:'fixture'},expectedRevision:0}});assert.equal(saved.status,200);
  const stale=await f.request('/api/email/config',{method:'PUT',body:{config:{enabled:false,account:'stale'},expectedRevision:0}});assert.equal(stale.status,409);
  assert.equal(f.email.snapshot().config.account,'fixture');
  await f.app.beginMaintenance();
  assert.equal((await f.request('/api/email/drafts',{method:'POST',body:{requestId:'closed',to:['fixture@example.test'],subject:'Fixture',body:'No write'}})).status,503);
  assert.equal(f.email.listDrafts().length,0);f.app.endMaintenance();
});

test('retired email adapters never load legacy state and ordinary chat and maintenance still work',async t=>{
  let modelCalls=0;
  class LocalRuntime extends Runtime {
    status(){return {connected:true,authenticated:true,models:[{model:'email-recovery-fixture'}],defaultModel:'email-recovery-fixture'};}
    async runAgent(options){modelCalls++;await recordFixturePlan(options);return {output:'Ordinary work still completes.',threadId:'email-recovery-thread'};}
  }
  const damaged='{"schema":1,"revision":0,"config":{"enabled":false},"drafts":[',fixtureDraft='An existing draft artifact must be preserved.';
  const f=await fixture(t,{runtime:new LocalRuntime(),defaultEmailStore:true,prepare:async({dataDir})=>{
    const directory=path.join(dataDir,'agent-email');await mkdir(directory);
    await writeFile(path.join(directory,'state.json'),damaged);
    await writeFile(path.join(directory,'preserved.eml'),fixtureDraft);
  }});
  const statusResponse=await f.request('/api/status');assert.equal(statusResponse.status,200);
  const emailStatus=(await statusResponse.json()).email;
  assert.equal(emailStatus.retired,true);assert.equal(emailStatus.available,false);
  const emailResponse=await f.request('/api/email');assert.equal(emailResponse.status,410);
  assert.equal((await emailResponse.json()).code,'EMAIL_RETIRED');
  for(const [route,options] of [
    ['/api/email/drafts',{}],['/api/email/drafts/unknown-draft',{}],
    ['/api/email/config',{method:'PUT',body:{config:{enabled:false},expectedRevision:0}}],
    ['/api/email/check',{method:'POST',body:{}}],
    ['/api/email/action',{method:'POST',body:{action:'list',folder:'INBOX'}}],
    ['/api/email/action',{method:'POST',body:{action:'mailboxes'}}],
    ['/api/email/action',{method:'POST',body:{action:'read',folder:'INBOX',id:'fixture'}}],
    ['/api/email/drafts',{method:'POST',body:{requestId:'blocked-draft',to:['fixture@example.test'],subject:'Keep the old file',body:'This write must not happen.'}}],
  ]){
    const response=await f.request(route,options);assert.equal(response.status,410,route);assert.equal((await response.json()).code,'EMAIL_RETIRED');
  }
  const workflow={id:'email-recovery-flow',name:'Ordinary task',nodes:[{id:'input',type:'input',name:'Task'},{id:'agent',type:'agent',name:'Worker',prompt:'Complete the user task.',model:'email-recovery-fixture'},{id:'output',type:'output',name:'Result'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}};
  const started=await f.request('/api/runs',{method:'POST',body:{workflow,input:'Complete an ordinary local fixture task.'}});assert.equal(started.status,201);
  const {id}=await started.json();let run;
  for(const deadline=Date.now()+7000;Date.now()<deadline;){run=f.app.engine.getRun(id);if(run.settled)break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(run.status,'completed',run.error);assert.equal(run.settled,true);assert.equal(modelCalls,1);
  await f.app.beginMaintenance();f.app.endMaintenance();await f.app.close();
  assert.equal(await readFile(path.join(f.dataDir,'agent-email','state.json'),'utf8'),damaged);
  assert.equal(await readFile(path.join(f.dataDir,'agent-email','preserved.eml'),'utf8'),fixtureDraft);
});
