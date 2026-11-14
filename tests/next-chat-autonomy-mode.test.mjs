import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createChatFrame} from '../public/next/chat/render.mjs';
import {displayChatRequest} from '../public/next/chat/model.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';
import {createAutonomyControls,autonomyModelChoices,selectedAutonomyModels} from '../public/next/chat/autonomy.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

function fixture(t){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount);
  const type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperties(prototype,{childNodes:{get(){return this.children;}},lastChild:{get(){return this.children.at(-1)||null;}},type:{get:type.get,set(value){this.setAttribute('type',value);}}});
  prototype.showModal=function(){this.open=true;};
  prototype.close=function(){this.open=false;};
  return {dom,view:createChatFrame(dom.mount)};
}
const status={defaultModel:'test-model',models:[
  {id:'test-model',displayName:'Test model',available:true},
  {id:'vision-model',displayName:'Vision-capable option',available:true},
  {id:'premium-model',displayName:'Expensive choice',available:true},
  {id:'retired-model',displayName:'Retired',available:false},
]};
test('synthetic autonomous continuation is not misattributed to the human in the chat transcript',()=>{
  const run={id:'automatic-two',taskId:'original-root',parentRunId:'original-root',
    input:'Continue this same conversation in autonomous operating mode.',
    autonomy:{automatic:true},status:'completed',settled:true,events:[],nodes:{},
    workflow:{id:'fixture',nodes:[],settings:{}}};
  assert.equal(displayChatRequest(run),'');
  assert.equal(displayChatRequest({...run,autonomy:undefined}),
    'Continue this same conversation in autonomous operating mode.','manual user input is still visible');
  const projection=projectFamily({runs:[run]});
  assert.equal(projection.runs[0].autonomy.automatic,true,'reader projection preserves automatic origin');
});

test('whitelist list contains only actual runtime entries and preserves saved missing entries visibly',()=>{
  const choices=autonomyModelChoices(status,['unavailable-model']);
  assert.deepEqual(choices.map(item=>item.id),['test-model','vision-model','premium-model','retired-model','unavailable-model']);
  assert.equal(choices.at(-1).available,false);
  assert.equal(choices.find(row=>row.id==='vision-model').available,true);
  const row=[{id:'test-model',input:{checked:true}},{id:'vision-model',input:{checked:false}}];
  assert.deepEqual(selectedAutonomyModels(row),['test-model']);
});

test('autonomy has an independent on/off and calibration form with exact model choices',async t=>{
  const {view}=fixture(t);
  const posts=[];let stored=null,goalChanged=0;
  const api=async(route,method,body)=>{
    assert.equal(route,'/api/conversations/fixture-chat/autonomy');
    if(method==='GET')return {autonomy:stored};
    posts.push(body);
    if(body.action==='enable')stored={id:'autonomy-fixture',revision:1,generation:1,enabled:true,status:'active',
      calibration:body.calibration,modelAllowlist:body.modelAllowlist,selectedModel:body.selectedModel};
    else if(body.action==='disable')stored={...stored,revision:stored.revision+1,enabled:false,status:'paused'};
    else if(body.action==='resume')stored={...stored,revision:stored.revision+1,enabled:true,status:'active'};
    else if(body.action==='calibrate')stored={...stored,revision:stored.revision+1,calibration:body.calibration,modelAllowlist:body.modelAllowlist};
    else assert.fail('Unexpected autonomy action '+body.action);
    return {autonomy:stored};
  };
  const controls=createAutonomyControls({view,api,getStatus:()=>status,
    getContext:()=>({runId:'initial-turn',model:'test-model'}),onChange:()=>{},
    onError:error=>assert.fail('Unexpected UI error '+error.message)});
  t.after(()=>controls.destroy());

  assert.equal(view.goalToggle.textContent,'Goal: Off','legacy Goal Mode is distinct');
  controls.update({conversationId:'new'});
  assert.equal(view.autonomyToggle.textContent,'Autonomy: Off');
  assert.equal(view.autonomyToggle.disabled,true,'no automatic conversation is silently created');
  controls.update({conversationId:'fixture-chat'});
  await tick();
  assert.equal(view.autonomyToggle.disabled,false);
  await view.autonomyToggle.dispatch('click');
  assert.equal(view.autonomyDialog.open,true);
  assert.equal(view.autonomyModels.children.length,4);
  const rows=view.autonomyModels.children;
  assert.equal(rows[0].children[0].checked,true,'current explicit model suggested, not silently submitted');
  assert.equal(rows[1].children[0].checked,false);
  rows[1].children[0].checked=true;
  view.autonomyCalibration.value='Prefer zero-cost models when capable; allow vision tasks on eligible models.';
  await view.autonomyForm.dispatch('submit');
  assert.equal(posts.length,1);
  assert.equal(posts[0].action,'enable');
  assert.deepEqual(posts[0].modelAllowlist,['test-model','vision-model']);
  assert.equal(posts[0].selectedModel,null);
  assert.equal(view.autonomyDialog.open,false);
  assert.equal(view.autonomyToggle.textContent,'Autonomy: On');
  assert.equal(view.goalToggle.textContent,'Goal: Off');
  assert.equal(goalChanged,0);

  await view.autonomyToggle.dispatch('click');
  assert.equal(posts[1].action,'disable');
  assert.equal(view.autonomyToggle.textContent,'Autonomy: Off');
  await view.autonomyToggle.dispatch('click');
  assert.equal(posts[2].action,'resume');
  assert.equal(view.autonomyToggle.textContent,'Autonomy: On');
  await view.autonomySettings.dispatch('click');
  assert.equal(view.autonomyDialog.open,true);
  assert.equal(view.autonomyCalibration.value,posts[0].calibration);
  assert.equal(view.autonomyModels.children[0].children[0].checked,true);
  assert.equal(view.autonomyModels.children[1].children[0].checked,true);
  await view.autonomyCancel.dispatch('click');
  assert.equal(view.autonomyDialog.open,false);
});

test('editing calibration never invents a Goal objective or replaces the saved model allowlist',async t=>{
  const {view}=fixture(t);
  const saved={id:'autonomy-fixture',revision:4,generation:2,enabled:true,status:'active',
    calibration:'Original preference',modelAllowlist:['vision-model'],selectedModel:'vision-model'};
  const requests=[];
  const api=async(route,method,body)=>{
    if(method==='GET')return {autonomy:saved};
    requests.push(body);return {autonomy:{...saved,revision:5,calibration:body.calibration}};
  };
  const controls=createAutonomyControls({view,api,getStatus:()=>status,getContext:()=>({runId:'first',model:'test-model'})});
  t.after(()=>controls.destroy());
  controls.update({conversationId:'fixture-chat'});
  await tick();
  await view.autonomySettings.dispatch('click');
  assert.equal(view.autonomyModels.children[0].children[0].checked,false,'does not override saved model with current');
  assert.equal(view.autonomyModels.children[1].children[0].checked,true);
  view.autonomyCalibration.value='Updated preference';
  await view.autonomyForm.dispatch('submit');
  assert.equal(requests.length,1);
  assert.equal(requests[0].action,'calibrate');
  assert.deepEqual(requests[0].modelAllowlist,['vision-model']);
  assert.equal(requests[0].selectedModel,'vision-model');
  assert.equal(requests[0].objective,undefined);
});
