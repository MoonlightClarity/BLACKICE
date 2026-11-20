import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatExecutionReview,explicitChatAction} from '../lib/chat-execution-review.mjs';
const action='Send the prepared form.';
const partial='The form fields are visible. I haven’t yet filled or sent it.';
const good={type:'tool.result',tool:'relay_browser',action:'snapshot',callId:'fresh',success:true};
const setup=(input=action,canContinue=()=>true)=>createChatExecutionReview({input,canContinue});
test('explicit user action detection errs on the side of ordinary responses',()=>{
  const positives = [
    action, 'Please apply to jobs. Stop at three.', 'Can you send the prepared note?', 'Rename the downloaded file.',
    'Send the draft to the specified recipient. Do not edit it.',
    'Create the fixture file in the workspace. Do not contact anyone.',
    'Create the file without uploading it; do not use outside accounts.',
    'Edit the existing local file. If you find errors, report them separately.',
    'Rename the file named "notes.txt". Leave all other files alone.',
  ];
  const negatives = [
    '"Send the prepared form."', '> Send the prepared form.', 'Explain: send the prepared form.',
    'Draft an email and tell me how to send it.', 'Resume the previous task.', 'Send it again.',
    'Send the form but don\u2019t submit it.', 'Send this before 6 AM.', 'How do I send it?',
    'If the owner approves it, send the form.', 'Send the form only when the owner approves.',
    'Send the form if the owner approves.', 'Send the form. Actually, do not send it.',
    'Create the file. Do not create it after all.', 'Send the form. Only send it if the owner approves.',
    'The previous user said: send the prepared form.', 'Here is a fictional prompt:\n> Create the result file.',
  ];
  for (const input of positives) assert(explicitChatAction(input),input);
  for (const input of negatives) assert(!explicitChatAction(input),input);
});
test('a same-turn receipt and explicit incomplete answer allow only one review',()=>{
  const review=setup();
  review.started({callId:'fresh',name:'relay_browser',arguments:{action:'snapshot'}});
  review.observe(good);
  assert.equal(review.beforeFinal({output:partial}).continue,true);
  assert.equal(review.beforeFinal({output:partial}),null);
});
test('no evidence, unsuccessful/unknown effects, steering and blockers never retry',()=>{
  for(const event of [null,{...good,success:false}, {...good,action:'click'}, {...good,action:'fill',success:false},
      {type:'native.write.uncertain'}, {type:'steer'}, {type:'item',item:{type:'commandExecution'}}]){
    const review=setup(); if(event){review.observe(good);review.observe(event);}
    assert.equal(review.beforeFinal({output:partial}),null,JSON.stringify(event));
  }
  const pending=setup();pending.observe(good);pending.started({callId:'unterminated'});assert.equal(pending.beforeFinal({output:partial}),null);
  const dropped=setup();dropped.observe(good);dropped.started({callId:'opaque',namespace:'mcp'});assert.equal(dropped.beforeFinal({output:partial}),null);
  const review=setup();review.observe(good);
  for(const output of ['All done.','I haven’t sent it because I need your permission.','I haven’t sent it because the required file is missing.','> I haven’t sent it.','Would you like me to send it?'])
    assert.equal(review.beforeFinal({output}),null,output);
  assert.equal(review.beforeFinal({output:partial,signal:AbortSignal.abort()}),null);
  const ended=setup(action,()=>false);ended.observe(good);assert.equal(ended.beforeFinal({output:partial}),null);
});

test('empty browser inventory does not justify an unfinished final, even in a compound sentence',()=>{
  const request='Apply to one job for me: Circana Senior Product Manager, AI Evaluation & Quality. Use the employer site for this posting only. Submit the ordinary application and verify the result.';
  const answer='I couldn\u2019t complete the application in this turn. The contained browser is available, but I did not reach the Circana posting or submit an application, so there is no submission result to verify.';
  const tabs={...good,action:'tabs'};
  const ready=()=>{
    const review=setup(request);
    review.started({callId:'fresh',name:'relay_browser',arguments:{action:'tabs'}});
    review.observe(tabs);
    return review;
  };
  const review=ready();
  assert.equal(review.beforeFinal({output:answer}).continue,true);
  assert.equal(review.beforeFinal({output:answer}),null);
  assert.equal(ready().beforeFinal({output:'I did not reach the Circana posting or submit an application.'}).continue,true);
  for(const reason of ['The site requires you to sign in.','Required approval is missing.','The deadline expired.','I could not complete the application because the browser is unavailable.']){
    assert.equal(ready().beforeFinal({output:answer+' '+reason}),null,reason);
  }
  assert.equal(ready().beforeFinal({output:'I did not reach the Circana posting. I can submit later.'}),null);
  const uncertain=ready();
  uncertain.started({callId:'maybe',name:'relay_browser',arguments:{action:'click'}});
  assert.equal(uncertain.beforeFinal({output:answer}),null);
});
