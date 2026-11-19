import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationHandoff} from '../lib/engine.mjs';

const event=(type,text,rest={})=>({nodeId:'agent',data:{type,text,...rest}});
const direct={id:'original',taskId:'case-one',input:'Apply until 6 AM EST.',events:[
  event('message','It is already 6 AM EST.'),
  event('steer','Accepted correction',{accepted:true}),
  event('steer','Rejected instruction',{accepted:false}),
  event('steer','Legacy or queued direction'),
]};
const goal={id:'goal-step',taskId:'case-one',input:'Machine Goal instruction.',goalDispatch:{goalId:'case-one'}};
const auto={id:'auto-step',taskId:'case-two',input:'Machine Autonomy instruction.',autonomyDispatch:{sessionId:'auto'}};
const retry={id:'retry',taskId:'case-one',input:goal.input,userRequestRunId:goal.id,retryOf:goal.id,nodes:{agent:{output:'Intermediate receipt claim.'}}};
const otherRetry={id:'other-retry',taskId:'case-one',input:'Retry of an unavailable source.',retryOf:'missing'};

test('saved provider handoff attributes direct, generated, retried and reported text',()=>{
  const text=conversationHandoff([direct,goal,auto,retry,otherRetry],'agent');
  assert.match(text,/TURN original \(task case-one\)\nUSER: Apply until 6 AM EST\./);
  assert.match(text,/ASSISTANT REPORT: It is already 6 AM EST\./);
  assert.match(text,/USER DIRECTION: Accepted correction/);
  assert.match(text,/USER DIRECTION \(acceptance not recorded\): Legacy or queued direction/);
  assert.doesNotMatch(text,/Rejected instruction/);
  assert.match(text,/TURN goal-step \(task case-one\)\nGOAL DISPATCH: Machine Goal instruction/);
  assert.match(text,/TURN auto-step \(task case-two\)\nAUTONOMY DISPATCH: Machine Autonomy instruction/);
  assert.match(text,/TURN retry \(task case-one\) \/ input source goal-step\nGOAL DISPATCH: Machine Goal instruction/);
  assert.match(text,/ASSISTANT REPORT: Intermediate receipt claim/);
  assert.match(text,/input source missing\nRETRIED INPUT: Retry of an unavailable source/);
  assert.doesNotMatch(text,/USER: Machine|USER: Retry of/);
});

test('handoff remains bounded and retains known end references',()=>{
  const text=conversationHandoff([direct,{id:'large',taskId:'case-one',input:'IGNORED_MIDDLE'.repeat(1000)},goal],'agent',500);
  assert.ok(text.length<=500);
  assert.match(text,/Earlier saved conversation shortened/);
  assert.match(text,/TURN original/);
  assert.match(text,/TURN goal-step \(task case-one\)\nGOAL DISPATCH: Machine Goal instruction/);
});
