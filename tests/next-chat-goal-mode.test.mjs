import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {projectConversationGoal,conversationGoalStatus,chatHeaderStatus} from '../public/next/chat/model.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';
import {createChatFrame,paintIndex} from '../public/next/chat/render.mjs';
import {createGoalControls,parseGoalCommand,goalPresentation,updateConversationGoal} from '../public/next/chat/goals.mjs';
import {submitChat} from '../public/next/chat/send.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function fixture(t){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount);
  const type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperties(prototype,{childNodes:{get(){return this.children;}},lastChild:{get(){return this.children.at(-1)||null;}},type:{get:type.get,set(value){this.setAttribute('type',value);}}});
  prototype.showModal=function(){this.open=true;};prototype.close=function(){this.open=false;};
  const view=createChatFrame(dom.mount);
  return {dom,view};
}
const savedGoal=(changes={})=>({id:'goal-one',revision:2,objective:'Finish the implementation and verify it.',status:'active',turns:2,maxTurns:null,currentRunId:'run-one',...changes});

test('/goal commands are explicit and literal objectives preserve their full text',()=>{
  assert.deepEqual(parseGoalCommand('/goal'),{action:'status'});
  assert.deepEqual(parseGoalCommand(' /goal status '),{action:'status'});
  assert.deepEqual(parseGoalCommand('/goal pause'),{action:'pause'});
  assert.deepEqual(parseGoalCommand('/goal resume'),{action:'resume'});
  assert.deepEqual(parseGoalCommand('/goal continue'),{action:'resume'});
  assert.deepEqual(parseGoalCommand('/goal clear'),{action:'clear'});
  assert.deepEqual(parseGoalCommand('/goal -- pause'),{action:'set',objective:'pause'});
  assert.deepEqual(parseGoalCommand('/goal Build the UI\nand verify keyboard controls.'),{action:'set',objective:'Build the UI\nand verify keyboard controls.'});
  assert.equal(parseGoalCommand('/goals'),null);
  assert.equal(parseGoalCommand('Explain /goal'),null);
  assert.throws(()=>parseGoalCommand('/goal --'),/objective/);
});

test('goal lifecycle is distinct from an actually running turn',()=>{
  assert.equal(goalPresentation(savedGoal()).label,'Ready to continue');
  assert.equal(goalPresentation(savedGoal(),{running:true}).label,'Running');
  assert.equal(goalPresentation(savedGoal({status:'paused'})).label,'Paused');
  assert.equal(goalPresentation(savedGoal({status:'paused'}),{running:true}).label,'Pausing after this turn');
  assert.equal(goalPresentation(savedGoal({status:'completed'}),{running:true}).label,'Completed');
  assert.equal(goalPresentation(savedGoal()).progress,'2 turns · No turn limit');
  assert.equal(goalPresentation(savedGoal({maxTurns:8})).progress,'2 turns / 8');
  assert.equal(goalPresentation(savedGoal({status:'budget_exhausted'})).canResume,true);
  assert.equal(goalPresentation(savedGoal({status:'interrupted'})).canResume,true);
  assert.equal(goalPresentation(savedGoal({status:'interrupted'})).label,'Interrupted');
  assert.equal(goalPresentation(savedGoal({running:false}),{running:true}).label,'Ready to continue');
  assert.equal(goalPresentation(null),null);
});

test('goal edits and controls use one revision-checked conversation endpoint',async()=>{
  const calls=[],api=async(route,method,body)=>{calls.push({route,method,body});return{goal:savedGoal({revision:3,status:'paused'})};};
  await updateConversationGoal({api,conversationId:'chat/one',goal:savedGoal(),action:'pause',executionOptions:{model:'different-model'}});
  assert.equal(calls.length,1);assert.equal(calls[0].route,'/api/conversations/chat%2Fone/goal');
  assert.equal(calls[0].body.expectedRevision,2);assert.equal(calls[0].body.model,undefined);
  assert.match(calls[0].body.requestId,/^goal_/);
  await updateConversationGoal({api,conversationId:'chat/one',goal:savedGoal(),action:'set',objective:' Next outcome ',maxTurns:null,executionOptions:{model:'chosen-model'}});
  assert.equal(calls[1].body.objective,'Next outcome');assert.equal(calls[1].body.maxTurns,null);
  assert.equal(calls[1].body.model,'chosen-model');
  await assert.rejects(updateConversationGoal({api,conversationId:'new',action:'set',objective:'Go'}),/Start a conversation/);
  await assert.rejects(updateConversationGoal({api,conversationId:'one',action:'set',objective:'Go',maxTurns:0}),/positive whole/);
});

