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

const request=(extra={})=>args({userInstructionRef:'user-message-2',userInstructionQuote:'Please intentionally do this again.',reason:'User explicitly requested another occurrence.',...extra});
async function prior(s,proof,{unknown=false,target=3}={}){
 const b=await setup(s,{target});await s.bindTab(args({tabId:'tab'}));
 await s.observe(args({evidenceId:proof(b,'absent',{at:new Date().toISOString()}),phase:'baseline'}));
 await s.admit(args({operationId:'original'}));
 if(!unknown)await s.observe(args({evidenceId:proof(b,'confirmed',{outcomeId:'issuer-original'})}));
 return b;
}
test('confirmed deliberate repeat preserves original and needs distinct issuer ID',async t=>{
 const {make,proof}=await harness(t),s=make();const original=await prior(s,proof);
 const repeat=await s.authorizeRepeat(request({tabId:'tab'}));assert.equal(repeat.baseSemanticKey,original.semanticKey);assert.notEqual(repeat.semanticKey,original.semanticKey);
 assert.equal(repeat.baseline.basis,'authorized-occurrence');assert.equal(repeat.baseline.evidenceId,null);
 assert.equal((await s.authorizeRepeat(request({tabId:'tab'}))).bindingId,repeat.bindingId);
 assert.equal((await s.admit(args({bindingId:repeat.bindingId,operationId:'repeat'}))).admitted,true);
 await s.observe(args({bindingId:repeat.bindingId,evidenceId:proof(repeat,'confirmed',{outcomeId:'issuer-second'})}));
 assert.equal((await s.measure(args())).criteria[0].observedCount,2);
 assert.equal((await s.read(args())).bindings.binding.newOutcome.outcomeId,'issuer-original');
 const third=await s.authorizeRepeat(request({bindingId:repeat.bindingId,userInstructionRef:'user-message-3'}));
 await s.admit(args({bindingId:third.bindingId,operationId:'third'}));
 await s.observe(args({bindingId:third.bindingId,evidenceId:proof(third,'confirmed',{outcomeId:'issuer-original'})}));
 assert.equal((await s.measure(args())).criteria[0].observedCount,2);
});
test('same instruction cannot create new occurrence by changing task or replaying reference',async t=>{
 const {make,proof}=await harness(t),s=make();await prior(s,proof);const repeat=await s.authorizeRepeat(request());
 await setup(s,{taskId:'renamed',bindingId:'new-base',target:3});
 await assert.rejects(s.authorizeRepeat(request({taskId:'renamed',bindingId:'new-base'})),{code:'DIRECT_REPEAT_ALREADY_BOUND'});
 await assert.rejects(s.authorizeRepeat(request({reason:'Changed assertion'})),{code:'DIRECT_REPEAT_PROVENANCE_CONFLICT'});
 await s.close();const reopened=make();assert.equal((await reopened.authorizeRepeat(request())).bindingId,repeat.bindingId);
});
test('UNKNOWN deliberate repeat requires explicit acknowledgement and never invents new progress',async t=>{
 const {make,proof}=await harness(t),s=make(),original=await prior(s,proof,{unknown:true});
 await assert.rejects(s.authorizeRepeat(request()),{code:'DIRECT_REPEAT_UNCERTAINTY'});
 await assert.rejects(s.authorizeRepeat(request({acknowledgeUncertainty:true})),{code:'DIRECT_REPEAT_UNCERTAINTY'});
 const repeat=await s.authorizeRepeat(request({acknowledgeUncertainty:true,uncertaintyStatement:'User instructed a repeat knowing the earlier effect may have occurred.'}));
 await s.admit(args({bindingId:repeat.bindingId,operationId:'deliberate'}));
 const observed=await s.observe(args({bindingId:repeat.bindingId,evidenceId:proof(repeat,'confirmed',{outcomeId:'issuer-maybe-old'})}));
 assert.equal(observed.state.repeatAmbiguity,true);assert.equal((await s.measure(args())).criteria[0].observedCount,0);
 assert.equal((await s.admit(args({operationId:'original-retry'}))).reason,'UNKNOWN_EFFECT');
 await s.observe(args({evidenceId:proof(original,'absent')}));
 await s.observe(args({bindingId:repeat.bindingId,evidenceId:proof(repeat,'confirmed',{outcomeId:'issuer-maybe-old'})}));
 assert.equal((await s.measure(args())).criteria[0].observedCount,1);
});
test('repeat never bypasses target capacity or missing provenance, wrong owner or target',async t=>{
 const {make,proof}=await harness(t),s=make();await prior(s,proof,{target:1});
 for(const field of ['userInstructionRef','userInstructionQuote','reason'])assert.throws(()=>s.authorizeRepeat(request({[field]:''})));
 await assert.rejects(s.authorizeRepeat(request({ownerId:'other'})),{code:'DIRECT_OUTCOME_NOT_FOUND'});
 await setup(s,{bindingId:'other',subject:'different-target',target:1});await s.bindTab(args({bindingId:'other',tabId:'different'}));
 await assert.rejects(s.authorizeRepeat(request({tabId:'different'})),{code:'DIRECT_REPEAT_TARGET'});
 const b=await s.authorizeRepeat(request());assert.equal((await s.admit(args({bindingId:b.bindingId,operationId:'over-capacity'}))).reason,'TARGET_SATISFIED');
});


