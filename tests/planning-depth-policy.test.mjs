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

test('the observed result-as-finding payload gets precise recovery and can complete without changing its work definition',()=>{
  // Representative of the actual native exact-edit completion failure: the
  // work and checks were recorded, but result was rewritten as a past finding.
  const planned={
    id:'correct_notice',kind:'action',status:'active',parentId:null,
    title:'Replace the typo in notice.txt and verify the byte-level scope',
    note:'Inspect only the target directory and notice.txt; record the original bytes and directory entries, replace the one exact ASCII phrase, then compare the result against the original with only that phrase substituted.',
    doneWhen:'The exact phrase occurs once before editing and zero times afterward; the resulting bytes equal the original bytes with only that phrase replaced; directory entries are unchanged.',
    result:'notice.txt contains the requested correction, with every other byte unchanged and no directory entries added, removed, or renamed.'
  };
  const evidence="Exactly one ASCII occurrence of 'teh meeting' was found at byte offset 19. The same-length replacement matched the expected bytes on read-back; the file remained 73 bytes and the directory entries were unchanged.";
  const previous=on(state([planned]));
  const saved=structuredClone(previous);
  const attempted=state([{...planned,status:'done',
    result:'notice.txt was corrected in place; the directory contents remained unchanged.',evidence}]);
  const rejected=structuredClone(attempted);
  assert.throws(()=>on(attempted,previous),error=>{
    assert.equal(error.code,'TASK_PLAN_PROSPECTIVE_REQUIRED');
    assert.match(error.message,/prospective fields changed: result\./);
    assert.match(error.message,/result is the expected output/);
    assert.match(error.message,/actual findings and checks in evidence, not result/);
    assert.match(error.message,/omit them from the step call/);
    assert.match(error.message,/Do not repeat completed work solely to correct this payload/);
    return true;
  });
  assert.deepEqual(previous,saved,'Rejected completion preserves the saved prospective definition.');
  assert.deepEqual(attempted,rejected,'Validation does not rewrite the rejected payload.');
  // The task-state handler merges this minimal completion update into the
  // saved action; correcting it requires no change to the performed work.
  const completion={status:'done',evidence};
  const accepted=on(state([{...previous.steps[0],...completion}]),previous);
  assert.equal(accepted.steps[0].status,'done');
  assert.equal(accepted.steps[0].evidence,evidence);
  for(const field of ['result','note','doneWhen'])
    assert.equal(accepted.steps[0][field],saved.steps[0][field]);
});

test('procedure and criterion rewrites still fail and name the actual changed fields',()=>{
  const previous=on(state([action()]));
  const replacements={
    note:'Read only the stored subtotal without independently summing the item prices.',
    doneWhen:'The stored subtotal field contains a number.'
  };
  for(const field of ['note','doneWhen']){
    const changed={...action(),status:'done',[field]:replacements[field],evidence:'The stored field contains 12.50.'};
    assert.throws(()=>on(state([changed]),previous),error=>{
      assert.equal(error.code,'TASK_PLAN_PROSPECTIVE_REQUIRED');
      assert.ok(error.message.includes('prospective fields changed: '+field+'.'));
      assert.match(error.message,/save the revised unfinished action before performing and completing that revised work/);
      return true;
    });
  }
  const both={...action(),...replacements,status:'done',evidence:'The stored field contains 12.50.'};
  assert.throws(()=>on(state([both]),previous),error=>{
    assert.equal(error.code,'TASK_PLAN_PROSPECTIVE_REQUIRED');
    assert.match(error.message,/prospective fields changed: note, doneWhen\./);
    return true;
  });
});

test('explicitly repeated identical prospective fields are accepted on completion',()=>{
  const previous=on(state([action()]));
  const completed={...action(),status:'done',
    result:previous.steps[0].result,note:previous.steps[0].note,doneWhen:previous.steps[0].doneWhen,
    evidence:'Independent addition gives 12.25, which is 0.25 below the stored subtotal of 12.50.'};
  const accepted=on(state([completed]),previous);
  assert.equal(accepted.steps[0].status,'done');
  assert.equal(accepted.steps[0].evidence,completed.evidence);
});

test('new or incomplete saved definitions still require prospective work instead of completion-payload recovery',()=>{
  const completed={...action(),status:'done',evidence:'Independent addition gives 12.25; the stored value is 12.50.'};
  for(const previous of [state([]),state([{...action(),note:undefined}])]){
    assert.throws(()=>on(state([completed]),previous),error=>{
      assert.equal(error.code,'TASK_PLAN_PROSPECTIVE_REQUIRED');
      assert.match(error.message,/no prospective definition was saved for/);
      assert.match(error.message,/while the action is unfinished, then perform that work/);
      assert.doesNotMatch(error.message,/omit them from the step call/);
      return true;
    });
  }
});