test('a new Goal is admitted with the initial run, with no attach-after-start race',async()=>{
  const calls=[],goal={objective:'Make every test pass',maxTurns:null};
  const result=await submitChat({api:async(route,method,body)=>{calls.push({route,body});return route==='/api/workflows'?body:{run:{id:'first',taskId:'first',status:'running'}};},
    runs:[],task:goal.objective,goal,model:'fixture',cwd:'C:\\fixture',planningMode:'off'});
  assert.deepEqual(calls.map(c=>c.route),['/api/workflows','/api/runs']);
  assert.deepEqual(calls[1].body.input.goal,goal);assert.notEqual(calls[1].body.input.goal,goal);
  assert.equal(result.run.id,'first');
  calls[1].body.input.goal.objective='Changed copy';
  assert.equal(goal.objective,'Make every test pass');
});

test('switching conversations discards late reads and preserves the exact owner',async t=>{
  const {view}=fixture(t),first=deferred(),second=deferred(),calls=[];
  let context={runId:'run-two'};
  const controls=createGoalControls({view,api:route=>{calls.push(route);return route.includes('/one/')?first.promise:second.promise;},getContext:()=>context,onStart:()=>{}});
  t.after(()=>controls.destroy());
  controls.update({conversationId:'one'});controls.update({conversationId:'two'});
  second.resolve({goal:savedGoal({id:'goal-two',objective:'Only this conversation',currentRunId:'run-two'})});await tick();
  first.resolve({goal:savedGoal({objective:'Stale first conversation'})});await tick();
  assert.equal(view.goalObjective.textContent,'Only this conversation');
  assert.equal(calls.length,2);
  controls.handleEvent({type:'goal.updated',data:{conversationId:'one',goal:savedGoal({revision:99})}});
  assert.equal(view.goalObjective.textContent,'Only this conversation');
  controls.update({conversationId:'new'});assert.equal(view.goalCard.hidden,true);
});

test('pause results invalidate an in-flight read and never start another run',async t=>{
  const {view}=fixture(t),read=deferred(),calls=[],followed=[];
  const controls=createGoalControls({view,api:async(route,method,body)=>{
    if(method==='GET')return read.promise;
    calls.push(body);return{goal:savedGoal({status:'paused',revision:4,lastReason:'Paused by user.'})};
  },getContext:()=>({runId:'run-one'}),onStart:()=>assert.fail('must not start'),onResult:result=>followed.push(result)});
  t.after(()=>controls.destroy());
  controls.update({conversationId:'one'});
  controls.handleEvent({type:'goal.updated',data:{conversationId:'one',goal:savedGoal({revision:3})}});
  await controls.command({action:'pause'});
  read.resolve({goal:savedGoal({status:'active',revision:2})});await tick();
  assert.equal(calls.length,1);assert.equal(calls[0].action,'pause');assert.equal(calls[0].expectedRevision,3);
  assert.equal(view.goalStatus.textContent,'Paused');assert.equal(view.goalPause.hidden,true);assert.equal(view.goalResume.hidden,false);
  assert.equal(followed.length,1);assert.equal(followed[0].run,undefined);
});

test('goal events follow a new run in the same conversation and ignore stale revisions',async t=>{
  const {view}=fixture(t),followed=[];
  const controls=createGoalControls({view,api:async()=>({goal:null}),getContext:()=>({runId:'run-one'}),onStart:()=>{},
    onResult:(result,owner)=>followed.push({result,owner})});
  t.after(()=>controls.destroy());controls.update({conversationId:'one'});await tick();
  controls.handleEvent({type:'goal.updated',data:{conversationId:'one',goal:savedGoal({revision:4,currentRunId:'run-two',running:true})}});
  assert.equal(followed.length,1);assert.equal(followed[0].owner,'one');assert.equal(followed[0].result.run.id,'run-two');
  assert.equal(view.goalStatus.textContent,'Running');
  controls.handleEvent({type:'goal.updated',data:{conversationId:'one',goal:savedGoal({revision:2,objective:'old'})}});
  assert.equal(view.goalObjective.textContent,savedGoal().objective);assert.equal(followed.length,1);
});