test('ambiguous confirmed repeat retains a target-capacity reservation',async t=>{
 const {make,proof}=await harness(t),s=make();await prior(s,proof,{unknown:true,target:2});
 const attested={acknowledgeUncertainty:true,uncertaintyStatement:'User accepts that the earlier attempt may have succeeded.'};
 const repeat=await s.authorizeRepeat(request(attested));await s.admit(args({bindingId:repeat.bindingId,operationId:'repeat'}));
 await s.observe(args({bindingId:repeat.bindingId,evidenceId:proof(repeat,'confirmed',{outcomeId:'ambiguous'})}));
 const another=await s.authorizeRepeat(request({...attested,userInstructionRef:'another-explicit-instruction'}));
 assert.equal((await s.admit(args({bindingId:another.bindingId,operationId:'too-many'}))).reason,'TARGET_CAPACITY');
});
test('legacy structured issuer evidence excludes same issuer despite changed occurrence outcome key',async t=>{
 const {createHash}=await import('node:crypto'),{make,proof,evidence}=await harness(t),s=make(),b=await prior(s,proof,{unknown:true});
 const host=(binding,outcomeId,validation,op)=>{
  const record=normalizeContractEvidence({kind:'external-confirmation',resourceKey:resource,confirmation:{effectKey:binding.semanticKey,status:'confirmed',outcomeId,prior:false},validation},{operationId:op,workItemId:'work',at:new Date(Date.now()+2000).toISOString()});
  evidence.set('owner:'+record.id,record);return record.id;
 };
 await s.observe(args({evidenceId:host(b,'legacy-subject-id',{adapter:'relay_browser',rawOutcomeId:'issuer-one'},'legacy')}));
 const repeat=await s.authorizeRepeat(request());await s.admit(args({bindingId:repeat.bindingId,operationId:'new-repeat'}));
 const issuerOutcomeKey=createHash('sha256').update(JSON.stringify([b.semanticKey,'issuer-one'])).digest('hex');
 await s.observe(args({bindingId:repeat.bindingId,evidenceId:host(repeat,'issuer:'+issuerOutcomeKey,{adapter:'relay_browser',rawOutcomeId:'issuer-one',issuerOutcomeKey},'new')}));
 assert.equal((await s.measure(args())).criteria[0].observedCount,1);
});


test('earlier uncertainty resolved as the same issuer clears repeat ambiguity without double-counting',async t=>{
 const {make,proof}=await harness(t),s=make(),original=await prior(s,proof,{unknown:true,target:2});
 const repeat=await s.authorizeRepeat(request({acknowledgeUncertainty:true,uncertaintyStatement:'Another occurrence was requested despite uncertain earlier effect.'}));
 await s.admit(args({bindingId:repeat.bindingId,operationId:'repeat'}));
 await s.observe(args({bindingId:repeat.bindingId,evidenceId:proof(repeat,'confirmed',{outcomeId:'same-issuer'})}));
 await s.observe(args({evidenceId:proof(original,'confirmed',{outcomeId:'same-issuer'})}));
 await s.observe(args({bindingId:repeat.bindingId,evidenceId:proof(repeat,'confirmed',{outcomeId:'same-issuer'})}));
 const m=await s.measure(args());assert.equal(m.criteria[0].repeatAmbiguities,0);assert.equal(m.criteria[0].observedCount,0);
 const task=await s.read(args());assert.equal(task.bindings[repeat.bindingId].newOutcome,null);
});
