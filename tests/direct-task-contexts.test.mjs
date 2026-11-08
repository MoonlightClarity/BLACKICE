import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DirectTaskOutcomes} from '../lib/direct-task-outcomes.mjs';
import {normalizeContractEvidence} from '../lib/planning-contract-evidence.mjs';
import {createDirectTaskContextTools} from '../lib/direct-task-context-tools.mjs';
const resource='destination:https://example.test/submit';
const contract=()=>({contractVersion:2,goal:'Two distinct outcomes',criteria:[{id:'criterion',kind:'external-confirmation',description:'Issuer confirms outcomes',resourceKey:resource,targetCount:2}],workItems:[{id:'work',title:'Perform effect',objective:'Produce verified effects',owner:'main',resourceKeys:[resource],effects:['commit','observe'],dependsOn:[],criterionIds:['criterion']}],instructions:[]});
const base={ownerId:'owner',taskId:'task'},bound={...base,bindingId:'binding'};
async function setup(t,{bind=true}={}){
 const dir=await fs.mkdtemp(path.join(tmpdir(),'explicit-context-')),proofs=new Map(),stores=[];
 const make=()=>{const s=new DirectTaskOutcomes({dataDir:dir,resolveEvidence:({evidenceId})=>proofs.get(evidenceId)});stores.push(s);return s;};
 t.after(async()=>{for(const s of stores)await s.close();await fs.rm(dir,{recursive:true,force:true});});
 const s=make();await s.create({...base,contract:contract()});
 if(bind)await s.bind({...bound,semantic:{effect:'destination-commit',resource,subject:'host-digest'},identityFields:['person','target'],criterionId:'criterion',workItemId:'work',tabId:'tab'});
 const issue=async(extra={})=>s.issueContext({...base,expectedRevision:(await s.read(base)).revision,workItemId:'work',criterionId:'criterion',adapters:['relay_browser','relay_workspace'],...(bind?{bindingId:'binding'}:{}),...extra});
 const absent=async()=>{const b=(await s.read(base)).bindings.binding;const e=normalizeContractEvidence({kind:'external-confirmation',resourceKey:resource,confirmation:{effectKey:b.semanticKey,status:'absent',outcomeId:'absence',prior:true}},{operationId:'baseline',workItemId:'work',at:new Date().toISOString()});proofs.set(e.id,e);await s.observe({...bound,evidenceId:e.id,phase:'baseline'});};
 return {s,make,issue,absent,dir};
}
test('handles are explicit, independent and owner isolated',async t=>{
 const {s,issue}=await setup(t);const a=await issue(),b=await issue();assert.notEqual(a.taskContext,b.taskContext);
 assert.equal((await s.validateContext({ownerId:'owner',taskContext:a.taskContext,adapterId:'relay_browser'})).taskId,'task');
 for(const ownerId of ['other','new-grant'])await assert.rejects(s.readContext({ownerId,taskContext:a.taskContext}),{code:'DIRECT_CONTEXT_NOT_FOUND'});
 await assert.rejects(s.validateContext({ownerId:'owner',taskContext:a.taskContext,adapterId:'relay_shell'}),{code:'DIRECT_CONTEXT_ADAPTER'});
 await s.revokeContext({ownerId:'owner',taskContext:a.taskContext,expectedGeneration:1});
 assert.equal((await s.readContext({ownerId:'owner',taskContext:b.taskContext})).valid,true);
});
test('context survives evidence revisions and reopen; stale issue CAS fails',async t=>{
 const {s,make,issue,absent}=await setup(t);const c=await issue();
 await absent();await s.retainOperation({...base,operation:{id:'observe'}});
 await assert.rejects(issue({expectedRevision:1}),{code:'DIRECT_CONTEXT_STALE'});
 await s.close();const reopened=make();
 assert.equal((await reopened.validateContext({ownerId:'owner',taskContext:c.taskContext})).contractDigest,c.contractDigest);
});
test('material contract edit invalidates unbound context',async t=>{
 const {s,issue}=await setup(t,{bind:false});const c=await issue();const next=contract();next.goal='Changed goal';
 await s.update({...base,expectedRevision:1,contract:next});
 await assert.rejects(s.validateContext({ownerId:'owner',taskContext:c.taskContext}),{code:'DIRECT_CONTEXT_STALE'});
 assert.equal((await s.readContext({ownerId:'owner',taskContext:c.taskContext})).valid,false);
});
test('revocation queued before final admission blocks without claiming',async t=>{
 const {s,issue,absent}=await setup(t);await absent();const c=await issue();
 await s.validateContext({ownerId:'owner',taskContext:c.taskContext});
 const revoke=s.revokeContext({ownerId:'owner',taskContext:c.taskContext,expectedGeneration:1});
 const admit=s.admit({...bound,operationId:'queued',taskContext:c.taskContext,adapterId:'relay_browser',expectedContextGeneration:1});
 await revoke;await assert.rejects(admit,{code:'DIRECT_CONTEXT_REVOKED'});
 assert.equal((await s.read(base)).bindings.binding.claim,null);
});
test('revocation and reopen never release uncertain claim; fresh context permits recovery read',async t=>{
 const {s,make,issue,absent}=await setup(t);await absent();const c=await issue();
 assert.equal((await s.admit({...bound,operationId:'dispatch',taskContext:c.taskContext,adapterId:'relay_browser'})).admitted,true);
 await s.revokeContext({ownerId:'owner',taskContext:c.taskContext,expectedGeneration:1});
 const fresh=await issue();await s.close();const reopened=make();
 const args={...bound,taskContext:fresh.taskContext,adapterId:'relay_browser',operationId:'retry'};
 assert.equal((await reopened.admit(args)).reason,'UNKNOWN_EFFECT');
 assert.equal((await reopened.admit({...args,readOnly:true})).observationOnly,true);
});
test('wrong task and unbound identity policy cannot borrow a context',async t=>{
 const {s,issue}=await setup(t,{bind:false});const c=await issue();
 await s.bind({...bound,semantic:{effect:'destination-commit',resource,subject:'host-digest'},identityFields:['person','target'],criterionId:'criterion',workItemId:'work',tabId:'tab'});
 await assert.rejects(s.admit({...bound,operationId:'attempt',taskContext:c.taskContext,adapterId:'relay_browser'}),{code:'DIRECT_CONTEXT_SCOPE'});
 await s.create({ownerId:'owner',taskId:'other',contract:contract()});
 await s.bind({...bound,taskId:'other',semantic:{effect:'destination-commit',resource,subject:'host-digest'},identityFields:['person','target'],criterionId:'criterion',workItemId:'work',tabId:'other'});
 await assert.rejects(s.admit({...bound,taskId:'other',operationId:'attempt',taskContext:c.taskContext,adapterId:'relay_browser'}),{code:'DIRECT_CONTEXT_SCOPE'});
});
test('two trusted adapters contend for one shared claim',async t=>{
 const {s,issue,absent}=await setup(t);await absent();const c=await issue();
 const results=await Promise.all(['native','direct'].map(operationId=>s.admit({...bound,operationId,taskContext:c.taskContext,adapterId:'relay_browser'})));
 assert.equal(results.filter(r=>r.admitted).length,1);assert.equal(results.find(r=>!r.admitted).reason,'UNKNOWN_EFFECT');
});
test('context tool derives principal solely from authenticated client and rejects caller owner/proof',async t=>{
 const {s}=await setup(t);const tool=createDirectTaskContextTools({runtime:s})[0];
 const args={requestId:'issue-one',action:'issue',taskId:'task',expectedRevision:2,workItemId:'work',criterionId:'criterion',adapters:['relay_browser'],bindingId:'binding'};
 for(const field of ['ownerId','evidence','semanticKey'])await assert.rejects(tool.execute({...args,[field]:'forged'},{client:{id:'owner'},jobId:'job'}));
 const result=await tool.execute(args,{client:{id:'owner'},jobId:'job'});const c=JSON.parse(result.contentItems[0].text).result;
 assert.equal(c.ownerId,'owner');assert.equal(c.identityFields.length,2);
 await assert.rejects(tool.execute({...args,requestId:'other'},{client:{id:'other'},jobId:'job'}),{code:'DIRECT_OUTCOME_NOT_FOUND'});
});

