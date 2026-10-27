import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDetail, validatePlanningOutline, isProspectivePlanningAction } from '../lib/planning-policy.mjs';
import { planningModeDetail } from '../public/planning-mode.mjs';

const action = () => ({
  id:'subtotal',kind:'action',status:'pending',parentId:null,
  title:'Check the saved invoice subtotal',
  result:'The independently recomputed subtotal and any discrepancy.',
  note:'Add the supplied item prices using decimal arithmetic and compare the sum with the stored subtotal.',
  doneWhen:'The computed subtotal matches the stored value, or the exact discrepancy is reported.'
});
const state = steps => ({plan:{detail:'compact',layout:'sequence'},steps});
const on = (next, previous=state([]), extra={}) => validatePlanningOutline(next,{mode:'on',previous,...extra});

test('On and historical aliases apply maximal substantive detail; Off preserves saved hints',()=>{
  for(const mode of ['on','auto','maximal'])for(const hint of [undefined,'compact','balanced','detailed']){
    assert.equal(planningDetail(mode,hint),'detailed');
    assert.equal(planningModeDetail(mode,hint),'detailed');
  }
  assert.equal(planningDetail('off','compact'),'compact');
  assert.equal(planningDetail('off',undefined),undefined);
});

test('a generic action without its prospective procedure cannot open Planning On',()=>{
  const sparse={id:'work',kind:'action',title:'Analyze the task',status:'pending',doneWhen:'The analysis is complete.'};
  assert.throws(()=>on(state([sparse])),{code:'TASK_PLAN_DEPTH_REQUIRED'});
  const exactRepeat={...action(),note:action().doneWhen};
  assert.throws(()=>on(state([exactRepeat])),{code:'TASK_PLAN_DEPTH_REQUIRED'});
});

test('one concrete atomic action is valid without invented uncertainty or more steps',()=>{
  const next=state([action()]);
  assert.equal(on(next),next);
  assert.equal(next.plan.detail,'detailed');
  assert.equal(next.steps.length,1);
  assert.equal(next.plan.metacognition,undefined);
});

test('a comparison result cannot be invented in the same mutation as its prospective test',()=>{
  const finished={...action(),status:'done',evidence:'The supplied prices total 12.25; the saved subtotal is 12.50, a discrepancy of 0.25.'};
  assert.throws(()=>on(state([finished])),{code:'TASK_PLAN_PROSPECTIVE_REQUIRED'});
  const previous=on(state([action()]));
  assert.equal(on(state([finished]),previous).steps[0].status,'done');
});

test('a changed acceptance criterion must be saved before the revised action can complete',()=>{
  const previous=on(state([action()]));
  const changed={...action(),status:'done',doneWhen:'The stored number exists.',
    evidence:'The field contains 12.50.'};
  assert.throws(()=>on(state([changed]),previous),{code:'TASK_PLAN_PROSPECTIVE_REQUIRED'});
  const revised=on(state([{...changed,status:'pending',evidence:undefined}]),previous);
  assert.equal(on(state([changed]),revised).steps[0].evidence,'The field contains 12.50.');
});

test('a literal promise or criterion is not an observed result',()=>{
  const previous=on(state([action()]));
  for(const field of ['title','result','note','doneWhen'])
    assert.throws(()=>on(state([{...action(),status:'done',evidence:action()[field]}]),previous),
      {code:'TASK_PLAN_OBSERVATION_REQUIRED'});
});

test('real discrepancies may be recorded without requiring a perfect result',()=>{
  const previous=on(state([action()]));
  const complete={...action(),status:'done',evidence:'The independent sum is 0.25 below the saved value. The mismatch is reported; no invoice was changed.'};
  assert.equal(on(state([complete]),previous).steps[0].status,'done');
  const blocked={...action(),status:'blocked',blockedReason:'The supplied export omits item prices; the subtotal cannot be recomputed.'};
  assert.equal(on(state([blocked]),previous).steps[0].status,'blocked');
});

test('unchanged historical completions retain their original evidence and procedures',()=>{
  const old={id:'old',kind:'action',title:'Earlier answer',status:'done',doneWhen:'The earlier request was answered.',evidence:'Earlier observation.'};
  const previous=state([old]);
  const next=on(state([structuredClone(old),action()]),previous);
  assert.deepEqual(next.steps[0],old);
  assert.equal(next.steps[1].status,'pending');
});

test('human edits and Off do not inherit automatic On requirements',()=>{
  const sparse=state([{id:'note',kind:'action',title:'A personal reminder',status:'pending',doneWhen:'Read it later.'}]);
  assert.equal(validatePlanningOutline(sparse,{mode:'off'}),sparse);
  assert.equal(validatePlanningOutline(sparse,{mode:'on',source:'human'}),sparse);
  assert.equal(validatePlanningOutline(sparse,{}),sparse);
});

test('a worker cannot force unrelated ownership groups to rewrite their work',()=>{
  const other={id:'other-work',parentId:'other',kind:'action',status:'pending',title:'Existing owner work',doneWhen:'The other owner records its result.'};
  const next=state([{id:'mine',kind:'sequence',parentId:null},{...action(),parentId:'mine'},
    {id:'other',kind:'sequence',parentId:null},other]);
  assert.equal(on(next,state([]),{scopeStepId:'mine'}),next);
  assert.deepEqual(next.steps.at(-1),other);
});

test('unrelated legacy open work survives without satisfying current admission',()=>{
  const legacy={id:'later',kind:'action',status:'pending',title:'Older work',doneWhen:'Its old criterion is met.'};
  const previous=state([legacy]);
  const next=on(state([structuredClone(legacy),action()]),previous);
  assert.deepEqual(next.steps[0],legacy);
  assert.equal(isProspectivePlanningAction(next.steps[0]),false);
  assert.equal(isProspectivePlanningAction(next.steps[1]),true);
  assert.throws(()=>on(state([{...legacy,status:'active'},action()]),previous),{code:'TASK_PLAN_DEPTH_REQUIRED'});
});

test('a cosmetic title correction does not invalidate an already performed work contract',()=>{
  const previous=on(state([action()]));
  const corrected={...action(),title:'Reconcile the invoice subtotal',status:'done',
    evidence:'The item prices sum to 12.25; the saved value of 12.50 differs by 0.25.'};
  assert.equal(on(state([corrected]),previous).steps[0].title,corrected.title);
});
