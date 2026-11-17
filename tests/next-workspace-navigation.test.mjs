import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function routing(modules){
  const source=readFileSync(new URL('../public/next/app.mjs',import.meta.url),'utf8');
  const actual=source.slice(source.indexOf('function openWorkspaceTarget('),source.indexOf('for(const tab of tabs){\n  tab.addEventListener'));
  assert.ok(actual.includes('async function show('));
  const element=()=>({children:[],dataset:{},hidden:false,setAttribute(){},append(...items){this.children.push(...items);},querySelector(){return null;}});
  return new Function('modules','document','stage',`let current=null,revision=0,status=null;const spaces=new Map(),api=()=>{},events={},notify=()=>{},history={replaceState(){}};function updateTabs(){};${actual};return{show,spaces};`)(modules,{createElement:element},element());
}

test('a request link selected while Planning lazily loads opens the latest exact request and stage',async()=>{
  let resolve;const pending=new Promise(done=>{resolve=done;}),opened=[];
  const app=routing({planning:()=>pending});
  await app.show('planning',{requestId:'first-request',nodeId:'old-stage'});
  await app.show('planning',{requestId:'current-request',nodeId:'current-plan'});
  resolve(()=>({enter(){},updateStatus(){},openRequestId:(...args)=>opened.push(args)}));
  await app.spaces.get('planning').loading;
  assert.deepEqual(opened,[['current-request',{nodeId:'current-plan'}]]);
  await app.show('planning',{requestId:'another-request',nodeId:'inference'});
  assert.deepEqual(opened.at(-1),['another-request',{nodeId:'inference'}]);
});

test('conversation navigation remains compatible and never substitutes a request hash as a Chat run',async()=>{
  const opened=[],app=routing({chat:async()=>()=>({enter(){},updateStatus(){},openConversationId:id=>opened.push(id)})});
  await app.show('chat',{conversationId:'persisted-run'});await app.spaces.get('chat').loading;
  assert.deepEqual(opened,['persisted-run']);
  await app.show('chat',{requestId:'planning-request'});
  assert.deepEqual(opened,['persisted-run']);
});

test('native account setup navigation survives lazy Settings loading without changing a conversation target',async()=>{
  let resolve;const pending=new Promise(done=>{resolve=done;}),providers=[],conversations=[];
  const app=routing({settings:()=>pending});
  await app.show('settings',{modelProviderId:'mistral-vibe'});
  resolve(()=>({enter(){},updateStatus(){},openModelProvider:id=>providers.push(id),openConversationId:id=>conversations.push(id)}));
  await app.spaces.get('settings').loading;
  assert.deepEqual(providers,['mistral-vibe']);assert.deepEqual(conversations,[]);
  await app.show('settings',{modelProviderId:'mistral-vibe'});
  assert.deepEqual(providers,['mistral-vibe','mistral-vibe']);assert.deepEqual(conversations,[]);
});

import {updateWorkspaceTabs} from '../public/next/core/workspace-navigation.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';
import {readFile} from 'node:fs/promises';
const names=['chat','swarm','cronjobs','browser','knowledge','skills','settings'];
function tabs(t){const f=planningDOM(t);return names.map(name=>{const el=f.element('button');el.dataset.space=name;f.mount.append(el);return el;});}
test('workflows never highlights Cronjobs or Swarm regardless of entry point',t=>{
 const items=tabs(t);
 for(const origin of ['swarm','cronjobs']){
  updateWorkspaceTabs(items,origin);
  assert.equal(items.filter(tab=>tab.getAttribute('aria-selected')==='true').length,1);
  updateWorkspaceTabs(items,'workflows');
  assert.equal(items.filter(tab=>tab.getAttribute('aria-selected')==='true').length,0);
  assert.equal(items.filter(tab=>tab.tabIndex===0).length,1);
  assert.equal(items[0].tabIndex,0);
 }
});
test('direct workflow link stays neutral and returning to a main workspace selects exactly it',t=>{
 const items=tabs(t);updateWorkspaceTabs(items,'workflows');
 assert.equal(items.every(tab=>tab.getAttribute('aria-selected')==='false'),true);
 for(const name of names){
  updateWorkspaceTabs(items,name);
  assert.deepEqual(items.filter(tab=>tab.getAttribute('aria-selected')==='true').map(tab=>tab.dataset.space),[name]);
  assert.deepEqual(items.filter(tab=>tab.tabIndex===0).map(tab=>tab.dataset.space),[name]);
 }
});
test('Planning subview also retains keyboard access without claiming another workspace',t=>{
 const items=tabs(t);updateWorkspaceTabs(items,'planning');
 assert.equal(items.filter(tab=>tab.tabIndex===0).length,1);
 assert.equal(items.every(tab=>tab.getAttribute('aria-selected')==='false'),true);
});
test('live shell uses the tested navigation helper',async()=>{
 const source=await readFile(new URL('../public/next/app.mjs',import.meta.url),'utf8');
 assert.match(source,/updateWorkspaceTabs\(tabs,name\)/);
 assert.doesNotMatch(source,/name==='workflows'\?'cronjobs'/);
});
