import test from 'node:test';
import assert from 'node:assert/strict';
import { planningDetail, validatePlanningOutline, isProspectivePlanningAction } from '../lib/planning-policy.mjs';
import { planningModeDetail, normalizePlanningMode, planningGuardrailsRequired } from '../public/planning-mode.mjs';

const action = () => ({
  id:'subtotal',kind:'action',status:'pending',parentId:null,
  title:'Check the saved invoice subtotal',
  result:'The independently recomputed subtotal and any discrepancy.',
  note:'Add the supplied item prices using decimal arithmetic and compare the sum with the stored subtotal.',
  doneWhen:'The computed subtotal matches the stored value, or the exact discrepancy is reported.'
});
const state = steps => ({plan:{detail:'compact',layout:'sequence'},steps});
const modes=['ontology','off','on','auto','maximal','forced','advisory'];
const validate=(next,previous=state([]),extra={})=>validatePlanningOutline(next,{mode:'on',previous,executionGuardrails:true,...extra});

test('retired modes preserve saved detail hints without restoring automatic depth requirements',()=>{
  for(const mode of modes)for(const hint of [undefined,'compact','balanced','detailed']){
    assert.equal(normalizePlanningMode(mode),'off');
    assert.equal(planningGuardrailsRequired(mode),false);
    assert.equal(planningDetail(mode,hint),hint);
    assert.equal(planningModeDetail(mode,hint),hint);
  }
});

test('prospective action classification remains a pure description of saved work',()=>{
  assert.equal(isProspectivePlanningAction(action()),true);
  for(const value of [null,{...action(),kind:'sequence'},{...action(),status:'done'},{...action(),status:'skipped'},
    {...action(),note:undefined},{...action(),result:''},{...action(),doneWhen:''},{...action(),note:action().doneWhen}]){
    const before=structuredClone(value);
    assert.equal(isProspectivePlanningAction(value),false);
    assert.deepEqual(value,before);
  }
});

test('old automatic flags cannot impose a prospective gate or rewrite current or historical records',()=>{
  const sparse={id:'work',kind:'action',title:'Analyze the task',status:'active',doneWhen:'The analysis is complete.'};
  const completed={...action(),status:'done',evidence:'The supplied prices total 12.25; the saved subtotal is 12.50.'};
  const changed={...completed,note:'Read the saved number.',doneWhen:'The field contains a number.',result:'Observed 12.50.'};
  for(const mode of modes)for(const steps of [[sparse],[completed],[changed],[{...action(),status:'active'},{...sparse,id:'other'}]]){
    const next=state(steps),before=structuredClone(next),previous=state([action()]),prior=structuredClone(previous);
    assert.equal(validate(next,previous,{mode}),next);
    assert.deepEqual(next,before,'Retired validation does not mutate authored content or infer success.');
    assert.deepEqual(previous,prior,'Historical evidence remains unchanged.');
  }
});

test('one concrete atomic action is valid without invented uncertainty or more steps',()=>{
  const next=state([action()]);
  assert.equal(validate(next),next);
  assert.equal(next.plan.detail,'compact');
  assert.equal(next.steps.length,1);
  assert.equal(next.plan.metacognition,undefined);
});

test('real discrepancies and unavailable evidence remain explicit saved outcomes',()=>{
  const previous=state([action()]);
  const complete={...action(),status:'done',evidence:'The independent sum is 0.25 below the saved value. No invoice was changed.'};
  assert.equal(validate(state([complete]),previous).steps[0].evidence,complete.evidence);
  const blocked={...action(),status:'blocked',blockedReason:'The supplied export omits item prices; the subtotal cannot be recomputed.'};
  assert.equal(validate(state([blocked]),previous).steps[0].blockedReason,blocked.blockedReason);
});

test('unchanged historical completions retain their original evidence and procedures',()=>{
  const old={id:'old',kind:'action',title:'Earlier answer',status:'done',doneWhen:'The earlier request was answered.',evidence:'Earlier observation.'};
  const next=validate(state([structuredClone(old),action()]),state([old]));
  assert.deepEqual(next.steps[0],old);
  assert.equal(next.steps[1].status,'pending');
});

test('human edits, automatic flags and ownership scopes cannot force unrelated groups to rewrite their work',()=>{
  const other={id:'other-work',parentId:'other',kind:'action',status:'pending',title:'Existing owner work',doneWhen:'The other owner records its result.'};
  for(const source of ['human','agent']){
    const next=state([{id:'mine',kind:'sequence',parentId:null},{...action(),parentId:'mine'},{id:'other',kind:'sequence',parentId:null},other]),before=structuredClone(next);
    assert.equal(validate(next,state([]),{scopeStepId:'mine',source}),next);
    assert.deepEqual(next,before);
  }
});

test('minimal completion preserves expected output, procedure and criterion without requiring replay',()=>{
  const previous=state([action()]),saved=structuredClone(previous),evidence='Independent addition gives 12.25, which is 0.25 below 12.50.';
  const next=validate(state([{...previous.steps[0],status:'done',evidence}]),previous);
  assert.equal(next.steps[0].status,'done');
  assert.equal(next.steps[0].evidence,evidence);
  for(const field of ['result','note','doneWhen'])assert.equal(next.steps[0][field],saved.steps[0][field]);
  assert.deepEqual(previous,saved);
});
