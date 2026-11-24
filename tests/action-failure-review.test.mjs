import test from 'node:test';
import assert from 'node:assert/strict';
import {createActionFailureReview} from '../lib/action-failure-review.mjs';
import {toolResultEvent,nativeToolResultEvent} from '../lib/tool-outcomes.mjs';
const result=(tool,action,target,success)=>toolResultEvent({name:tool,arguments:{action,target}}, {success,contentItems:[]});
for (const [tool,action] of [['relay_browser','click'],['relay_workspace','write'],['relay_connections','call']]) {
  test(tool+' failure survives unrelated success and clears on confirmed retry',()=>{
    const review=createActionFailureReview();
    review.observe(result(tool,action,'first',false));
    review.observe(result(tool,action,'different',true));
    assert.equal(review.beforeFinal({output:'Completed.'}).continue,true);
    assert.throws(()=>review.beforeFinal({output:'Completed.'}),{code:'ACTION_FAILURE_UNREPORTED'});
    assert.equal(review.beforeFinal({output:tool+' '+action+' failed. An independent operation succeeded.'}),null);
    review.observe(result(tool,action,'first',true));
    assert.equal(review.pending(),false);
    assert.equal(review.beforeFinal({output:'Completed.'}),null);
  });
}
test('native nonzero command exit reaches the same failure review',()=>{
  const review=createActionFailureReview();
  review.observe(nativeToolResultEvent({type:'commandExecution',status:'completed',command:'check',exitCode:7}));
  assert.throws(()=>review.beforeFinal({output:'Passed.',remainingSteps:0}),/Codex command commandExecution failed/);
});