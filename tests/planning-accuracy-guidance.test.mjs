import test from 'node:test';
import assert from 'node:assert/strict';
import { planningModulePrompt, planningModuleOutputSchema, planningStructureGuide, planningFormatDiagnostic, validatePlanningModuleResponse } from '../lib/planning-browser-runtime.mjs';
import { responseCycleTemplate, responseCycleStage } from '../public/response-cycle-model.mjs';
import { TASK_ACCURACY_FIELDS, validateTaskAccuracy } from '../public/task-viability-model.mjs';
const accuracy = { mode:'qualitative', tolerance:'Assess only the supplied fictional alternatives.', decisionThreshold:'Choose the alternative meeting the stated constraint.', evidenceNeeded:'Supplied fictional alternatives.', consequence:'An unsupported recommendation would fail the requested comparison.', unknownPolicy:'omit', stopWhen:'All supplied alternatives have been compared.' };
const attempt = {node:{kind:'plan'},pipelineVersion:2,template:responseCycleTemplate('plan'),sources:[{id:'cycle:execution-contract:test',kind:'source',text:'{"taskSchemaVersion":14,"contractVersion":2}'}],challenges:[]};
function body() { return { values:{},grounding:[],openQuestions:[],challengeResponses:[],checks:responseCycleStage('plan').checks.map(c=>({id:c.id,assessment:'supported',sourceIds:[],note:'The fictional comparison is bounded.'})),subproblems:[],childResults:[],contract:{contractVersion:2,goal:'Compare supplied fictional alternatives.',criteria:[{id:'comparison',kind:'judgment',label:'Supported comparison',description:'Compare the supplied alternatives against the requested constraint.',accuracy}],workItems:[{id:'compare',title:'Compare alternatives',objective:'Use the supplied evidence to compare alternatives.',owner:'agent',resourceKeys:['context:supplied-alternatives'],effects:['observe'],dependsOn:[],criterionIds:['comparison']}],instructions:[]} }; }
test('mode-only accuracy remains invalid with specific missing fields and no inferred defaults',()=>{
  const input={mode:'qualitative'}; assert.throws(()=>validateTaskAccuracy(input),error=>{ assert.equal(error.code,'TASK_VIABILITY_INVALID');for(const field of TASK_ACCURACY_FIELDS.slice(1))assert.ok(error.message.includes(field));return true;});assert.deepEqual(input,{mode:'qualitative'});
  assert.throws(()=>validateTaskAccuracy({...accuracy,confidence:.9}),/Unexpected: confidence/);
  assert.equal(validateTaskAccuracy(null),undefined);assert.deepEqual(validateTaskAccuracy(accuracy),accuracy);
});
test('canonical nesting guide is derived from this attempt schema and cannot contaminate another attempt',()=>{
  const schema=planningModuleOutputSchema(attempt),guide=planningStructureGuide(attempt);
  assert.deepEqual(guide.response,schema.required);assert.deepEqual(guide['response.contract'],['contractVersion','goal','criteria','workItems','instructions']);
  for(const name of ['criteria','workItems','instructions'])assert.deepEqual(guide['response.contract.'+name+'[]'],schema.properties.contract.properties[name].items.required);
  assert.deepEqual(guide.accuracy.completeObjectFields,TASK_ACCURACY_FIELDS);
  guide.accuracy.completeObjectFields.push('confidence');assert.deepEqual(planningStructureGuide(attempt).accuracy.completeObjectFields,TASK_ACCURACY_FIELDS);
  const legacy={...attempt,sources:[]};assert.equal(planningStructureGuide(legacy)['response.contract'],undefined);
});
test('accuracy and misplaced canonical fields get bounded explicit diagnostics and a prominent repair instruction',()=>{
  const invalid=body();invalid.contract.criteria[0].accuracy={mode:'qualitative'};invalid.contract.resourceKey=null;delete invalid.contract.workItems;
  const output=JSON.stringify(invalid);let diagnostic;
  assert.throws(()=>validatePlanningModuleResponse(attempt,output),error=>{diagnostic=planningFormatDiagnostic(attempt,output,error);return true});
  assert.ok(diagnostic.issues.some(i=>i.path==='response.contract.criteria[0].accuracy'&&i.message.includes('stopWhen')));
  assert.ok(diagnostic.issues.some(i=>i.path==='response.contract'&&i.message.includes('workItems')));
  const repair={...attempt,formatRepair:{previousAttemptId:'failed',previousOutput:output,diagnostic}};
  const prompt=planningModulePrompt(repair);assert.ok(prompt.startsWith('REPAIR THE REJECTED RESPONSE'));
  assert.match(prompt,/A mode-only object is invalid/);assert.match(prompt,/Preserve any inherited target in full/);
  assert.ok(prompt.indexOf(JSON.stringify(diagnostic))<prompt.indexOf('Captured module declaration'));
  const data=JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n')+2));
  assert.equal(data.formatRepair.previousOutput,output);assert.deepEqual(data.formatRepair.diagnostic,diagnostic);
  assert.ok(Object.keys(data.formatRepair).indexOf('diagnostic')>Object.keys(data.formatRepair).indexOf('previousOutput'));
  assert.match(data.repairReminder,/Never copy the rejected object unchanged/);
  const accepted=validatePlanningModuleResponse(attempt,JSON.stringify(body()));assert.deepEqual(accepted.contract.criteria[0].accuracy,accuracy);
});
