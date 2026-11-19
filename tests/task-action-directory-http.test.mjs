import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {EventEmitter} from 'node:events';import {createHarnessServer} from '../server.mjs';import {submitChat} from '../public/next/chat/send.mjs';import {projectFamily} from '../public/next/chat/reader-model.mjs';import {planningDOM} from './fixture-planning-dom.mjs';import {createActionDirectory} from '../public/next/chat/action-directory.mjs';
test('authenticated action outline edits exact canonical task with CAS, no display sibling access',async t=>{const dir=await mkdtemp(path.join(tmpdir(),'action-directory-http-'));class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true};}async start(){}async close(){}async runAgent(){throw Error("No provider expected");}}const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:dir,defaultCwd:dir,remoteAccess:null});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});app.conversations.get=async id=>({id,taskId:'task',input:'Explicit task',directoryActions:'on'});const base=await app.listen({waitForRemote:false}),home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];await home.arrayBuffer();const url=base+'/api/conversations/run/action-directory?taskId=task',headers={Cookie:cookie,'Content-Type':'application/json'};assert.equal((await fetch(url)).status,401);let result=await(await fetch(url,{headers})).json();assert.equal(result.state.actions.length,0);const update={action:'plan',revision:result.state.revision,actions:[{id:'first',objective:'Inspect source',dependsOn:[]}]};const saved=await fetch(url,{method:'POST',headers,body:JSON.stringify(update)});assert.equal(saved.status,200);result=await saved.json();assert.equal(result.state.actions[0].authority,'human');assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(update)})).status,409);assert.equal((await fetch(url.replace('taskId=task','taskId=other'),{headers})).status,404);assert.equal((await fetch(base+'/next/chat/action-directory.mjs',{headers})).status,200);});
test('actual selectors, reader and submission carry independent action and Planning choices',async()=>{const source=await readFile(new URL('../public/next/chat/render.mjs',import.meta.url),'utf8');assert.match(source,/<select id="next-chat-directory-actions"/);assert.match(source,/<select id="next-chat-planning-actions"/);const calls=[];await submitChat({api:async(...args)=>{calls.push(args);return{run:{id:'new'}};},runs:[],cwd:'C:/fixture',task:'Find work',directoryActions:'on',chatPlanning:'on'});assert.equal(calls.at(-1)[2].input.directoryActions,'on');assert.equal(calls.at(-1)[2].input.chatPlanning,'on');assert.match(JSON.stringify(projectFamily({runs:[{id:'r',taskId:'t',nodes:{},directoryActions:'on',chatPlanning:'on'}]})),/"directoryActions":"on"/);});
test('outline loader cannot paint another selected task after navigation',async t=>{const d=planningDOM(t);let rows=[{id:'one',taskId:'task'}],resolve;const ui=createActionDirectory({frame:d.mount,getRuns:()=>rows,api:()=>new Promise(r=>resolve=r)});t.after(()=>ui.destroy());const pending=ui.open();rows=[{id:'two',taskId:'other'}];ui.refresh('two');resolve({state:{objective:'PRIVATE OLD',revision:0,actions:[],receipts:[]}});await pending;assert.doesNotMatch(d.mount.textContent,/PRIVATE OLD/);});

test('outline surfaces returned failures on collapsed steps and failed unassigned attempts separately',async t=>{
 const d=planningDOM(t);
 const state={objective:'Look through a fixture',revision:8,focus:'next',ready:[],actions:[
  {id:'inspect',objective:'Inspect results',state:'observed',dependsOn:[]},
  {id:'next',objective:'Continue reading',state:'active',dependsOn:['inspect']}
 ],receipts:[
  {id:'receipt-1',actionId:'inspect',tool:'relay_browser',state:'returned',success:false,actionDispatched:false,code:'BROWSER_REF_STALE'},
  {id:'receipt-2',actionId:null,tool:'relay_workspace',state:'returned',success:false,code:'READ_ERROR'},
  {id:'receipt-3',actionId:'next',tool:'relay_browser',state:'unknown',threw:true}
 ]};
 const ctl=createActionDirectory({frame:d.mount,getRuns:()=>[{id:'target',taskId:'test-task'}],api:async()=>({runId:'target',taskId:'test-task',state})});
 t.after(()=>ctl.destroy());await ctl.open();
 const [done,current]=d.mount.querySelectorAll('.action-outline-row');
 assert.equal(done.open,false);
 assert.match(done.querySelector('summary').textContent,/Inspect results.*1 failed/);
 assert.match(done.textContent,/Failed before dispatch.*BROWSER_REF_STALE/);
 assert.equal(current.open,true);
 assert.match(current.querySelector('summary').textContent,/1 unresolved/);
 assert.equal(current.querySelectorAll('button')[0].disabled,true);
 assert.match(d.mount.querySelector('.action-outline-unassigned').textContent,/READ_ERROR/);
 assert.doesNotMatch(done.textContent,/READ_ERROR/);
});
