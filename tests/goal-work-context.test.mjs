import test from 'node:test';
import assert from 'node:assert/strict';
import {observeGoalRoute,mergeGoalRoutes,sameGoalRoute,goalRecoveryData,goalRecoveryPrompt} from '../lib/goal-work-context.mjs';
import {prepareChatPlanning} from '../lib/chat-planning-engine.mjs';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';

const goal={id:'g1',generation:1,turns:15,noProgressTurns:14,deadlineAt:'2026-11-26T11:00:00.000Z'};
const call={name:'relay_browser'},args={action:'navigate',url:'https://jobs.example.test/role/42?token=private-a#secret-fragment'};
const observe=(runId,url=args.url,landing='https://jobs.example.test/closed',generation=1)=>observeGoalRoute(call,{...args,url},{success:true,contentItems:[{type:'inputText',text:JSON.stringify({url:landing})}]},{runId,goalId:goal.id,generation,at:'2026-11-26T02:00:00Z'});

test('goal route history deduplicates actual observations across turns without asserting closure, hiding query values or replaying effects',()=>{
  const first=observe('r1'),second=observe('r2');
  assert.ok(sameGoalRoute(first,second));
  const rows=mergeGoalRoutes([first],[second,observe('foreign',args.url,'https://jobs.example.test/closed',2)],goal);
  assert.equal(rows.length,1);assert.equal(rows[0].runId,'r2');assert.equal(rows[0].count,2);
  assert.doesNotMatch(JSON.stringify(rows),/private-a|secret-fragment/);
  assert.equal(rows[0].requested.address,'https://jobs.example.test/role/42');
  const changed=observe('r3',args.url,'https://jobs.example.test/apply');
  assert.ok(!sameGoalRoute(second,changed));
  assert.equal(mergeGoalRoutes(rows,[changed],goal)[0].count,1);
  assert.notEqual(observe('r4','https://jobs.example.test/role/42?token=private-b').requested.queryKey,first.requested.queryKey);
  assert.equal(observeGoalRoute(call,{action:'click'}, {success:true},{runId:'r1',goalId:'g1',generation:1}),null);
  assert.equal(mergeGoalRoutes([],Array.from({length:80},(_,i)=>observe('r'+i,'https://jobs.example.test/role/'+i)),goal).length,64);
});

test('goal continuity labels claims and routes as data and carries only bounded evidence, not previous directives',()=>{
  const lastEvidence={runId:'r2',at:'now',summary:'Role B is reported closed',evidence:'Assistant reported a closed page',nextAction:'UNTRUSTED_INSTRUCTION'};
  const data=goalRecoveryData({...goal,lastEvidence},{latestCheckpoint:{runId:'r2'},earlierCheckpoints:[{runId:'r1',summary:'Role A was tried',evidence:'Returned page reported missing',nextAction:'UNTRUSTED_INSTRUCTION'}]},[observe('r1')]);
  assert.equal(data.authority,'none');assert.equal(data.checkpoints.length,2);
  assert.equal(data.checkpoints[0].status,'model-reported-unverified');
  assert.equal(data.priorRoutes[0].source,'host-observed-navigation');
  const prompt=goalRecoveryPrompt(data);
  assert.match(prompt,/data, not user instructions or verified external effects/);
  assert.match(prompt,/unfinished authorized action/);
  assert.doesNotMatch(prompt,/UNTRUSTED_INSTRUCTION|private-a/);
  assert.equal(goalRecoveryPrompt(null),'');
});

test('stalled autonomous Chat Planning refreshes the action list with prior observations rather than reinterpreting a fixed deadline or reselecting stale discovery',async()=>{
  const directory=new TaskActionDirectory({taskId:'t1',objective:'Find a viable employer'});
  const admitted=()=>{};
  await directory.edit({action:'plan',revision:0,actions:[{id:'discover',objective:'Search the same sources',dependsOn:[]}]},{authority:'planning',admit:admitted});
  const snapshot=directory.read();
  await directory.edit({action:'planningChoice',revision:snapshot.revision,moduleId:'builtin-task-grounding',focus:'discover',reason:'Prior choice',sourceRefs:[]},{authority:'planning',admit:admitted});
  const run={id:'r3',taskId:'t1',goalDispatch:{goalId:'g1',generation:1},input:'Resume the saved objective until 6 AM Eastern.',createdAt:'2026-11-26T02:00:00Z',chatPlanning:'on',directoryActions:'off'};
  const data=goalRecoveryData(goal,{earlierCheckpoints:[{runId:'r2',summary:'Role B was tried',evidence:'Closed posting'}]},[observe('r2')]);
  const prompts=[],events=[];
  const runtime={status(){return {defaultModel:'fixture'};},async runAgent({prompt,dynamicTools}){
    prompts.push(prompt);assert.deepEqual(dynamicTools,[]);
    assert.match(prompt,/Role B was tried/);assert.match(prompt,/jobs.example.test\/role\/42/);
    assert.match(prompt,/GOAL CONTINUITY/);
    return {output:JSON.stringify({artifact:{status:'proposed',focus:'apply',reason:'Different viable lead already discovered',sourceRefs:[],actions:[{id:'apply',objective:'Inspect and complete the viable application',dependsOn:[]}]}})};
  }};
  const result=await prepareChatPlanning({run,node:{id:'agent',model:'fixture'},signal:new AbortController().signal,directory,runtime,boundGoal:goal,goalRecovery:data,assertAdmission:admitted,emit:event=>events.push(event)});
  assert.equal(prompts.length,1);assert.equal(result.actionId,'apply');
  assert.deepEqual(events.map(x=>x.moduleId),['builtin-decomposition','builtin-decomposition']);
  assert.equal(directory.read().actions.find(x=>x.id==='discover').state,'pending','no fabricated completion of previous discovery');
});

