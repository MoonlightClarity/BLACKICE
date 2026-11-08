import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DirectTaskOutcomes, semanticOutcomeKey } from '../lib/direct-task-outcomes.mjs';
import { normalizeContractEvidence } from '../lib/planning-contract-evidence.mjs';
const resource='destination:https://example.test/submit';
const semantic=(subject='person:1,target:1')=>({effect:'destination-commit',resource,subject});
const contract=(targetCount=1)=>({contractVersion:2,goal:'Achieve distinct new effects',criteria:[{id:'criterion',kind:'external-confirmation',description:'Destination confirms distinct outcomes',resourceKey:resource,targetCount}],workItems:[{id:'work',title:'Perform effect',objective:'Produce a new verified effect',owner:'main',resourceKeys:[resource],effects:['commit','observe'],dependsOn:[],criterionIds:['criterion']}],instructions:[]});
async function harness(t){
 const dir=await fs.mkdtemp(path.join(tmpdir(),'direct-outcomes-')),evidence=new Map(),stores=[];
 const make=(options={})=>{const s=new DirectTaskOutcomes({dataDir:dir,resolveEvidence:({ownerId,evidenceId})=>evidence.get(ownerId+':'+evidenceId),...options});stores.push(s);return s;};
 t.after(async()=>{for(const s of stores)await s.close();await fs.rm(dir,{recursive:true,force:true});});
 let sequence=0;
 function proof(b,status,{ownerId='owner',prior=false,operationId='proof-'+(++sequence),outcomeId='outcome-'+sequence,at=new Date(Date.now()+1000).toISOString(),resourceKey=resource,effectKey=b.semanticKey}={}){
  const e=normalizeContractEvidence({kind:'external-confirmation',resourceKey,confirmation:{status,prior,effectKey,outcomeId}},{operationId,workItemId:'work',at});evidence.set(ownerId+':'+e.id,e);return e.id;
 }
 return {dir,make,proof,evidence};
}
async function setup(s,{ownerId='owner',taskId='task',bindingId='binding',subject,tabId='tab',target=1}={}){
 await s.create({ownerId,taskId,contract:contract(target)});
 return s.bind({ownerId,taskId,bindingId,semantic:semantic(subject),identityFields:['person','target'],criterionId:'criterion',workItemId:'work',tabId});
}
const args=(extra={})=>({ownerId:'owner',taskId:'task',bindingId:'binding',...extra});
test('no recorded effect allows initial attempt without inventing issuer absence; pending repeats stay blocked',async t=>{
 const {make}=await harness(t),s=make();await setup(s);
 assert.equal((await s.admit(args({operationId:'effect'}))).admitted,true);
 assert.equal((await s.read(args())).bindings.binding.baseline.state,'UNKNOWN');
 assert.equal((await s.read(args())).bindings.binding.baseline.basis,'no-recorded-host-effect');
 assert.equal((await s.admit(args({operationId:'again'}))).reason,'UNKNOWN_EFFECT');
 assert.equal((await s.admit(args({operationId:'read',readOnly:true}))).admitted,true);
 assert.equal((await s.measure(args())).satisfied,false);
});
test('durable claim serializes concurrent attempts and stays UNKNOWN across reopen',async t=>{
 const {make,proof}=await harness(t),s=make(),b=await setup(s);
 await s.observe(args({evidenceId:proof(b,'absent',{at:new Date().toISOString()}),phase:'baseline'}));
 const results=await Promise.all(['one','two','three'].map(operationId=>s.admit(args({operationId}))));
 assert.equal(results.filter(r=>r.admitted).length,1);
 await s.close();const reopened=make();
 assert.equal((await reopened.admit(args({operationId:'after-restart'}))).reason,'UNKNOWN_EFFECT');
 assert.equal((await reopened.admit(args({operationId:'read',readOnly:true}))).admitted,true);
});
test('new confirmed outcome counts once; another task cannot repeat or count it',async t=>{
 const {make,proof}=await harness(t),s=make(),b=await setup(s);
 await s.observe(args({evidenceId:proof(b,'absent',{at:new Date().toISOString()}),phase:'baseline'}));
 await s.admit(args({operationId:'write'}));
 const id=proof(b,'confirmed',{outcomeId:'external-42'});
 await s.observe(args({evidenceId:id}));
 assert.equal((await s.measure(args())).criteria[0].observedCount,1);
 assert.equal((await s.measure(args())).criteria[0].outcomes[0].novelty,'issuer-absence-established');
 assert.equal((await s.observe(args({evidenceId:id}))).replayed,true);
 const second=await setup(s,{taskId:'other',bindingId:'second'});
 assert.equal(second.baseline.state,'CONFIRMED');
 assert.equal((await s.admit(args({taskId:'other',bindingId:'second',operationId:'again'}))).reason,'ALREADY_CONFIRMED');
 assert.equal((await s.measure({ownerId:'owner',taskId:'other'})).criteria[0].observedCount,0);
});
test('distinct identities count relative to absent baseline; duplicate external outcome IDs do not',async t=>{
 const {make,proof}=await harness(t),s=make();
 for(const [index,outcomeId] of ['one','one','two'].entries()){
  const bindingId='binding-'+index,b=await setup(s,{bindingId,subject:'subject-'+index,target:2});
  await s.observe(args({bindingId,evidenceId:proof(b,'absent',{at:new Date().toISOString()}),phase:'baseline'}));
  await s.admit(args({bindingId,operationId:'write-'+index}));
  await s.observe(args({bindingId,evidenceId:proof(b,'confirmed',{outcomeId})}));
 }
 const m=await s.measure(args());assert.equal(m.criteria[0].observedCount,2);assert.equal(m.satisfied,true);
});
test('prior confirmations and missing evidence never satisfy new-effect measurement',async t=>{
 const {make,proof}=await harness(t),s=make(),b=await setup(s);
 await assert.rejects(s.observe(args({evidenceId:'nonexistent'})),{code:'DIRECT_OUTCOME_EVIDENCE_UNAVAILABLE'});
 await s.observe(args({evidenceId:proof(b,'absent',{at:new Date().toISOString()}),phase:'baseline'}));
 await s.admit(args({operationId:'write'}));
 await s.observe(args({evidenceId:proof(b,'confirmed',{prior:true})}));
 assert.equal((await s.measure(args())).criteria[0].observedCount,0);
});
test('only resolver evidence with matching ID, resource and semantic identity is admitted',async t=>{
 const {make,proof,evidence}=await harness(t),s=make(),b=await setup(s);
 await assert.rejects(s.observe(args({evidenceId:proof(b,'confirmed',{resourceKey:'destination:wrong'})})));
 await assert.rejects(s.observe(args({evidenceId:proof(b,'confirmed',{effectKey:'raw-payload-dependent-key'})})));
 const id=proof(b,'confirmed'),e=evidence.get('owner:'+id);evidence.set('owner:'+id,{...e,id:'forged'});
 await assert.rejects(s.observe(args({evidenceId:id})));
 assert.equal((await s.measure(args())).satisfied,false);
});
test('grant ownership isolates tasks, claims and evidence',async t=>{
 const {make,proof}=await harness(t),s=make(),a=await setup(s);
 await s.observe(args({evidenceId:proof(a,'confirmed'),phase:'baseline'}));
 const b=await setup(s,{ownerId:'another'});
 assert.equal(b.baseline.state,'UNKNOWN');
 await assert.rejects(s.read({ownerId:'foreign',taskId:'task'}));
 assert.equal((await s.admit(args({ownerId:'another',operationId:'write'}))).admitted,true);
 assert.equal((await s.read({ownerId:'another',taskId:'task'})).bindings.binding.baseline.state,'UNKNOWN');
});
test('second live journal owner is rejected and immutable contracts cannot be retrofitted',async t=>{
 const {make}=await harness(t),s=make();await setup(s);
 const other=make();await assert.rejects(other.read(args()),{code:'DIRECT_OUTCOME_LOCKED'});
 const saved=await s.read(args());await assert.rejects(s.update({ownerId:'owner',taskId:'task',contract:contract(2),expectedRevision:saved.revision}));
});
test('post-claim absence safely reconciles uncertainty but never counts completion',async t=>{
 const {make,proof}=await harness(t),s=make(),b=await setup(s);
 await s.observe(args({evidenceId:proof(b,'absent',{at:new Date().toISOString()}),phase:'baseline'}));
 await s.admit(args({operationId:'write'}));
 await s.observe(args({evidenceId:proof(b,'absent')}));
 assert.equal((await s.measure(args())).satisfied,false);
 assert.equal((await s.admit(args({operationId:'retry-after-verified-absence'}))).admitted,true);
});
test('host operation records persist and replay cannot change original facts',async t=>{
 const {make}=await harness(t),s=make();await setup(s);
 await s.retainOperation({ownerId:'owner',taskId:'task',operation:{id:'op',descriptor:{effect:'commit'}}});
 await assert.rejects(s.retainOperation({ownerId:'owner',taskId:'task',operation:{id:'op',descriptor:{effect:'observe'}}}));
 await s.close();const next=make();assert.equal((await next.readOperations(args()))[0].descriptor.effect,'commit');
});


