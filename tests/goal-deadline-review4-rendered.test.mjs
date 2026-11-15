import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createChatFrame} from '../public/next/chat/render.mjs';
import {createGoalControls} from '../public/next/chat/goals.mjs';

function rendered(t) {
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount);
  const type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperties(prototype,{
    childNodes:{get(){return this.children;}},
    lastChild:{get(){return this.children.at(-1)||null;}},
    type:{get:type.get,set(value){this.setAttribute('type',value);}}
  });
  prototype.showModal=function(){this.open=true;};
  prototype.close=function(){this.open=false;};
  return createChatFrame(dom.mount);
}

test('rendered Goal editor shows DST gap/fold errors in goalError, preserves draft, and submits a valid local deadline once',async t=>{
  const previousTZ=process.env.TZ;
  process.env.TZ='America/New_York';
  t.after(()=>{if(previousTZ===undefined)delete process.env.TZ;else process.env.TZ=previousTZ;});
  const view=rendered(t),starts=[];
  const controls=createGoalControls({
    view,api:()=>assert.fail('New Goal must not POST during validation.'),
    getContext:()=>({draft:'Review the contained test fixture.'}),
    onStart:async(goal,options)=>{starts.push({goal,options});return{run:{id:'fixture-run'}};}
  });
  t.after(()=>controls.destroy());
  await view.goalToggle.dispatch('click');
  assert.equal(view.goalDialog.open,true);
  view.goalInput.value='Complete a synthetic goal before a deadline.';
  view.goalLimit.value='';
  for(const [value,pattern] of [
    ['2026-03-08T02:30:00',/does not exist/i],
    ['2026-11-01T01:30:00',/ambiguous/i]
  ]){
    view.goalDeadlineInput.value=value;
    await assert.doesNotReject(view.goalForm.dispatch('submit'),'Invalid time must be caught by the rendered submit handler');
    assert.equal(starts.length,0,'No model or Goal admission after invalid input');
    assert.equal(view.goalDialog.open,true,'Dialog remains open for correction');
    assert.equal(view.goalError.hidden,false,'Validation error is visible in Goal editor');
    assert.match(view.goalError.textContent,pattern);
    assert.equal(view.goalInput.value,'Complete a synthetic goal before a deadline.');
  }
  view.goalDeadlineInput.value='2026-11-15T06:00:00';
  await assert.doesNotReject(view.goalForm.dispatch('submit'));
  assert.equal(starts.length,1,'Exactly one authorized synthetic Goal start after correction');
  assert.deepEqual(starts[0],{
    goal:{
      objective:'Complete a synthetic goal before a deadline.',
      maxTurns:null,
      deadlineAt:'2026-11-15T11:00:00.000Z',
      deadlineTimeZone:'America/New_York'
    },
    options:{consumeDraft:false}
  });
  assert.equal(view.goalDialog.open,false);
});