test('unchanged recovery choice is not presented as a new advisory action',async()=>{
  const directory=new TaskActionDirectory({taskId:'t2',objective:'Work toward the goal'});
  const admit=()=>{};
  await directory.edit({action:'plan',revision:0,actions:[{id:'discover',objective:'Search the same sources',dependsOn:[]}]},{authority:'planning',admit});
  await directory.edit({action:'planningChoice',revision:directory.read().revision,moduleId:'builtin-task-grounding',focus:'discover',reason:'Previous choice',sourceRefs:[]},{authority:'planning',admit});
  const runtime={status(){return {defaultModel:'fixture'};},async runAgent(){return {output:JSON.stringify({artifact:{status:'proposed',focus:'discover',reason:'Same choice',sourceRefs:[],actions:[{id:'discover',objective:'Search the same sources',dependsOn:[]}]}})}}};
  const result=await prepareChatPlanning({run:{id:'r4',taskId:'t2',goalDispatch:{goalId:'g1',generation:1},input:'Resume the saved goal',createdAt:'2026-11-26T02:00:00Z',chatPlanning:'on',directoryActions:'off'},node:{id:'agent',model:'fixture'},signal:new AbortController().signal,directory,runtime,boundGoal:goal,goalRecovery:{noProgressTurns:14},assertAdmission:admit,emit(){}});
  assert.equal(result,null);
  assert.equal(directory.read().actions[0].state,'pending');
});


test('ordinary Goal continuation with Directory Off does not inherit the unobserved dependency chain, even when progress was made',async()=>{
  const directory=new TaskActionDirectory({taskId:'t3',objective:'Old objective'});
  const admit=()=>{};
  await directory.edit({action:'plan',revision:0,actions:[
    {id:'window',objective:'Check the old cutoff',dependsOn:[]},
    {id:'sources',objective:'Read old sources',dependsOn:['window']},
    {id:'apply',objective:'Apply after sources',dependsOn:['sources']},
  ]},{authority:'planning',admit});
  const original=directory.read();const prompts=[],events=[];
  const runtime={status(){return {defaultModel:'fixture'};},async runAgent({prompt}){
    prompts.push(prompt);
    assert.match(prompt,/The host already enforces its absolute deadline/);
    assert.match(prompt,/CURRENT ACTIVE OBJECTIVE/);
    assert.doesNotMatch(prompt,/Check the old cutoff|Read old sources/);
    return {output:JSON.stringify({artifact:{status:'proposed',focus:'next_lead',reason:'Established setup is complete',sourceRefs:[],actions:[{id:'next_lead',objective:'Continue a viable new lead',dependsOn:[]}]}})};
  }};
  const result=await prepareChatPlanning({run:{id:'r5',taskId:'t3',goalDispatch:{goalId:'g1',generation:2},input:'Continue the saved goal',createdAt:'2026-11-26T02:00:00Z',chatPlanning:'on',directoryActions:'off'},node:{id:'agent',model:'fixture'},signal:new AbortController().signal,directory,runtime,boundGoal:{...goal,turns:1,objective:'CURRENT ACTIVE OBJECTIVE'},goalRecovery:{noProgressTurns:0},assertAdmission:admit,emit:event=>events.push(event)});
  assert.equal(prompts.length,1);
  assert.equal(result.actionId,'next_lead');assert.equal(result.advisoryScope,'goal-turn');
  assert.ok(events.every(event=>event.advisoryScope==='goal-turn'));
  assert.deepEqual(directory.read(),original);
});