test('null expected tab context is an atomic empty-context comparison',async t=>{
 const {s}=await setup(t);await s.bindTab({...bound,tabId:'new-tab',expectedContext:null});
 await assert.rejects(s.bindTab({...bound,tabId:'new-tab',expectedContext:null}),{code:'DIRECT_OUTCOME_CONTEXT_CHANGED'});
});
test('reverting a contract cannot resurrect a previously invalidated handle',async t=>{
 const {s,issue}=await setup(t,{bind:false});const c=await issue(),next=contract();next.goal='Changed goal';
 await s.update({...base,expectedRevision:1,contract:next});await s.update({...base,expectedRevision:2,contract:contract()});
 await assert.rejects(s.validateContext({ownerId:'owner',taskContext:c.taskContext}),{code:'DIRECT_CONTEXT_STALE'});
});
test('prototype-like caller handles cannot resolve internal records',async t=>{
 const {s}=await setup(t);
 for(const taskContext of ['__proto__','constructor','toString'])await assert.rejects(s.readContext({ownerId:'owner',taskContext}),{code:'DIRECT_CONTEXT_NOT_FOUND'});
});


import {DirectExecutionAPI,DIRECT_EXECUTION_SCOPES} from '../lib/direct-execution-api.mjs';
async function apiFixture(t){
 const root=await fs.mkdtemp(path.join(tmpdir(),'context-api-'));await fs.writeFile(path.join(root,'note.txt'),'observed text');
 let release,started,extensionCalls=0;
 const began=new Promise(r=>started=r),hold=new Promise(r=>release=r);
 const entry={definition:{name:'blackice_test_hold',scope:'read',requiredScopes:['read'],mutating:false,inputSchema:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false}},execute:async()=>{extensionCalls++;started();await hold;return {success:true,contentItems:[{type:'inputText',text:'done'}]};}};
 let allowed=[...DIRECT_EXECUTION_SCOPES];
 const api=new DirectExecutionAPI({dataDir:root,allowedRoot:root,maxConcurrent:1,additionalTools:[entry],authorizeClient:async(c,{requiredScopes})=>requiredScopes.every(scope=>allowed.includes(scope))});
 await api.init();t.after(async()=>{release();await api.close();await fs.rm(root,{recursive:true,force:true});});
 const client={id:'owner',scopes:[...DIRECT_EXECUTION_SCOPES],kind:'chatgpt'};
 async function saved(q,who=client){for(let n=0;n<1000;n++){const r=await api.getJob(q.jobId,who);if(r.settled)return r;await new Promise(r=>setTimeout(r,5));}assert.fail('Job did not settle');}
 const run=async(tool,args,who=client)=>saved(await api.call(tool,args,who),who);
 const c=contract();c.workItems[0].resourceKeys=['discovery'];
 const created=await run('blackice_task_contract',{requestId:'create-context-task',action:'create',taskId:'task',contract:c});assert.equal(created.status,'succeeded',JSON.stringify(created));
 const issue=async requestId=>{const r=await run('blackice_task_context',{requestId,action:'issue',taskId:'task',expectedRevision:1,workItemId:'work',criterionId:'criterion',adapters:['relay_workspace']});assert.equal(r.status,'succeeded',JSON.stringify(r));return JSON.parse(r.result.text.text).result;};
 return {api,client,root,saved,run,issue,began,release,extensionCalls:()=>extensionCalls,setScopes:v=>allowed=v};
}
test('actual API issues context, reads workspace, binds replay digest and rejects opaque effects',async t=>{
 const f=await apiFixture(t),a=await f.issue('issue-a'),b=await f.issue('issue-b');
 const args={requestId:'read-one',action:'read',path:'note.txt',taskContext:a.taskContext};
 const read=await f.run('blackice_workspace_read',args);assert.equal(read.status,'succeeded',JSON.stringify(read));assert.match(read.result.text.text,/observed text/);assert.match(read.result.text.text,/successDelta/);
 const internal=await f.api.jobs.get(read.jobId,{ownerId:'owner'});assert.equal(internal.arguments.taskContext,a.taskContext);
 assert.equal((await f.api.call('blackice_workspace_read',args,f.client)).existing,true);
 await assert.rejects(f.api.call('blackice_workspace_read',{...args,taskContext:b.taskContext},f.client));
 const shell=await f.run('blackice_run_command',{requestId:'blocked-shell',command:'echo should-not-run',taskContext:a.taskContext});
 assert.equal(shell.status,'failed');assert.equal(shell.error.code,'DIRECT_TASK_ADAPTER_UNSUPPORTED');assert.equal(shell.effects.possible,false);
 const extension=await f.run('blackice_test_hold',{requestId:'blocked-extension',taskContext:a.taskContext});
 assert.equal(extension.status,'failed');assert.equal(f.extensionCalls(),0);
 const other=await f.run('blackice_workspace_read',{...args,requestId:'other-owner'},{...f.client,id:'other'});
 assert.equal(other.status,'failed');assert.equal(other.error.code,'DIRECT_CONTEXT_NOT_FOUND');
});
test('revoking context while workspace read is queued blocks dispatch',async t=>{
 const f=await apiFixture(t),c=await f.issue('issue');
 const hold=await f.api.call('blackice_test_hold',{requestId:'hold'},f.client);await f.began;
 const queued=await f.api.call('blackice_workspace_read',{requestId:'queued-read',action:'read',path:'note.txt',taskContext:c.taskContext},f.client);
 await f.api.taskRuntime.revokeContext({ownerId:'owner',taskContext:c.taskContext,expectedGeneration:1});
 f.release();await f.saved(hold);const blocked=await f.saved(queued);
 assert.equal(blocked.status,'failed');assert.equal(blocked.error.code,'DIRECT_CONTEXT_REVOKED');assert.equal(blocked.effects.possible,false);
});
test('queued protected job retains planning scope and cannot execute after scope removal',async t=>{
 const f=await apiFixture(t),c=await f.issue('issue');
 const hold=await f.api.call('blackice_test_hold',{requestId:'hold'},f.client);await f.began;
 const q=await f.api.call('blackice_workspace_read',{requestId:'scope-revoked-read',action:'read',path:'note.txt',taskContext:c.taskContext},f.client);
 assert.ok(q.requiredScopes.includes('planning:write'));
 f.setScopes(DIRECT_EXECUTION_SCOPES.filter(s=>s!=='planning:write'));f.release();await f.saved(hold);
 for(let n=0;n<1000;n++){const internal=await f.api.jobs.get(q.jobId,{ownerId:'owner'});if(internal.status==='failed'){assert.equal(internal.dispatched,false);return;}await new Promise(r=>setTimeout(r,5));}
 assert.fail('Revoked protected job did not fail');
});


