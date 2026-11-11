import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkflowWorkspace } from '../public/next/workspaces/workflow-execution.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const settle=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};

test('standalone workflows have a scroll panel, return navigation and the same retained editor lifecycle',async t=>{
  const f=planningDOM(t),listeners=new Set(),navigation=[],calls=[];
  const prototype=Object.getPrototypeOf(f.mount);
  Object.defineProperty(prototype,'options',{get(){return this.children;},configurable:true});
  const component=createWorkflowWorkspace({
    mount:f.mount,
    api:async path=>{calls.push(path);if(path==='/api/workflows?view=index')return[];throw Error('Unexpected '+path);},
    events:{subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}},
    getStatus:()=>({cwd:'C:\\fixture'}),notify:()=>{},onNavigate:(...args)=>navigation.push(args),
  });
  t.after(()=>component.destroy());
  assert.ok(f.$('.next-workflows-workspace').classList.contains('next-panel'));
  assert.equal(f.$('#next-workflow-form').closest('.next-workflows-workspace'),f.$('.next-workflows-workspace'));
  assert.match(f.$('h1').textContent,/Saved workflows/);
  component.enter();await settle();
  assert.equal(listeners.size,1);
  assert.deepEqual(calls,['/api/workflows?view=index']);
  f.$('#next-workflow-prompt').value='Keep this unsaved workflow intent';
  await f.click('#next-workflows-back');
  assert.deepEqual(navigation,[['cronjobs']]);
  component.leave();assert.equal(listeners.size,0);
  component.enter();await settle();
  assert.equal(listeners.size,1);
  assert.equal(f.$('#next-workflow-prompt').value,'Keep this unsaved workflow intent');
  component.destroy();
  assert.equal(listeners.size,0);
  assert.equal(f.mount.innerHTML,'');
});

test('legacy Tasks and Activity routes share Cronjobs and repeated navigation never remounts it',async()=>{
  const source=readFileSync(new URL('../public/next/app.mjs',import.meta.url),'utf8');
  const actual=source.slice(source.indexOf('function openWorkspaceTarget('),source.indexOf('for(const tab of tabs){\n  tab.addEventListener'));
  const element=()=>({children:[],dataset:{},hidden:false,setAttribute(){},append(...items){this.children.push(...items);},querySelector(){return null;}});
  const lifecycle=[],routes=[],selected=[],instance=name=>({enter(){lifecycle.push(name+':enter');},leave(){lifecycle.push(name+':leave');}});
  const modules={cronjobs:async()=>()=>instance('cronjobs'),workflows:async()=>()=>instance('workflows')};
  const app=new Function('modules','document','stage','routes','selected',
    `let current=null,revision=0,status=null;const spaces=new Map(),api=()=>{},events={},notify=()=>{},history={replaceState(_state,_title,url){routes.push(url);}};function updateTabs(name){selected.push(name);};${actual};return{show,spaces};`)(modules,{createElement:element},element(),routes,selected);
  await app.show('tasks');await app.spaces.get('cronjobs').loading;
  assert.equal(routes.at(-1),'#cronjobs');
  await app.show('activity');
  assert.equal(app.spaces.size,1);
  assert.deepEqual(lifecycle,['cronjobs:enter']);
  await app.show('workflows');await app.spaces.get('workflows').loading;
  assert.equal(app.spaces.get('cronjobs').mount.hidden,true);
  await app.show('cronjobs');
  assert.equal(app.spaces.get('workflows').mount.hidden,true);
  assert.equal(app.spaces.get('cronjobs').mount.hidden,false);
  assert.deepEqual(lifecycle,['cronjobs:enter','cronjobs:leave','workflows:enter','workflows:leave','cronjobs:enter']);
  assert.deepEqual(selected,['cronjobs','workflows','cronjobs']);
});

test('shell exposes only Cronjobs navigation while keeping workflow and legacy routing compatible',()=>{
  const index=readFileSync(new URL('../public/next/index.html',import.meta.url),'utf8');
  const app=readFileSync(new URL('../public/next/app.mjs',import.meta.url),'utf8');
  assert.match(index,/data-space="cronjobs"/);
  assert.doesNotMatch(index,/data-space="(?:tasks|activity|workflows)"/);
  assert.match(app,/m=>m.createWorkflowWorkspace/);
  assert.match(app,/name==='workflows'\?'cronjobs':name/);
  assert.match(app,/requested==='activity'\|\|requested==='tasks'\?'cronjobs'/);
});
