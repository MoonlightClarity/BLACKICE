import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
 normalizeTaskPlan, normalizeDecisionCriteria, normalizeMetacognitionFrame,
 DECISION_CRITERION_KINDS, DECISION_CRITERION_SOURCES, DECISION_EVIDENCE_STATES,
 METACOGNITION_FIELDS
} from '../lib/task-plan.mjs';
import { applyPlanningEdits } from '../lib/planning-edits.mjs';
import { TaskStateStore, TASK_TOOL, TASK_TOOL_V6, TASK_TOOL_V7, TASK_TOOL_V8, TASK_TOOL_V9, TASK_INSTRUCTIONS,
 TASK_INSTRUCTIONS_V6, TASK_INSTRUCTIONS_V7, TASK_INSTRUCTIONS_V8, TASK_INSTRUCTIONS_V9, TASK_SCHEMA_VERSION,
 taskToolForVersion, taskInstructionsForVersion } from '../lib/task-state.mjs';

const action={id:'evaluate',title:'Deliver a practically useful recommendation',
  kind:'action',parentId:null,dependsOn:[],status:'pending',
  doneWhen:'The next decision is justified by the real objective and observed constraints.'};
const frame={
  outcome:'Choose the debugging fix that stops incorrect output in production.',
  keyUncertainty:'Does the reproduction fail in the parser or the renderer?',
  nextProbe:'Run the same input against each component independently.',
  goodEnough:'The failing case and one related transfer case pass with no regressions.',
  reassessWhen:'Two isolated attempts contradict the proposed cause.',
  observation:'The first patch changed styling but did not repair the parser result.',
  lesson:'Test the earliest data transformation before adding UI patches.'
};
const criteria=[
  {id:'user-no-destruction',label:'Do not delete customer records',
   source:'user',kind:'hard_gate',priority:5,evidenceStatus:'confirmed',
   basis:'Explicit constraint on the production repair.'},
  {id:'vendor-wants-framework',label:'Use vendor X framework',
   source:'external',kind:'stated_requirement',priority:2,evidenceStatus:'reported',
   basis:'Vendor calls it required but no actual dependency has been demonstrated.'},
  {id:'api-gap',label:'Learn a new SDK to connect the service',
   source:'analyst',kind:'adaptable_gap',priority:3,evidenceStatus:'inferred',
   basis:'The API surface is small and similar to existing integrations.'},
  {id:'unknown-root',label:'What causes the error?',
   source:'analyst',kind:'unverified',priority:4,evidenceStatus:'unknown',
   basis:'Logs do not yet establish where corruption first occurs.'}
];
test('the general-purpose Planning rubric does not assume jobs, employers, or perfect matches',()=>{
  for(const kind of ['hard_gate','material_barrier','adaptable_gap','stated_requirement','preference','unverified'])
    assert.equal(DECISION_CRITERION_KINDS.includes(kind),true);
  assert.equal(DECISION_CRITERION_SOURCES.includes('external'),true);
  assert.equal(DECISION_EVIDENCE_STATES.includes('unknown'),true);
  assert.deepEqual(normalizeDecisionCriteria(criteria),criteria);
  const frameCopy=normalizeMetacognitionFrame(frame);
  assert.deepEqual(frameCopy,frame);
  assert.ok(METACOGNITION_FIELDS.every(key=>Object.hasOwn(frameCopy,key)));
});
test('external requirements are claims; only verified non-negotiability creates an external hard gate',()=>{
  const claim=criteria[1];
  assert.equal(normalizeDecisionCriteria([claim])[0].kind,'stated_requirement');
  assert.throws(()=>normalizeDecisionCriteria([{...claim,kind:'hard_gate'}]),/not automatically a hard gate/);
  assert.throws(()=>normalizeDecisionCriteria([{...claim,kind:'hard_gate',verifiedNonNegotiable:false}]),/not automatically a hard gate/);
  assert.equal(normalizeDecisionCriteria([{...claim,kind:'hard_gate',verifiedNonNegotiable:true,
    evidenceStatus:'confirmed',basis:'A documented legal requirement applies to this interface.'}])[0].kind,'hard_gate');
  assert.throws(()=>normalizeDecisionCriteria([{...claim,kind:'hard_gate',source:'analyst',verifiedNonNegotiable:true}]),/analyst inference/);
  assert.throws(()=>normalizeDecisionCriteria([{...claim,evidenceStatus:'guesswork'}]),/Evidence status/);
});
test('a judgment frame is optional, proportional, bounded, and can be cleared explicitly',()=>{
  assert.equal(normalizeMetacognitionFrame(null),null);
  assert.equal(normalizeMetacognitionFrame({}),null);
  assert.equal(normalizeMetacognitionFrame({nextProbe:'   '}),null);
  assert.deepEqual(normalizeMetacognitionFrame({outcome:'  Ship a useful solution  '}),{outcome:'Ship a useful solution'});
  for(const malformed of [{privateReasoning:'expose this'},'check everything',{outcome:42},{outcome:'a'.repeat(701)}])
    assert.throws(()=>normalizeMetacognitionFrame(malformed));
  const plan=normalizeTaskPlan({plan:{layout:'sequence',metacognition:frame},steps:[action]});
  const retained=normalizeTaskPlan({plan:{layout:'sequence'},steps:[action]},{previous:plan});
  assert.deepEqual(retained.plan.metacognition,frame);
  const cleared=normalizeTaskPlan({plan:{layout:'sequence',metacognition:null},steps:[action]},{previous:retained});
  assert.equal(Object.hasOwn(cleared.plan,'metacognition'),false);
  assert.deepEqual(cleared.steps,plan.steps);
});
test('metacognitive edits preserve original work and classify assumptions independently',()=>{
  const initial=normalizeTaskPlan({plan:{layout:'sequence',decisionCriteria:criteria,metacognition:frame},steps:[action]});
  const state={...initial,goal:'Repair a data conversion bug',artifacts:[]};
  const edited=applyPlanningEdits(state,{operations:[{type:'metadata',patch:{
    decisionCriteria:criteria.map(item=>item.id==='vendor-wants-framework'
      ?{...item,kind:'preference',basis:'Vendor style is preferable but not a dependency.'}:item),
    metacognition:{...frame,observation:'An isolated reproduction shows the parser corrupts the value.'}
  }}]});
  assert.equal(edited.plan.decisionCriteria.find(item=>item.id==='vendor-wants-framework').kind,'preference');
  assert.match(edited.plan.metacognition.observation,/parser/);
  assert.equal(state.plan.decisionCriteria[1].kind,'stated_requirement');
  assert.deepEqual(edited.steps,initial.steps);
});
test('saved judgment survives restart with CAS and no fabricated plan-progress evidence',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-metacognition-'));
  const cwd=path.join(dir,'work');await mkdir(cwd);
  let store=await new TaskStateStore({dataDir:dir}).init();
  t.after(async()=>{await store.close().catch(()=>{});await rm(dir,{recursive:true,force:true});});
  const first=await store.ensure({taskId:'architecture-review',runId:'first-run',cwd,
    goal:'Choose a system design with realistic tradeoffs.',defaultPlan:true});
  const planned=await store.setPlan(first.taskId,
    {plan:{layout:'sequence',decisionCriteria:criteria,metacognition:frame},steps:[action]},
    {expectedRevision:first.revision,runId:'first-run',nodeId:'reviewer',schemaVersion:TASK_SCHEMA_VERSION});
  assert.equal(planned.steps[0].status,'pending');
  const updated=await store.editPlan(first.taskId,
    {operations:[{type:'metadata',patch:{metacognition:{...frame,
      lesson:'The parser was the cause. Prioritize data checks in other pipelines too.'}}}]},
    {expectedRevision:planned.revision,source:'human'});
  await assert.rejects(store.editPlan(first.taskId,
    {operations:[{type:'metadata',patch:{metacognition:null}}]},
    {expectedRevision:planned.revision,source:'human'}),/revision changed/i);
  await store.close();store=await new TaskStateStore({dataDir:dir}).init();
  const recovered=await store.get(first.taskId);
  assert.deepEqual(recovered.plan.metacognition,updated.plan.metacognition);
  assert.deepEqual(recovered.plan.decisionCriteria,criteria);
  assert.equal(recovered.steps[0].status,'pending');
});
test('current model instructions are cross-domain, while older tool versions remain byte compatible',()=>{
  const meta=TASK_TOOL.inputSchema.properties.plan.properties.metacognition.anyOf[0];
  assert.equal(meta.additionalProperties,false);
  assert.ok(meta.properties.goodEnough&&meta.properties.nextProbe&&meta.properties.lesson);
  assert.equal(TASK_TOOL.inputSchema.properties.operations.items.properties.patch.properties.metacognition.anyOf[0].type,'object');
  assert.equal(TASK_SCHEMA_VERSION,10);
  assert.equal(TASK_TOOL_V6.inputSchema.properties.plan.properties.metacognition,undefined);
  assert.equal(TASK_TOOL_V7.inputSchema.properties.plan.properties.metacognition,undefined);
  assert.equal(TASK_TOOL_V7.inputSchema.properties.plan.properties.decisionCriteria,undefined);
  assert.equal(taskToolForVersion(7),TASK_TOOL_V7);
  assert.equal(taskToolForVersion(8),TASK_TOOL_V8);
  assert.equal(taskToolForVersion(9),TASK_TOOL_V9);
  assert.equal(taskToolForVersion(10),TASK_TOOL);
  assert.equal(TASK_TOOL_V8.inputSchema.properties.plan.properties.facts,undefined);
  assert.ok(TASK_TOOL.inputSchema.properties.plan.properties.facts);
  assert.equal(taskInstructionsForVersion(7),TASK_INSTRUCTIONS_V7);
  assert.equal(taskInstructionsForVersion(8),TASK_INSTRUCTIONS_V8);
  assert.equal(taskInstructionsForVersion(9),TASK_INSTRUCTIONS_V9);
  assert.equal(taskInstructionsForVersion(10),TASK_INSTRUCTIONS);
  assert.equal(TASK_INSTRUCTIONS_V7,TASK_INSTRUCTIONS_V6);
  assert.ok(TASK_INSTRUCTIONS.includes('PRACTICAL JUDGMENT AND METACOGNITION'));
  assert.ok(TASK_INSTRUCTIONS.includes('material_barrier'));
  assert.ok(TASK_INSTRUCTIONS.includes('adaptable_gap'));
  assert.ok(TASK_INSTRUCTIONS.includes('goodEnough'));
  assert.ok(!TASK_INSTRUCTIONS.includes('perfect résumé match'));
  assert.ok(TASK_INSTRUCTIONS_V8.startsWith(TASK_INSTRUCTIONS_V6),'the cached version eight instructions retain their historical prefix');
  assert.ok(TASK_INSTRUCTIONS.includes('CHRONOLOGICAL RECURSIVE WORK'));
  assert.ok(TASK_INSTRUCTIONS.includes('keep only one eligible leaf active'));
  assert.ok(!TASK_INSTRUCTIONS.includes('Do not wait for the coordinator or another independent branch unless your saved prerequisites require its result.'),'current instructions must not retain a conflicting parallel execution rule');
  assert.equal(TASK_INSTRUCTIONS.split('\n').length>7,true);
});
