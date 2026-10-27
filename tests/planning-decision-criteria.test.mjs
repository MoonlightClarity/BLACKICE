import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaskPlan, normalizeDecisionCriteria } from '../lib/task-plan.mjs';
import { applyPlanningEdits } from '../lib/planning-edits.mjs';
import { TASK_TOOL, TASK_TOOL_V6, TaskStateStore, TASK_SCHEMA_VERSION } from '../lib/task-state.mjs';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const steps=[{id:'review',title:'Evaluate the role as a real opportunity',kind:'action',status:'pending',
  parentId:null,dependsOn:[],doneWhen:'A considered recommendation lists verified gates, preferences and realistic gaps.'}];
const criteria=[
  {id:'employment',label:'W-2 employment',kind:'hard_gate',source:'user',priority:5,basis:'User requires W-2. If posting does not specify employment classification, investigate; do not reject by assumption.'},
  {id:'travel',label:'No mandatory travel',kind:'hard_gate',source:'user',priority:5,basis:'Disqualify explicit required travel, not silence about travel.'},
  {id:'pay',label:'Compensation viability',kind:'preference',source:'user',priority:5,basis:'Pay is important; no numeric minimum supplied. Unknown pay is not proof it is below a threshold.'},
  {id:'technical',label:'Deep specialist skills',kind:'substantial_skill',source:'employer',priority:4,basis:'Training requiring sustained expertise merits serious gap scrutiny; simple tools learned in days do not.'},
  {id:'wishlist',label:'Listed years of specific-domain experience',kind:'employer_wishlist',source:'employer',priority:2,basis:'The employer calls this required but has not demonstrated an unwaivable gate.'}
];
test('Planning preserves user hard gates separately from trainable gaps, wishes and preferences',()=>{
 const saved=normalizeTaskPlan({plan:{layout:'sequence',detail:'balanced',decisionCriteria:criteria},steps});
 assert.deepEqual(saved.plan.decisionCriteria,criteria);
 const updated=normalizeTaskPlan({plan:{layout:'sequence'},steps},{previous:{...saved,artifacts:[]}});
 assert.deepEqual(updated.plan.decisionCriteria,criteria,'normal plan edits preserve the authored rubric');
 assert.deepEqual(normalizeDecisionCriteria(null),[],'explicit null clears old classifications');
});
test('a job listing calling a qualification required is insufficient to hard-gate it',()=>{
 const wrong={id:'years',label:'Five years of product analytics',kind:'hard_gate',source:'employer',basis:'Job listing says required'};
 assert.throws(()=>normalizeDecisionCriteria([wrong]),/not automatically a hard gate/);
 assert.deepEqual(normalizeDecisionCriteria([{...wrong,kind:'employer_wishlist'}])[0].kind,'employer_wishlist');
 assert.throws(()=>normalizeDecisionCriteria([{...wrong,source:'analyst'}]),/analyst inference cannot become a hard gate/);
 const verified={...wrong,basis:'Official license mandate verified against current regulation.',verifiedNonNegotiable:true};
 assert.equal(normalizeDecisionCriteria([verified])[0].kind,'hard_gate');
});
test('Planning edits revise decision classification atomically without changing unrelated steps',()=>{
 const initial=normalizeTaskPlan({plan:{layout:'sequence',decisionCriteria:criteria},steps});
 const state={...initial,goal:'Find realistic job leads',artifacts:[],execution:null};
 const revision=applyPlanningEdits(state,{operations:[{type:'metadata',patch:{decisionCriteria:[
   {...criteria[2],kind:'preference',basis:'Pay is a major compass; no invented numeric minimum.'},
   {...criteria[3],kind:'trainable_skill',basis:'Actual listing only requires beginner SQL learned in days.'}
 ]}}]});
 assert.equal(revision.plan.decisionCriteria.length,2);
 assert.equal(revision.plan.decisionCriteria[1].kind,'trainable_skill');
 assert.deepEqual(revision.steps,initial.steps);
 assert.deepEqual(state.plan.decisionCriteria,criteria);
});
test('decision-criterion metadata is bounded and preserves author evidence without invented hard filters',()=>{
 const bad=[
  [{...criteria[0],priority:6}],
  [{...criteria[0],source:'fiction'}],
  [{...criteria[0],basis:''}],
  [{...criteria[0],id:'bad key'}],
  [criteria[0],criteria[0]],
  [{...criteria[0],kind:'must_match_everything'}]
 ];
 for(const value of bad)assert.throws(()=>normalizeDecisionCriteria(value));
 assert.throws(()=>normalizeDecisionCriteria(Array.from({length:25},(_,index)=>({...criteria[0],id:'x'+index}))),/at most 24/);
});
test('classified decision policy persists across task store restart and conflict-checked editing',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-decision-policy-')),cwd=path.join(directory,'work');
  await mkdir(cwd);
  let store=await new TaskStateStore({dataDir:directory}).init();
  t.after(async()=>{await store.close().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  const initial=await store.ensure({taskId:'decisions-task',runId:'first',cwd,goal:'Rank credible job leads',defaultPlan:true});
  const options={expectedRevision:initial.revision,runId:'first',nodeId:'agent',schemaVersion:TASK_SCHEMA_VERSION};
  const planned=await store.setPlan(initial.taskId,{steps,plan:{layout:'sequence',decisionCriteria:criteria}},options);
  assert.equal(planned.plan.decisionCriteria.length,5);
  const changed=await store.editPlan(planned.taskId,{
    operations:[{type:'metadata',patch:{decisionCriteria:criteria.map(item=>item.id==='technical'?{...item,kind:'trainable_skill',basis:'This posting actually asks for basic data queries.'}:item)}}]
  },{expectedRevision:planned.revision,source:'human'});
  assert.equal(changed.plan.decisionCriteria.find(item=>item.id==='technical').kind,'trainable_skill');
  await assert.rejects(store.editPlan(changed.taskId,{
    operations:[{type:'metadata',patch:{decisionCriteria:[]}}]
  },{expectedRevision:planned.revision,source:'human'}),/revision changed/i);
  await store.close();
  store=await new TaskStateStore({dataDir:directory}).init();
  const restored=await store.get(changed.taskId);
  assert.deepEqual(restored.plan.decisionCriteria,changed.plan.decisionCriteria);
  assert.equal(restored.steps[0].title,'Evaluate the role as a real opportunity');
});

test('current Planning catalog exposes classifications without mutating saved older schemas',()=>{
 const spec=TASK_TOOL.inputSchema.properties.plan.properties.decisionCriteria;
 assert.ok(spec);
 assert.equal(spec.anyOf[0].items.properties.kind.enum.includes('employer_wishlist'),true);
 assert.equal(TASK_TOOL_V6.inputSchema.properties.plan.properties.decisionCriteria,undefined);
 const edit=TASK_TOOL.inputSchema.properties.operations.items.properties.patch.properties.decisionCriteria;
 assert.ok(edit);
});