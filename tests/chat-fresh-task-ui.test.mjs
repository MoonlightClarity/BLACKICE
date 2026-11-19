import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';
import {createChatWorkspace} from '../public/next/chat/chat.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async read=>{for(let i=0;i<180;i++){if(read())return;await tick();}throw Error('Fresh task UI did not settle.');};
const org={healthy:true,revision:1,autoEnabled:false,folders:[],assignments:[]};
const status={connected:true,authenticated:true,cwd:'C:\\fixture',defaultModel:'fixture',defaultModelSelection:'fixture',models:[{id:'fixture',model:'fixture',available:true}]};
const goal={id:'goal-old',revision:1,status:'paused',objective:'Original Goal stays on the old task',deadlineAt:'2099-02-04T06:00:00Z',deadlineTimeZone:'UTC'};
function record(id,title,state='active'){
  const run={id,taskId:id,input:title,createdAt:'2026-11-19T01:00:00Z',status:'completed',settled:true,
    workflow:{nodes:[{id:'agent',type:'agent',model:'fixture'}]},nodes:{agent:{status:'completed',resolvedModel:'fixture',threadId:'thread-'+id,output:'Output for '+title}}};
  const item={...run,title,runId:id,state,chatDisplayGroupId:id==='old'?undefined:'old'};
  return {run,item,family:{rootId:id,title,state,runs:[run],goal:id==='old'?goal:null}};
}

