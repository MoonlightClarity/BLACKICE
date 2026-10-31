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