test('native attachment persists explicit principal and revision without credentials or guessed identity',async t=>{
 const {s,make,issue}=await setup(t),c=await issue();
 const args={ownerId:'owner',taskContext:c.taskContext,nativeTaskId:'native-task',nativeRevision:7,client:{id:'owner',kind:'chatgpt',scopes:['read','planning:write'],token:'never-persist',label:'Caller'}};
 const a=await s.attachNativeTask(args);assert.equal(a.generation,1);assert.equal(a.client.token,undefined);assert.equal((await s.attachNativeTask(args)).generation,1);
 assert.throws(()=>s.attachNativeTask({...args,client:{...args.client,id:'other'}}),{code:'DIRECT_CONTEXT_PRINCIPAL'});
 await s.close();const reopened=make();assert.deepEqual(await reopened.readNativeAttachment({nativeTaskId:'native-task'}),a);
 assert.equal(await reopened.readNativeAttachment({nativeTaskId:'other-task'}),null);
});
test('native attachment cannot replace another principal or abandon an uncertain task',async t=>{
 const {s,issue,absent}=await setup(t),c=await issue();
 await s.attachNativeTask({ownerId:'owner',taskContext:c.taskContext,nativeTaskId:'native',nativeRevision:1,client:{id:'owner',scopes:['read']}});
 await s.create({ownerId:'other',taskId:'task',contract:contract()});
 const other=await s.issueContext({ownerId:'other',taskId:'task',expectedRevision:1,workItemId:'work',criterionId:'criterion',adapters:['relay_browser']});
 await assert.rejects(s.attachNativeTask({ownerId:'other',taskContext:other.taskContext,nativeTaskId:'native',nativeRevision:1,client:{id:'other',scopes:['read']}}),{code:'DIRECT_CONTEXT_PRINCIPAL'});
 await absent();await s.admit({...bound,operationId:'pending'});const fresh=await issue();
 assert.equal((await s.attachNativeTask({ownerId:'owner',taskContext:fresh.taskContext,nativeTaskId:'native',nativeRevision:1,client:{id:'owner',scopes:['read']}})).generation,2);
 await s.create({...base,taskId:'different',contract:contract()});
 const unrelated=await s.issueContext({...base,taskId:'different',expectedRevision:1,workItemId:'work',criterionId:'criterion',adapters:['relay_browser']});
 await assert.rejects(s.attachNativeTask({ownerId:'owner',taskContext:unrelated.taskContext,nativeTaskId:'native',nativeRevision:1,client:{id:'owner',scopes:['read']}}),{code:'DIRECT_OUTCOME_UNCERTAIN'});
 await s.revokeContext({ownerId:'owner',taskContext:c.taskContext,expectedGeneration:1});
 assert.equal((await s.readNativeAttachment({nativeTaskId:'native'})).taskContext,fresh.taskContext);
 await assert.rejects(s.attachNativeTask({ownerId:'owner',taskContext:c.taskContext,nativeTaskId:'native-two',nativeRevision:1,client:{id:'owner',scopes:['read']}}),{code:'DIRECT_CONTEXT_REVOKED'});
});