test('Tasks dialog starts fresh with a scoped retry, reloads its task, and never retargets the old Goal',async t=>{
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),append=prototype.append;
  Object.defineProperties(prototype,{childNodes:{get(){return this.children;}},lastChild:{get(){return this.children.at(-1)||null;}}});
  prototype.append=function(...items){for(const item of items)append.call(this,...(item.tagName==='#FRAGMENT'?[...item.children]:[item]));};
  prototype.showModal=function(){this.open=true;};prototype.close=function(){this.open=false;};prototype.scrollIntoView=function(){};
  dom.document.createDocumentFragment=()=>dom.element('#fragment');
  const tasks=new Map([['old',record('old','Old task')],['archived',record('archived','Hidden archived sibling','archived')],['trash',record('trash','Hidden trashed sibling','deleted')]]);
  const calls=[],storage=new Map([['blackice.next.selected','old'],['blackice.next.drafts',JSON.stringify({old:'Unsent old reply'})],
    ['blackice.next.attachments',JSON.stringify({old:['file_old']})]]);
  const oldWorker=globalThis.Worker,oldStorage=globalThis.localStorage;
  globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
  globalThis.Worker=class{
    handlers=new Map();cancelled=new Set();
    addEventListener(type,handler){this.handlers.set(type,handler);}
    postMessage(message){if(message.type==='cancel'){this.cancelled.add(message.id);return;}
      queueMicrotask(()=>{if(!this.cancelled.has(message.id))this.handlers.get('message')?.({data:{id:message.id,
        ok:true,family:projectFamily(structuredClone(tasks.get(message.runId).family))}});});}
    terminate(){}
  };
  const api=async(route,method='GET',body)=>{
    calls.push({route,method,body});
    if(route.startsWith('/api/conversations?'))return{conversations:[...tasks.values()].map(i=>i.item).filter(i=>i.state===new URL(route,'http://fixture').searchParams.get('state')),folderOrganization:org};
    if(route.startsWith('/api/conversation-folders?'))return{folderOrganization:org};
    if(route==='/api/attachments')return[];
    const match=/^\/api\/conversations\/([^/]+)\/(display-group|fresh-task|goal)$/.exec(route);
    if(match){
      const [,id,action]=match,selected=tasks.get(id);
      if(action==='display-group')return {groupId:'old',selectedTaskId:id,state:selected.item.state,
        taskIds:[...tasks.values()].filter(i=>i.item.state===selected.item.state).map(i=>i.item.id)};
      if(action==='fresh-task'){
        assert.equal(id,'old');assert.deepEqual(Object.keys(body).sort(),['requestId','task']);
        if(!tasks.has('fresh')){tasks.set('fresh',record('fresh',body.task));throw Error('Lost the first response after acceptance.');}
        return {groupId:'old',run:{...tasks.get('fresh').run,chatDisplayGroupId:'old'}};
      }
      if(action==='goal')return{id,goal:selected.family.goal};
    }
    throw Error('Unexpected fixture call '+route);
  };
  const build=()=>createChatWorkspace({mount:dom.mount,api,events:{subscribe:()=>()=>{}},getStatus:()=>status});
  let workspace=build();
  t.after(()=>{workspace.destroy();if(oldWorker===undefined)delete globalThis.Worker;else globalThis.Worker=oldWorker;
    if(oldStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldStorage;});
  workspace.enter();
  await until(()=>workspace.getState().selected==='old'&&workspace.getState().runCount===1&&!dom.$('#next-chat-goal-card').hidden);
  assert.equal(calls.filter(row=>row.route.endsWith('/display-group')).length,0,'ordinary refresh does not fetch task groups');
  await dom.click('#next-chat-task-menu');
  await until(()=>!dom.$('#next-chat-task-form').hidden);
  assert.match(dom.$('#next-chat-task-status').textContent,/Only active tasks/);
  assert.doesNotMatch(dom.$('#next-chat-task-list').textContent,/Archived|Trash|Hidden/i);
  assert.equal(dom.$('#next-chat-task-input').value,'','no old draft in fresh form');
  assert.equal(dom.$('#next-chat-input').value,'Unsent old reply');
  await dom.input('#next-chat-task-input','Independent fresh work');
  await dom.$('#next-chat-task-form').dispatch('submit');
  assert.equal(dom.$('#next-chat-task-error').hidden,false);
  assert.match(dom.$('#next-chat-task-error').textContent,/Lost the first response/);
  assert.equal(workspace.getState().selected,'old');
  workspace.destroy();workspace=build();workspace.enter(); // reload after an uncertain receipt
  await until(()=>workspace.getState().selected==='old'&&workspace.getState().runCount===1);
  await dom.click('#next-chat-task-menu');await until(()=>!dom.$('#next-chat-task-form').hidden);
  assert.equal(dom.$('#next-chat-task-input').value,'Independent fresh work');
  await dom.$('#next-chat-task-form').dispatch('submit');
  await until(()=>workspace.getState().selected==='fresh'&&workspace.getState().runCount===1);
  const starts=calls.filter(row=>row.route.endsWith('/fresh-task'));
  assert.equal(starts.length,2);assert.deepEqual(starts[0],starts[1],'same draft and source recover the same request');
  assert.equal(storage.get('blackice.next.freshTask.old'),undefined);
  assert.equal(storage.get('blackice.next.selected'),'fresh');
  assert.match(dom.$('#next-chat-title').textContent,/Task: Independent fresh work/);
  assert.equal(dom.$('#next-chat-goal-card').hidden,true);
  assert.equal(dom.$('#next-chat-input').value,'');
  assert.doesNotMatch(dom.$('#next-chat-timeline').textContent,/Old task/);
  workspace.destroy();workspace=build();workspace.enter(); // reload after acceptance
  await until(()=>workspace.getState().selected==='fresh'&&workspace.getState().runCount===1);
  await dom.click('#next-chat-task-menu');await until(()=>!dom.$('#next-chat-task-form').hidden);
  assert.match(dom.$('#next-chat-task-list').textContent,/Old task[\s\S]*Independent fresh work \(current\)/);
  await dom.click('[data-task-id="old"]');
  await until(()=>workspace.getState().selected==='old'&&workspace.getState().runCount===1&&!dom.$('#next-chat-goal-card').hidden);
  assert.equal(dom.$('#next-chat-goal-objective').textContent,goal.objective);
  assert.equal(dom.$('#next-chat-input').value,'Unsent old reply');
  await dom.click('#next-chat-goal-resume');await until(()=>calls.some(row=>row.route==='/api/conversations/old/goal'&&row.body?.action==='resume'));
  assert.equal(calls.some(row=>row.route==='/api/conversations/fresh/goal'&&row.method==='POST'),false);
  dom.$('#next-chat-bucket').value='archived';await dom.$('#next-chat-bucket').dispatch('change');
  await until(()=>workspace.getState().listing===1);
  workspace.openConversationId('archived');await until(()=>workspace.getState().selected==='archived'&&workspace.getState().runCount===1);
  await dom.click('#next-chat-task-menu');await until(()=>Boolean(dom.$('[data-task-id="archived"]')));
  assert.equal(dom.$('#next-chat-task-form').hidden,true);
  assert.equal(dom.$('[data-task-id="fresh"]'),null);
  await dom.click('#next-chat-task-cancel');
  dom.$('#next-chat-bucket').value='deleted';await dom.$('#next-chat-bucket').dispatch('change');
  await until(()=>workspace.getState().listing===1);
  workspace.openConversationId('trash');await until(()=>workspace.getState().selected==='trash'&&workspace.getState().runCount===1);
  await dom.click('#next-chat-task-menu');await until(()=>Boolean(dom.$('[data-task-id="trash"]')));
  assert.equal(dom.$('#next-chat-task-form').hidden,true);
  assert.equal(dom.$('[data-task-id="archived"]'),null);
});
