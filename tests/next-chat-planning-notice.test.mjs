import test from 'node:test';
import assert from 'node:assert/strict';
import {planningProgressForRun,mergeChatRunUpdate} from '../public/next/chat/model.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';
const run=(status,state,settled=true)=>({id:'notice-run',status,settled,input:'Task',workflow:{nodes:[]},nodes:{},events:[],
  responseCycle:{requestId:'saved-plan',cycleId:'saved-cycle',state,stage:'plan',summary:'Saved diagnostic'}});
test('failed planning never creates a persistent attention notice, without deleting evidence',()=>{
  for(const status of ['completed','failed','cancelled','blocked','running']){
    const value=run(status,'failed',status!=='running'),before=structuredClone(value);
    const result=planningProgressForRun(value);
    assert.equal(result.showNotice,false);assert.equal(result.label,'');
    assert.deepEqual(value,before);assert.equal(result.requestId,'saved-plan');
    assert.equal(projectFamily({runs:[value]}).runs[0].responseCycle.state,'failed');
    assert.equal(mergeChatRunUpdate({id:value.id},value).responseCycle.state,'failed');
  }
});
test('settled historical cycles do not appear as current notifications',()=>{
  for(const status of ['completed','failed','cancelled'])
    for(const state of ['completed','executing','needs_evidence','needs_user_input','running'])
      assert.equal(planningProgressForRun(run(status,state)).showNotice,false,status+' '+state);
});
test('current planning progress and actionable review/input remain available',()=>{
  assert.equal(planningProgressForRun(run('running','running',false)).showNotice,true);
  assert.equal(planningProgressForRun(run('running','executing',false)).showNotice,true);
  assert.equal(planningProgressForRun(run('completed','paused_after_plan')).showNotice,true);
  assert.equal(planningProgressForRun(run('blocked','needs_user_input')).showNotice,true);
  assert.equal(planningProgressForRun(run('completed','paused_after_plan')).requestId,'saved-plan');
});