test('the Goal editor starts one new goal and keeps unrelated composer text',async t=>{
  const {view}=fixture(t),starts=[];
  const controls=createGoalControls({view,api:()=>assert.fail('new goal uses initial run'),getContext:()=>({draft:'Unsent draft'}),
    onStart:async(goal,options)=>{starts.push({goal,options});return{run:{id:'created'}};}});
  t.after(()=>controls.destroy());
  await view.goalToggle.dispatch('click');
  assert.equal(view.goalDialog.open,true);assert.equal(view.goalInput.value,'Unsent draft');
  view.goalInput.value='Deliver the full feature';view.goalLimit.value='';
  await view.goalForm.dispatch('submit');
  assert.equal(starts.length,1);assert.deepEqual(starts[0],{goal:{objective:'Deliver the full feature',maxTurns:null},options:{consumeDraft:false}});
  assert.equal(view.goalDialog.open,false);
  await controls.command({action:'set',objective:'Finish the task'});
  assert.equal(starts.length,2);assert.equal(starts[1].options.consumeDraft,true);
});

test('editing a paused goal preserves its lifecycle; invalid limits never reach the server',async t=>{
  const {view}=fixture(t),posts=[];
  const goal=savedGoal({status:'paused',maxTurns:12});
  const controls=createGoalControls({view,api:async(route,method,body)=>{if(method==='GET')return{goal};posts.push(body);return{goal:{...goal,...body,revision:3}};},
    getContext:()=>({runId:'run-one'}),onStart:()=>assert.fail('existing goal must not create a new chat')});
  t.after(()=>controls.destroy());controls.update({conversationId:'one'});await tick();
  await view.goalEdit.dispatch('click');view.goalInput.value='Revised outcome';view.goalLimit.value='2.5';
  await view.goalForm.dispatch('submit');assert.equal(posts.length,0);assert.equal(view.goalError.hidden,false);
  view.goalLimit.value='9';await view.goalForm.dispatch('submit');
  assert.equal(posts.length,1);assert.equal(posts[0].action,'update');assert.equal(posts[0].maxTurns,9);
  assert.equal(view.goalStatus.textContent,'Paused');assert.equal(view.goalDialog.open,false);
  controls.update({conversationId:'one',readonly:true});assert.equal(view.goalToggle.disabled,true);assert.equal(view.goalResume.disabled,true);
});


test('sidebar and header do not call an unfinished standing goal Finished',t=>{
  const {view}=fixture(t),run={id:'run-one',status:'completed',settled:true,createdAt:'2026-11-12T00:00:00Z'};
  for(const [status,label]of [['active','Goal ready'],['paused','Goal paused'],['completed','Goal completed'],['interrupted','Goal interrupted'],['waiting','Goal waiting'],['budget_exhausted','Goal turn limit reached']]){
    const goal=savedGoal({status,running:false});
    assert.equal(conversationGoalStatus(goal,run),label);
    assert.equal(chatHeaderStatus(run,goal),label);
    paintIndex(view,[{...run,taskId:'one',title:'One standing goal',goal}],'one',()=>{});
    assert.match(view.list.querySelector('.next-conversation-meta').textContent,new RegExp(label));
  }
  assert.equal(conversationGoalStatus(savedGoal({running:true}),run),'Running');
  assert.equal(conversationGoalStatus(savedGoal({running:false,runStatus:'queued'}),run),'Goal queued');
  assert.equal(conversationGoalStatus(savedGoal({running:false}),{...run,status:'running',settled:false}),'Goal ready','explicit host running=false wins over stale run state');
  assert.equal(conversationGoalStatus(null,run),null);
});

test('chat reader retains only compact goal metadata across worker projection',()=>{
  const goal={...savedGoal({running:false,runStatus:'completed'}),evidence:['large record'],privateWorkerData:{detail:'not needed in sidebar'}};
  const projected=projectFamily({rootId:'one',goal,runs:[]});
  assert.deepEqual(projected.goal,projectConversationGoal(goal));
  assert.equal(projected.goal.status,'active');
  assert.equal(projected.goal.objective,undefined);assert.equal(projected.goal.evidence,undefined);assert.equal(projected.goal.privateWorkerData,undefined);
  assert.equal(projectFamily({rootId:'one',runs:[]}).goal,undefined);
});
test('actual pause shows pending settlement and disables Resume',()=>{
 const p=goalPresentation(savedGoal({status:'paused',running:false,pauseRequest:{status:'pausing',settled:false}}));
 assert.equal(p.label,'Pausing current execution');assert.equal(p.canResume,false);
 assert.equal(goalPresentation(savedGoal({status:'paused',running:false,pauseRequest:{status:'paused',settled:true}})).canResume,true);
});
