import test from 'node:test';
import assert from 'node:assert/strict';
import {createModularCompletionController,modularOutcomeSchema,modularReviewPrompt} from '../lib/modular-completion.mjs';
const policy={version:2,modules:{verification:true,replanning:true}};
const snapshot={request:{text:'Repair repository; finish with a brief account.'},evidence:{records:[{id:'test-1',success:true,result:'Focused checks passed; coverage bounded.'}]}};
test('decision schema and prompt distinguish presentation from new correctness evidence',()=>{
 const schema=modularOutcomeSchema(snapshot),prompt=modularReviewPrompt(snapshot,{output:'Host audit'});
 assert.match(schema.properties.decision.description,/only presentation, wording, structure/);
 assert.match(prompt,/host audit report is accurate but not the requested brief summary/);
 assert.match(prompt,/never relabel unresolved correctness work as report-only/);
 assert.match(prompt,/unchanged candidate can have new evidence/);
});
for(const [decision,nextAction,responseOnly] of [
 ['revise_response','Replace the audit report with a brief account of already-observed changes and checks.',true],
 ['continue','Inspect the missing-account lookup and run a targeted assertion.',false]
])test('routes '+decision+' without inferring completion from a passing receipt',async()=>{
 const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,
 review:async()=>({decision,summary:'Bounded review',remaining:[nextAction],nextAction,evidenceRefs:['test-1'],blockers:[]})});
 const result=await c.beforeFinal({output:'Host audit'});
 assert.equal(result.continue,true);assert.equal(result.responseOnly,responseOnly);
 assert.match(result.prompt,responseOnly?/CORRECT THE FINAL REPORT ONLY/:/CONTINUE THE CURRENT DELEGATED TASK/);
 await assert.rejects(c.assertReady(),{code:'MODULAR_OUTCOME_INCOMPLETE'});
});
