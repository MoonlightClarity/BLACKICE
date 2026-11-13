import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOutcomeChecks,outcomeAssessmentConflicts,OUTCOME_RECONCILIATION_INSTRUCTIONS} from '../lib/outcome-reconciliation.mjs';
import {createModularCompletionController,modularOutcomeSchema,modularReviewPrompt} from '../lib/modular-completion.mjs';
const policy={version:2,modules:{verification:true}};
const snapshot=()=>({policy,request:{text:'Repair the parser. Preserve public outputs. Return an array instead only when requested.'},
 evidence:{records:[{id:'baseline',result:{contentItems:[{type:'inputText',text:'export function parse(x) { return {value:x}; }'}]}},
 {id:'current',result:{contentItems:[{type:'inputText',text:'parse(1) returned undefined; expected original value field'}]}}]}});
const row=()=>({obligation:'Preserve parse result value',basis:'existing-interface',contractQuote:'return {value:x}',contractRefs:['evidence-0001'],
 resultRefs:['evidence-0002'],disposition:'contradicted',material:true,reason:'Current parser discards the existing return value.'});
const options={resolveRef:x=>({'evidence-0001':'baseline','evidence-0002':'current'}[x]||x),admittedRefs:['user-request','baseline','current']};
const assessment=patch=>({decision:'respond',summary:'Done',remaining:[],nextAction:'',evidenceRefs:['user-request','evidence-0001','evidence-0002'],blockers:[],...patch});
test('grounded existing interface contradiction is identified without certifying model conclusion',()=>{
 const normalized=normalizeOutcomeChecks([row()],snapshot(),options);
 assert.equal(normalized[0].contractQuoteFound,true);assert.equal(normalized[0].authority,'none');assert.equal(normalized[0].verified,false);
 assert.equal(outcomeAssessmentConflicts(normalized).length,1);
});
test('uncertainty, authorized change, invented obligation and unadmitted or metadata refs do not create a completion gate',()=>{
 const cases=[
 {...row(),disposition:'unresolved'},
 {...row(),basis:'authorized-change'},
 {...row(),basis:'uncertain'},
 {...row(),contractQuote:'The result must contain a checksum'},
 {...row(),contractRefs:['invented']},
 {...row(),resultRefs:['invented']},
 {...row(),resultRefs:['candidate']},
 {...row(),material:false}
 ];
 for(const value of cases)assert.equal(outcomeAssessmentConflicts(normalizeOutcomeChecks([value],snapshot(),options)).length,0);
 assert.equal(outcomeAssessmentConflicts(normalizeOutcomeChecks([row()],snapshot(),{...options,metadataOnlyRefs:['current']})).length,0);
});
test('request grounding is literal evidence, not a new documentation requirement',()=>{
 const check={...row(),basis:'user-request',contractQuote:'Preserve public outputs.',contractRefs:['user-request']};
 assert.equal(outcomeAssessmentConflicts(normalizeOutcomeChecks([check],snapshot(),options)).length,1);
 assert.equal(normalizeOutcomeChecks([{...check,contractQuote:'All inputs must be nonempty'}],snapshot(),options)[0].contractQuoteFound,false);
 assert.match(OUTCOME_RECONCILIATION_INSTRUCTIONS,/Missing documentation.*is not failure/);
});
test('bounded optional rows preserve no-op compatibility',async()=>{
 const schema=modularOutcomeSchema(snapshot());assert.ok(schema.properties.outcomeChecks);assert.ok(!schema.required.includes('outcomeChecks'));
 for(const outcomeChecks of [undefined,null,'bad',{large:'x'.repeat(5000)},[],[{...row(),disposition:'unresolved'}],[{...row(),basis:'authorized-change'}]]){
  let calls=0;const updates=[];
  const c=createModularCompletionController({policy,getSnapshot:snapshot,onUpdate:x=>updates.push(x),review:async()=>{calls++;return assessment({outcomeChecks});}});
  assert.equal(await c.beforeFinal({output:'done'}),null);assert.equal(calls,1);assert.equal((await c.assertReady()).ready,true);
  assert.ok(JSON.stringify(updates).length<5000);
 }
 assert.equal(normalizeOutcomeChecks(Array.from({length:30},row),snapshot(),options).length,6);
});
test('resolved concern does not accept contradictory original outcome; correction reuses same assessment loop',async()=>{
 let calls=0;const updates=[];
 const c=createModularCompletionController({policy,getSnapshot:snapshot,onUpdate:x=>updates.push(x),review:async({repair})=>{
  calls++;if(calls===1)return assessment({outcomeChecks:[row()],concerns:[]});
  assert.equal(repair.assessmentConflicts.length,1);
  assert.match(modularReviewPrompt(snapshot(),{output:'done'},repair),/ASSESSMENT CONSISTENCY CORRECTION ONLY/);
  return assessment({decision:'continue',summary:'Public output still needs repair',remaining:['restore output'],nextAction:'Repair the affected return contract',outcomeChecks:[row()]});
 }});
 assert.equal((await c.beforeFinal({output:'done'})).responseOnly,false);assert.equal(calls,2);
 assert.equal(updates.find(x=>x.validation)?.validation.assessmentConflicts.length,1);
 await assert.rejects(c.assertReady(),{code:'MODULAR_OUTCOME_INCOMPLETE'});
});
test('correction may recognize a user-authorized change without replaying task effects',async()=>{
 let calls=0;const c=createModularCompletionController({policy,getSnapshot:snapshot,review:async()=>{
  calls++;return assessment({outcomeChecks:[{...row(),basis:calls===1?'existing-interface':'authorized-change'}]});
 }});
 assert.equal(await c.beforeFinal({output:'done'}),null);assert.equal(calls,2);assert.equal((await c.assertReady()).ready,true);
});
test('latest user amendment anchors an authorized interface change',()=>{
 const s=snapshot();s.directions=[{text:'Change parse to return a number rather than the old object.'}];
 const amended={...row(),basis:'authorized-change',contractQuote:'Change parse to return a number rather than the old object.',contractRefs:['user-request']};
 const normalized=normalizeOutcomeChecks([amended],s,options);
 assert.equal(normalized[0].contractQuoteFound,true);assert.equal(outcomeAssessmentConflicts(normalized).length,0);
});
test('assessment correction can retract its own misread without replaying effects',async()=>{
 let calls=0;const c=createModularCompletionController({policy,getSnapshot:snapshot,review:async({repair})=>{
  calls++;if(calls===1)return assessment({outcomeChecks:[row()]});
  assert.equal(repair.assessmentConflicts.length,1);
  return assessment({outcomeChecks:[{...row(),disposition:'supported',reason:'Prior interpretation misread the observed output.'}]});
 }});
 assert.equal(await c.beforeFinal({output:'done'}),null);assert.equal(calls,2);assert.equal((await c.assertReady()).ready,true);
});
test('persistent internally contradictory review stops bounded correction without automatic task replay',async()=>{
 let calls=0;const c=createModularCompletionController({policy,getSnapshot:snapshot,review:async()=>{calls++;return assessment({outcomeChecks:[row()]});}});
 await assert.rejects(c.beforeFinal({output:'done'}),{code:'MODULAR_REVIEW_CONFLICT'});assert.equal(calls,3);
});