test('hard process exit never frees an admitted effect; stale ownership recovers safely',async t=>{
 const {dir,make}=await harness(t);
 const {spawn}=await import('node:child_process'),{once}=await import('node:events'),{pathToFileURL}=await import('node:url');
 const moduleUrl=pathToFileURL(path.resolve('lib/direct-task-outcomes.mjs')).href,evidenceUrl=pathToFileURL(path.resolve('lib/planning-contract-evidence.mjs')).href;
 const script=`import {DirectTaskOutcomes} from ${JSON.stringify(moduleUrl)};
 import {normalizeContractEvidence} from ${JSON.stringify(evidenceUrl)};
 const records=new Map(),s=new DirectTaskOutcomes({dataDir:${JSON.stringify(dir)},resolveEvidence:({evidenceId})=>records.get(evidenceId)});
 await s.create({ownerId:'owner',taskId:'task',contract:${JSON.stringify(contract())}});
 const b=await s.bind({ownerId:'owner',taskId:'task',bindingId:'binding',semantic:${JSON.stringify(semantic())},criterionId:'criterion',workItemId:'work',tabId:'tab'});
 const e=normalizeContractEvidence({kind:'external-confirmation',resourceKey:${JSON.stringify(resource)},confirmation:{effectKey:b.semanticKey,outcomeId:'none',status:'absent',prior:false}},{operationId:'read',workItemId:'work',at:new Date().toISOString()});
 records.set(e.id,e);await s.observe({ownerId:'owner',taskId:'task',bindingId:'binding',evidenceId:e.id,phase:'baseline'});
 await s.admit({ownerId:'owner',taskId:'task',bindingId:'binding',operationId:'uncertain-write'});
 console.log('CLAIM_SAVED');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill();});
 await new Promise((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(Error('Child timed out: '+errors)),10000);
 child.stderr.on('data',data=>{errors+=data;});child.stdout.on('data',data=>{output+=data;if(output.includes('CLAIM_SAVED')){clearTimeout(timer);resolve();}});
 child.once('exit',()=>{clearTimeout(timer);reject(Error('Child exited: '+errors));});});
 const exit=once(child,'exit');child.kill();await exit;
 const recovered=make();
 assert.equal((await recovered.admit(args({operationId:'retry'}))).reason,'UNKNOWN_EFFECT');
});
test('uncertain atomic write fails closed; reopen preserves a committed claim',async t=>{
 const {dir,proof,make}=await harness(t);let failRename=false;
 const io={...fs,rename:async(...args)=>{await fs.rename(...args);if(failRename)throw Object.assign(Error('Lost acknowledgement'),{code:'EIO'});}};
 const records=new Map(),s=make({io,resolveEvidence:({evidenceId})=>records.get(evidenceId)});
 const b=await setup(s),id=proof(b,'absent',{at:new Date().toISOString()});
 // The local host resolver remains the only admission path for evidence.
 const e=normalizeContractEvidence({kind:'external-confirmation',resourceKey:resource,confirmation:{effectKey:b.semanticKey,outcomeId:'none',status:'absent',prior:false}},{operationId:'baseline',workItemId:'work',at:new Date().toISOString()});
 records.set(e.id,e);await s.observe(args({evidenceId:e.id,phase:'baseline'}));
 failRename=true;await assert.rejects(s.admit(args({operationId:'uncertain'})),{code:'DIRECT_OUTCOME_STORAGE'});
 await assert.rejects(s.admit(args({operationId:'again'})),{code:'DIRECT_OUTCOME_STORAGE'});
 await s.close();const next=make();
 assert.equal((await next.admit(args({operationId:'after-reopen'}))).reason,'UNKNOWN_EFFECT');
});


test('tab context is explicit, durable, owner-scoped and cannot abandon an uncertain effect',async t=>{
 const {make,proof}=await harness(t),s=make(),first=await setup(s);
 assert.equal(await s.resolveBinding({ownerId:'owner',tabId:'tab'}),null);
 await s.bindTab({ownerId:'owner',taskId:'task',bindingId:'binding',tabId:'tab'});
 await s.observe(args({evidenceId:proof(first,'absent',{at:new Date().toISOString()}),phase:'baseline'}));
 await s.admit(args({operationId:'write'}));
 await setup(s,{taskId:'next',bindingId:'next',subject:'other'});
 await assert.rejects(s.bindTab({ownerId:'owner',taskId:'next',bindingId:'next',tabId:'tab'}),{code:'DIRECT_OUTCOME_UNCERTAIN'});
 await s.close();const reopened=make();
 assert.equal((await reopened.resolveBinding({ownerId:'owner',tabId:'tab'})).taskId,'task');
 assert.equal(await reopened.resolveBinding({ownerId:'foreign',tabId:'tab'}),null);
 await reopened.observe(args({evidenceId:proof(first,'absent')}));
 await reopened.bindTab({ownerId:'owner',taskId:'next',bindingId:'next',tabId:'tab'});
 assert.equal((await reopened.resolveBinding({ownerId:'owner',tabId:'tab'})).taskId,'next');
});
test('direct task tool injects owner and rejects caller-supplied proof and owner fields',async()=>{
 const {createDirectTaskContractTools}=await import('../lib/direct-task-contract-tools.mjs');
 const calls=[],runtime=Object.fromEntries(['create','read','update','measure','bind','reconcile','authorizeRepeat','exitProtection'].map(action=>[action,async(input)=>{calls.push({action,input});return {ok:true};}]));
 const [tool]=createDirectTaskContractTools({runtime});
 assert.deepEqual(tool.definition.requiredScopes,['planning:write','browser:read']);
 assert.ok(tool.definition.inputSchema.oneOf.find(v=>v.properties.action.const==='create').properties.contract);
 const context={client:{id:'authenticated-owner'},jobId:'durable-job'};
 const result=await tool.execute({requestId:'read-1',action:'read',taskId:'task'},context);
 assert.equal(result.success,true);assert.equal(calls[0].input.ownerId,'authenticated-owner');
 await assert.rejects(tool.execute({requestId:'bad',action:'read',taskId:'task',ownerId:'other'},context));
 await assert.rejects(tool.execute({requestId:'bad',action:'reconcile',taskId:'task',evidence:{confirmation:'invented'}},context));
 const binding=tool.definition.inputSchema.oneOf.find(v=>v.properties.action.const==='bind');
 for(const field of ['ref','expectedUrl','expectedDocumentId','identityFields'])assert.ok(binding.required.includes(field));
});


test('distinct concurrent claims reserve target capacity until verified absence releases it',async t=>{
 const {make,proof}=await harness(t),s=make();
 const a=await setup(s,{bindingId:'a',subject:'a'}),b=await setup(s,{bindingId:'b',subject:'b'});
 for(const binding of [a,b])await s.observe(args({bindingId:binding.bindingId,evidenceId:proof(binding,'absent',{at:new Date().toISOString()}),phase:'baseline'}));
 const results=await Promise.all(['a','b'].map(bindingId=>s.admit(args({bindingId,operationId:'write-'+bindingId}))));
 assert.equal(results.filter(r=>r.admitted).length,1);assert.equal(results.filter(r=>r.reason==='TARGET_CAPACITY').length,1);
 const winner=results[0].admitted?a:b,other=results[0].admitted?b:a;
 await s.observe(args({bindingId:winner.bindingId,evidenceId:proof(winner,'absent')}));
 assert.equal((await s.admit(args({bindingId:other.bindingId,operationId:'after-absence'}))).admitted,true);
 await s.observe(args({bindingId:other.bindingId,evidenceId:proof(other,'confirmed',{outcomeId:'one-completed'})}));
 assert.equal((await s.admit(args({bindingId:winner.bindingId,operationId:'overshoot'}))).reason,'TARGET_SATISFIED');
});
test('unmet canonical work prerequisites block effects but not observations',async t=>{
 const {make,proof}=await harness(t),s=make(),c=contract();
 c.criteria.push({id:'prerequisite',kind:'external-confirmation',description:'Complete prerequisite',targetCount:1});
 c.workItems.push({...structuredClone(c.workItems[0]),id:'before',criterionIds:['prerequisite']});
 c.workItems[0].dependsOn=['before'];
 await s.create({ownerId:'owner',taskId:'task',contract:c});
 const b=await s.bind({ownerId:'owner',taskId:'task',bindingId:'binding',semantic:semantic(),identityFields:['person','target'],criterionId:'criterion',workItemId:'work',tabId:'tab'});
 await s.observe(args({evidenceId:proof(b,'absent',{at:new Date().toISOString()}),phase:'baseline'}));
 assert.equal((await s.admit(args({operationId:'blocked'}))).reason,'PREREQUISITES_UNSATISFIED');
 assert.equal((await s.admit(args({operationId:'inspect',readOnly:true}))).admitted,true);
});


test('uncertain outcome can be reconciled from a replacement tab after reopening without abandoning original context',async t=>{
 const {make,proof}=await harness(t),s=make(),b=await setup(s);
 await s.bindTab({ownerId:'owner',taskId:'task',bindingId:'binding',tabId:'tab'});
 await s.observe(args({evidenceId:proof(b,'absent',{at:new Date().toISOString()}),phase:'baseline'}));
 await s.admit(args({operationId:'uncertain'}));await s.close();
 const reopened=make(),recovered=await setup(reopened,{tabId:'replacement'});
 assert.equal(recovered.bindingId,b.bindingId);
 await reopened.bindTab({ownerId:'owner',taskId:'task',bindingId:'binding',tabId:'replacement'});
 assert.equal((await reopened.resolveBinding({ownerId:'owner',tabId:'tab'})).binding.bindingId,b.bindingId);
 assert.equal((await reopened.resolveBinding({ownerId:'owner',tabId:'replacement'})).binding.bindingId,b.bindingId);
 assert.equal((await reopened.admit(args({operationId:'never-repeat'}))).reason,'UNKNOWN_EFFECT');
 await reopened.observe(args({evidenceId:proof(b,'confirmed',{outcomeId:'confirmed-after-reopen'})}));
 assert.equal((await reopened.measure(args())).criteria[0].observedCount,1);
});


test('final admission atomically rejects a task context replaced after earlier inspection',async t=>{
 const {make,proof}=await harness(t),s=make(),b=await setup(s);
 await s.observe(args({evidenceId:proof(b,'absent',{at:new Date().toISOString()}),phase:'baseline'}));
 await s.bindTab({ownerId:'owner',taskId:'task',bindingId:'binding',tabId:'tab'});
 const captured=await s.resolveBinding({ownerId:'owner',tabId:'tab'});
 await setup(s,{taskId:'other',bindingId:'other'});
 await s.bindTab({ownerId:'owner',taskId:'other',bindingId:'other',tabId:'tab'});
 assert.equal((await s.admit({ownerId:'owner',taskId:captured.taskId,bindingId:captured.binding.bindingId,operationId:'stale',tabId:'tab'})).reason,'TASK_CONTEXT_CHANGED');
 assert.equal((await s.admit(args({operationId:'read',readOnly:true,tabId:'tab'}))).admitted,true);
});


test('stale automatic target switching cannot overwrite a newer explicit task context',async t=>{
 const {make}=await harness(t),s=make();
 await setup(s);await s.bindTab({ownerId:'owner',taskId:'task',bindingId:'binding',tabId:'tab'});
 const captured=await s.resolveBinding({ownerId:'owner',tabId:'tab'});
 await setup(s,{bindingId:'auto-next',subject:'different-target'});
 await setup(s,{taskId:'new-task',bindingId:'new-binding'});
 await s.bindTab({ownerId:'owner',taskId:'new-task',bindingId:'new-binding',tabId:'tab'});
 await assert.rejects(s.bindTab({ownerId:'owner',taskId:'task',bindingId:'auto-next',tabId:'tab',expectedContext:{taskId:captured.taskId,bindingId:captured.binding.bindingId}}),{code:'DIRECT_OUTCOME_CONTEXT_CHANGED'});
 assert.equal((await s.resolveBinding({ownerId:'owner',tabId:'tab'})).taskId,'new-task');
});
