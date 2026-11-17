import test from 'node:test';
import assert from 'node:assert/strict';
import {createModularCompletionController,MODULAR_OUTCOME_SCHEMA,reviewModularOutcome} from '../lib/modular-completion.mjs';
const policy={version:2,modules:{anti_overalignment:true}};
const snapshot={request:{id:'user-request',text:'Apply to up to three roles.'},policy,evidence:{records:[]}};
const instance={decision:'continue',summary:'No new applications were submitted.',remaining:['Screen and apply to suitable roles'],nextAction:'Research a suitable role.',evidenceRefs:['candidate'],blockers:[]};
const envelope=properties=>({type:'object',additionalProperties:false,required:['decision','summary','remaining','nextAction','evidenceRefs','blockers'],properties});
test('instance-in-schema envelope preserves actual continue decision without extra model calls',async()=>{
 const updates=[];let calls=0;const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,onUpdate:r=>updates.push(r),review:async()=>{calls++;return envelope(instance);}});
 const continuation=await c.beforeFinal({output:'No applications submitted.'});assert.equal(calls,1);assert.equal(continuation.continue,true);
 assert.equal(updates.find(r=>r.status==='normalized-format').assessment.properties.decision,'continue');
 assert.equal(updates.at(-1).decision,'continue');
});
test('actual schema descriptors are never guessed into an assessment',async()=>{
 const updates=[];let calls=0;const candidate={output:'No applications submitted. Research is incomplete.'};
 const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,onUpdate:r=>updates.push(r),review:async()=>{calls++;return structuredClone(MODULAR_OUTCOME_SCHEMA);}});
 assert.equal(await c.beforeFinal(candidate),null);assert.equal(calls,3);assert.equal(candidate.output,'No applications submitted. Research is incomplete.');
 assert.equal(updates.some(r=>r.status==='normalized-format'),false);
 const result=await c.assertReady();assert.equal(result.reviewUnavailable,true);assert.equal(result.assessment.decision,'unreviewed');assert.equal(result.assessment.evidenceRefs,undefined);
});
test('wrapper invalid citations cannot establish completion or invent task actions',async()=>{
 const updates=[];let calls=0,returns=0;const candidate={output:'Submission status is unknown.'};
 const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,onUpdate:r=>updates.push(r),onReturn:()=>returns++,review:async()=>{calls++;return envelope({...instance,decision:'respond',remaining:[],nextAction:'',evidenceRefs:['evidence-0056']});}});
 assert.equal(await c.beforeFinal(candidate),null);assert.equal(calls,3);assert.equal(returns,0);
 assert.equal(updates.filter(r=>r.validation?.invalidReferences.includes('evidence-0056')).length,3);
 assert.equal(updates.some(r=>r.status==='sufficient'),false);assert.equal((await c.assertReady()).reviewUnavailable,true);
});

test('synthetic instance wrapper is normalized without accepting its unavailable references',async()=>{
 const {readFile}=await import('node:fs/promises');
 const captured=JSON.parse(await readFile(new URL('./fixtures/modular-review/schema-envelope-synthetic.json',import.meta.url),'utf8'));
 const updates=[];let calls=0;const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,onUpdate:r=>updates.push(r),review:async()=>{calls++;return structuredClone(captured.assessment);}});
 assert.equal(await c.beforeFinal({output:'No applications submitted.'}),null);assert.equal(calls,3);
 const normalized=updates.filter(r=>r.status==='normalized-format');assert.equal(normalized.length,3);assert.deepEqual(normalized[0].assessment,captured.assessment);
 const rejected=updates.filter(r=>r.validation?.invalidReferences);assert.equal(rejected.length,3);
 assert.deepEqual(rejected[0].assessment.evidenceRefs,captured.assessment.properties.evidenceRefs);
 assert.equal((await c.assertReady()).assessment.decision,'unreviewed');
});