test('native attachment replacement races final admission atomically without claiming stale context',async t=>{
 const {s,issue,absent}=await setup(t);await absent();const a=await issue(),b=await issue();
 const original=await s.attachNativeTask({ownerId:'owner',taskContext:a.taskContext,nativeTaskId:'native',nativeRevision:1,client:{id:'owner',scopes:['read']}});
 const changed=s.attachNativeTask({ownerId:'owner',taskContext:b.taskContext,nativeTaskId:'native',nativeRevision:1,client:{id:'owner',scopes:['read']}});
 const stale=s.admit({...bound,operationId:'stale-native',taskContext:a.taskContext,adapterId:'relay_browser',nativeAttachment:{nativeTaskId:'native',generation:original.generation}});
 await changed;await assert.rejects(stale,{code:'DIRECT_CONTEXT_ATTACHMENT_CHANGED'});
 assert.equal((await s.read(base)).bindings.binding.claim,null);
 const mapping=await s.readNativeAttachment({nativeTaskId:'native'});
 const admitted=await s.admit({...bound,operationId:'current-native',taskContext:b.taskContext,adapterId:'relay_browser',nativeAttachment:{nativeTaskId:'native',generation:mapping.generation}});
 assert.equal(admitted.admitted,true);
});


test('switching to an independent target cannot conceal an older claim during cross-task reassignment',async t=>{
 const {s,absent}=await setup(t);await s.bindTab({...bound,tabId:'tab'});await absent();await s.admit({...bound,operationId:'pending'});
 await s.bind({...base,bindingId:'independent',semantic:{effect:'destination-commit',resource,subject:'other'},identityFields:['person','target'],criterionId:'criterion',workItemId:'work',tabId:'tab'});
 await s.bindTab({...base,bindingId:'independent',tabId:'tab',expectedContext:{taskId:'task',bindingId:'binding'}});
 assert.equal((await s.resolveBinding({ownerId:'owner',tabId:'tab'})).unresolved,false);
 await s.create({...base,taskId:'unrelated',contract:contract()});
 await s.bind({...base,taskId:'unrelated',bindingId:'unrelated',semantic:{effect:'destination-commit',resource,subject:'third'},identityFields:['person','target'],criterionId:'criterion',workItemId:'work',tabId:'tab'});
 await assert.rejects(s.bindTab({...base,taskId:'unrelated',bindingId:'unrelated',tabId:'tab'}),{code:'DIRECT_OUTCOME_UNCERTAIN'});
 await s.bindTab({...bound,tabId:'recovery',expectedContext:null});
 assert.equal((await s.resolveBinding({ownerId:'owner',tabId:'recovery'})).unresolved,true);
});
