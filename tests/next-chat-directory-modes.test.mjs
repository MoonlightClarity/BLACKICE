import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createChatWorkspace} from '../public/next/chat/chat.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';
import {submitChat} from '../public/next/chat/send.mjs';
import {normalizeChatOptions} from '../public/next/chat/options-model.mjs';
import {readConversationExecutionModes,saveConversationExecutionModes,transferNewExecutionModes} from '../public/next/chat/execution-preferences.mjs';
function testDOM(t){
 const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),append=prototype.append,type=Object.getOwnPropertyDescriptor(prototype,'type');
 Object.defineProperties(prototype,{childNodes:{get(){return this.children;}},lastChild:{get(){return this.children.at(-1)||null;}},
   type:{get:type.get,set(value){this.setAttribute('type',value);}}});
 prototype.append=function(...items){for(const item of items)append.call(this,...(item.tagName==='#FRAGMENT'?[...item.children]:[item]));};
 prototype.replaceChildren=function(...items){for(const child of [...this.children])child.remove();this.rawText='';this.append(...items);};
 prototype.showModal=function(){this.open=true;};prototype.close=function(){this.open=false;};prototype.scrollIntoView=function(){};
 dom.document.createDocumentFragment=()=>dom.element('#fragment');return dom;
}
const store=()=>{const data=new Map();return{getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key),data};};
const run=(id,modes={directoryMode:'auto',subagentsMode:'default'})=>({
 id,taskId:id,createdAt:'2026-11-11T12:00:00Z',input:'A task',status:'completed',settled:true,planningMode:'off',executionModes:modes,events:[],
 workflow:{nodes:[{id:'agent',type:'agent',name:'Agent',model:'fixture'}]},
 nodes:{agent:{status:'completed',threadId:'thread-'+id,output:'Done'}}
});
test('Directory stays conversation-scoped while retired subagent preferences normalize to default',()=>{
 const storage=store(),value={directoryMode:'on',subagentsMode:'off'},expected={...value,subagentsMode:'default'};
 assert.deepEqual(readConversationExecutionModes({storage}),{directoryMode:'on',subagentsMode:'default'});
 assert.equal(normalizeChatOptions({...value,planningMode:'off'}).directoryMode,'on');
 for(const subagentsMode of ['on','off'])assert.equal(normalizeChatOptions({...value,subagentsMode}).subagentsMode,'default');
 assert.deepEqual(saveConversationExecutionModes({storage,...value}),expected);
 storage.setItem('blackice.next.chatExecution.new',JSON.stringify(value));
 assert.equal(transferNewExecutionModes({storage,conversationId:'one'}),true);
 assert.deepEqual(readConversationExecutionModes({storage,conversationId:'one'}),expected);
 assert.deepEqual(JSON.parse(storage.getItem('blackice.next.chatExecution.one')),expected);
 assert.deepEqual(readConversationExecutionModes({storage,conversationId:'two'}),{directoryMode:'on',subagentsMode:'default'});
 assert.deepEqual(readConversationExecutionModes({storage,conversationId:'new'}),{directoryMode:'on',subagentsMode:'default'});
 assert.throws(()=>saveConversationExecutionModes({storage,conversationId:'one',directoryMode:'unknown'}));
 const projected=projectFamily({rootId:'one',state:'active',runs:[run('one',value)]});
 assert.deepEqual(projected.runs[0].executionModes,value,'worker projection must retain admitted runtime choices');
 assert.deepEqual(readConversationExecutionModes({storage:store(),conversationId:'one',runs:projected.runs}),expected,'old server overrides cannot affect the next response');
 assert.deepEqual(projected.runs[0].executionModes,value,'restoring a draft must not rewrite historical evidence');
 const server=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
 assert.ok(server.includes("'chat/execution-preferences.mjs'"),'new browser import must be served');
});
test('mounted Chat switches isolated Directory preferences and restores them after workspace recreation',async t=>{
 const dom=testDOM(t),storage=store(),oldStorage=globalThis.localStorage,oldWorker=globalThis.Worker;
 globalThis.localStorage=storage;
 const families=new Map(['one','two'].map((id,i)=>[id,{rootId:id,state:'active',runs:[run(id,i?{directoryMode:'off',subagentsMode:'on'}:{directoryMode:'on',subagentsMode:'off'})]}]));
 globalThis.Worker=class{
   handlers=new Map();cancelled=new Set();
   addEventListener(type,handler){this.handlers.set(type,handler);}
   postMessage(packet){if(packet.type==='cancel'){this.cancelled.add(packet.id);return;}
     queueMicrotask(()=>{if(!this.cancelled.has(packet.id))this.handlers.get('message')?.({data:{id:packet.id,ok:true,family:projectFamily(structuredClone(families.get(packet.runId)))}});});}
   terminate(){}
 };
 const status={cwd:'C:\\fixture',defaultModel:'fixture',models:[{id:'fixture',available:true}],runtimeSettings:{}};
 const api=async route=>{if(route.startsWith('/api/conversations?'))return{conversations:[]};if(route==='/api/attachments')return[];if(route==='/api/status')return status;throw Error('Unexpected API '+route);};
 const make=()=>createChatWorkspace({mount:dom.mount,api,events:{subscribe:()=>()=>{}},getStatus:()=>status});
 let workspace=make();
 t.after(()=>{workspace.destroy();if(oldStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldStorage;if(oldWorker===undefined)delete globalThis.Worker;else globalThis.Worker=oldWorker;});
 const wait=async id=>{for(let i=0;i<70;i++){if(workspace.getState().selected===id&&workspace.getState().runCount===1)return;await new Promise(r=>setTimeout(r,5));}throw Error('Conversation did not open '+id);};
 workspace.enter();workspace.openConversationId('one');await wait('one');
 assert.equal(dom.$('#next-chat-directory-mode').value,'on');assert.equal(dom.$('#next-chat-subagents-mode'),null);
 dom.$('#next-chat-directory-mode').value='off';await dom.$('#next-chat-directory-mode').dispatch('change');
 workspace.openConversationId('two');await wait('two');
 assert.equal(dom.$('#next-chat-directory-mode').value,'off');assert.equal(dom.$('#next-chat-subagents-mode'),null);
 workspace.openConversationId('one');await wait('one');assert.equal(dom.$('#next-chat-directory-mode').value,'off');
 workspace.destroy();workspace=make();workspace.enter();workspace.openConversationId('one');await wait('one');
 assert.equal(dom.$('#next-chat-directory-mode').value,'off');assert.equal(dom.$('#next-chat-subagents-mode'),null);
 workspace.openConversationId('two');await wait('two');assert.equal(dom.$('#next-chat-directory-mode').value,'off');
});
test('Chat start/continue always submit default delegation while live direction preserves active execution',async()=>{
 const calls=[],api=async(route,method,value)=>{calls.push({route,value});return route.endsWith('/steer')?{accepted:true}:route==='/api/workflows'?value:{id:'accepted',taskId:'one'};};
 await submitChat({api,runs:[],task:'Inspect marker',model:'fixture',cwd:'C:\\fixture',planningMode:'off',directoryMode:'on',subagentsMode:'off'});
 assert.equal(calls.at(-1).value.input.directoryMode,'on');assert.equal(calls.at(-1).value.input.subagentsMode,'default');
 calls.length=0;await submitChat({api,runs:[run('one')],task:'Next',planningMode:'off',directoryMode:'off',subagentsMode:'on'});
 assert.equal(calls[0].value.directoryMode,'off');assert.equal(calls[0].value.subagentsMode,'default');
 const active=run('active');active.status='running';active.settled=false;active.nodes.agent={status:'running',threadId:'thread',turnId:'turn'};
 calls.length=0;await submitChat({api,runs:[active],task:'Direction',directoryMode:'on',subagentsMode:'off'});
 assert.match(calls[0].route,/steer$/);assert.equal(calls[0].value.directoryMode,undefined);assert.equal(calls[0].value.subagentsMode,undefined);
 assert.equal(active.executionModes.directoryMode,'auto');
});
