import test from 'node:test';
import {createHash} from 'node:crypto';
import {normalizePlanContract} from '../public/planning-contract-model.mjs';
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

const stable=v=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
const snap=(c,revision=1)=>({contract:c,source:{kind:'task-state-v14',taskId:'native-source',revision,planEpoch:revision,contractDigest:createHash('sha256').update(stable(normalizePlanContract(c))).digest('hex')}});
test('canonical refinement preserves identity, claims and evidence across reopen; unrelated work keeps handles valid',async t=>{
 const {make}=await harness(t),s=make();await setup(s,{target:3});await s.syncPlanSnapshot({...args(),...snap(contract(3))});
 const issued=await s.issueContext({...args(),expectedRevision:(await s.read(args())).revision,workItemId:'work',criterionId:'criterion',bindingId:'binding',adapters:['relay_browser']});
 await s.admit(args({operationId:'pending'}));
 const changed=contract(3);changed.criteria.push({id:'other',kind:'external-confirmation',description:'Other result',targetCount:1});changed.workItems.push({...changed.workItems[0],id:'other-work',criterionIds:['other']});
 await s.syncPlanSnapshot({...args(),...snap(changed,2)});
 assert.equal((await s.validateContext({ownerId:'owner',taskContext:issued.taskContext})).generation,issued.generation);
 assert.equal((await s.admit(args({operationId:'retry'}))).reason,'UNKNOWN_EFFECT');
 const before=await s.read(args());await s.close();const restored=make();
 assert.deepEqual((await restored.read(args())).bindings,before.bindings);
 assert.equal((await restored.readPlanSource(args())).revision,2);
});
test('affected scope generation fences queued calls while fresh handle automatically adopts a receipt refinement',async t=>{
 const {make}=await harness(t),s=make();await setup(s);await s.syncPlanSnapshot({...args(),...snap(contract())});
 const issued=await s.issueContext({...args(),expectedRevision:(await s.read(args())).revision,workItemId:'work',criterionId:'criterion',bindingId:'binding',adapters:['relay_browser']});
 const before=await s.readScope({...args(),workItemId:'work'}),changed=contract();changed.criteria[0].description='Destination confirms the same outcome using refined receipt evidence';
 await s.syncPlanSnapshot({...args(),...snap(changed,2)});
 await assert.rejects(s.validateContext({ownerId:'owner',taskContext:issued.taskContext,expectedContextGeneration:issued.generation}),{code:'DIRECT_CONTEXT_STALE'});
 await assert.rejects(s.admit(args({operationId:'stale',expectedScopeGeneration:before.generation})),{code:'DIRECT_PLAN_SCOPE_CHANGED'});
 const fresh=await s.validateContext({ownerId:'owner',taskContext:issued.taskContext});assert.equal(fresh.generation,issued.generation+1);
 assert.equal((await s.admit(args({operationId:'fresh',taskContext:issued.taskContext,adapterId:'relay_browser',expectedContextGeneration:fresh.generation,expectedScopeGeneration:(await s.readScope({...args(),workItemId:'work'})).generation}))).admitted,true);
});
test('source ownership, revision monotonicity and immutable business meaning fail closed without deleting outcomes',async t=>{
 const {make}=await harness(t),s=make();await setup(s);await s.syncPlanSnapshot({...args(),...snap(contract(),2)});
 assert.equal(await s.readPlanSource({ownerId:'foreign',taskId:'task'}),null);
 await assert.rejects(s.syncPlanSnapshot({...args(),...snap(contract(),1)}),{code:'DIRECT_PLAN_SOURCE_STALE'});
 const other=snap(contract(),3);other.source.taskId='unrelated';await assert.rejects(s.syncPlanSnapshot({...args(),...other}),{code:'DIRECT_PLAN_SOURCE_CHANGED'});
 const changed=contract();changed.criteria[0].resourceKey='destination:https://elsewhere.test/submit';await assert.rejects(s.syncPlanSnapshot({...args(),...snap(changed,3)}),{code:'DIRECT_PLAN_SEMANTIC_CHANGE'});
 const goal=contract();goal.goal='Different goal';const oldScope=await s.readScope({...args(),workItemId:'work'});await s.syncPlanSnapshot({...args(),...snap(goal,3)});assert.equal((await s.readScope({...args(),workItemId:'work'})).generation,oldScope.generation+1);
 assert.ok((await s.read(args())).bindings.binding);
});
test('receipt metadata refinement keeps established outcome counts and new contradictory evidence is surfaced',async t=>{
 const {make,proof}=await harness(t),s=make(),b=await setup(s,{target:2});await s.syncPlanSnapshot({...args(),...snap(contract(2))});
 await s.admit(args({operationId:'commit'}));await s.observe(args({evidenceId:proof(b,'confirmed',{outcomeId:'issuer-1'})}));
 const changed=contract(2);changed.criteria[0].description='Refined display format';await s.syncPlanSnapshot({...args(),...snap(changed,2)});
 assert.equal((await s.measure(args())).criteria[0].observedCount,1);
 const absent=await s.observe(args({evidenceId:proof(b,'absent',{operationId:'new-observation',outcomeId:'issuer-1'})}));
 assert.equal(absent.state.state,'CONFIRMED');assert.equal(absent.observationConflict.kind,'current-observation-differs-from-historical-confirmation');
 const measure=await s.measure(args());assert.equal(measure.criteria[0].observedCount,1);assert.equal(measure.criteria[0].observationConflicts.length,1);
});

test('progress-only source revisions neither grow material history nor invalidate scope',async t=>{
 const {make}=await harness(t),s=make();await setup(s);await s.syncPlanSnapshot({...args(),...snap(contract())});
 const before=await s.readScope({...args(),workItemId:'work'});
 for(let revision=2;revision<=270;revision++)await s.syncPlanSnapshot({...args(),...snap(contract(),revision)});
 assert.equal((await s.read(args())).sourceHistory.length,0);
 assert.deepEqual(await s.readScope({...args(),workItemId:'work'}),before);
});
test('multi-site criterion expansion preserves old bound resource and progress',async t=>{
 const {make,proof}=await harness(t),s=make(),b=await setup(s,{target:2});await s.syncPlanSnapshot({...args(),...snap(contract(2))});
 await s.admit(args({operationId:'original'}));await s.observe(args({evidenceId:proof(b,'confirmed',{outcomeId:'original-issuer'})}));
 const expanded=contract(2);delete expanded.criteria[0].resourceKey;expanded.workItems[0].resourceKeys.push('destination:https://other.test/submit');
 await s.syncPlanSnapshot({...args(),...snap(expanded,2)});
 assert.equal((await s.measure(args())).criteria[0].observedCount,1);
 assert.equal((await s.read(args())).bindings.binding.semantic.resource,resource);
});

test('linked execution snapshot cannot be edited through direct contract update',async t=>{
 const {make}=await harness(t),s=make();
 const created=await s.syncPlanSnapshot({...args(),...snap(contract())});
 await assert.rejects(s.update({...args(),contract:contract(2),expectedRevision:created.revision}),{code:'DIRECT_PLAN_SOURCE_AUTHORITY'});
 assert.equal((await s.read(args())).contract.criteria[0].targetCount,1);
});
