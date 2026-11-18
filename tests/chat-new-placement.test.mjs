import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';
import {createChatWorkspace} from '../public/next/chat/chat.mjs';
import {placeNewConversation} from '../public/next/chat/folders.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async read=>{for(let i=0;i<100;i++){if(read())return;await tick();}throw Error('Context fixture did not settle.');};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const info=()=>({connected:true,authenticated:true,cwd:'C:\\fixture',defaultModel:'gpt-6-luna',defaultModelSelection:'gpt-6-luna',
  runtimeSettings:{defaultContext:{preset:'model',autoCompact:true}},models:[
    {id:'first::gpt-6-luna',model:'gpt-6-luna',displayName:'First endpoint',available:true,contextWindowTokens:64000,contextWindowSource:'provider-reported'},
    {id:'gpt-6-luna',model:'gpt-6-luna',displayName:'GPT-6 Luna',available:true,runtimeDefaultContextWindowTokens:272000,contextWindowTokens:272000,maxContextWindowTokens:872000,effectiveContextWindowPercent:95,contextWindowSource:'runtime-reported'},
    {id:'second::gpt-6-luna',model:'gpt-6-luna',displayName:'Second endpoint',available:true,contextWindowTokens:128000,contextWindowSource:'provider-reported'},
  ]});
const saved=(id,context={preset:'extended',autoCompact:true},extra={})=>({id,taskId:id,status:'completed',settled:true,input:'Saved question',
  workflow:{nodes:[{id:'agent',type:'agent',model:'gpt-6-luna',context}]},nodes:{agent:{status:'completed',threadId:'thread-'+id,resolvedModel:'gpt-6-luna',output:'Saved answer',contextStatus:{preset:context.preset,requestedWindowTokens:context.windowTokens??null,autoCompact:context.autoCompact,nativeConfiguredWindowTokens:872000,nativeObservedWindowTokens:828400,effectiveWindowTokens:828400,nativeWindowBasis:'runtime-usage',actualInputTokens:12000}}},...extra});
function chatDOM(t){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),append=prototype.append,type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperties(prototype,{childNodes:{get(){return this.children;}},lastChild:{get(){return this.children.at(-1)||null;}},type:{get:type.get,set(value){this.setAttribute('type',value);}}});
  prototype.append=function(...items){for(const item of items)append.call(this,...(item.tagName==='#FRAGMENT'?[...item.children]:[item]));};
  prototype.replaceChildren=function(...items){for(const child of [...this.children])child.remove();this.rawText='';this.append(...items);};
  prototype.showModal=function(){this.open=true;};prototype.close=function(){this.open=false;};prototype.scrollIntoView=function(){};
  dom.document.createDocumentFragment=()=>dom.element('#fragment');
  return dom;
}

async function chatFixture(t,{compress,continueResponse,cancel,steerResponse,attachments=[],placementFailure=false}={}){
  const dom=chatDOM(t),status=info(),families=new Map(['a','b'].map(id=>[id,{rootId:id,state:'active',runs:[saved(id,id==='a'?{preset:'extended',autoCompact:true}:{preset:'custom',windowTokens:96000,autoCompact:false})]}])),calls=[],listeners=new Set(),storage=new Map();
  if(attachments.length)storage.set('blackice.next.attachments',JSON.stringify({a:attachments}));
  const oldWorker=globalThis.Worker,oldStorage=globalThis.localStorage;
  globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
  globalThis.Worker=class{
    handlers=new Map();cancelled=new Set();
    addEventListener(type,handler){this.handlers.set(type,handler);}
    postMessage(message){if(message.type==='cancel'){this.cancelled.add(message.id);return;}queueMicrotask(()=>{if(!this.cancelled.has(message.id))this.handlers.get('message')?.({data:{id:message.id,ok:true,family:projectFamily(structuredClone(families.get(message.runId)))}});});}
    terminate(){}
  };
  const organization={healthy:true,revision:1,autoEnabled:false,folders:[{id:'folder',name:'Project'}]},assignments=[];
  const api=async(route,method='GET',body)=>{calls.push({route,method,body});
    if(route.startsWith('/api/conversations?'))return{conversations:[],folderOrganization:organization};
    if(route.startsWith('/api/conversation-folders?'))return{folderOrganization:organization};
    if(route==='/api/conversation-folders/edit'){if(placementFailure)throw Object.assign(Error('Folder revision changed'),{status:409});assignments.push(body);return{folderOrganization:organization};}
    if(route==='/api/workflows')return{workflow:body};
    if(route==='/api/runs'){const id='created-'+families.size,run=saved(id);families.set(id,{rootId:id,state:'active',runs:[run]});return{run};}if(route==='/api/attachments')return[];
    if(route==='/api/status')return status;if(route.endsWith('/compact'))return compress(route,body);
    if(route.endsWith('/retry'))return families.get('b').runs[0];
    if(route.endsWith('/cancel')&&cancel)return cancel(route,body);
    if(route.endsWith('/continue')&&continueResponse)return continueResponse({route,body,families});
    if(route.endsWith('/steer'))return steerResponse||{accepted:true,delivery:'delivered'};
    throw Error('Unexpected fixture request '+route);
  };
  const workspace=createChatWorkspace({mount:dom.mount,api,events:{subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}},getStatus:()=>status});
  t.after(()=>{workspace.destroy();if(oldWorker===undefined)delete globalThis.Worker;else globalThis.Worker=oldWorker;if(oldStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldStorage;});
  workspace.enter();await tick();
  const open=async id=>{workspace.openConversationId(id);await until(()=>workspace.getState().selected===id&&workspace.getState().runCount===1);};
  return {...dom,status,families,calls,workspace,open,storage,assignments,emit:event=>{for(const listener of listeners)listener(event);}};
}

test('global new is manually unfiled, folder new uses explicit destination, close preserves drafts and work',async t=>{
 const f=await chatFixture(t);await until(()=>f.$('.next-chat-folder-new-chat'));
 await f.click('.next-chat-folder-new-chat');assert.match(f.$('#next-chat-title').textContent,/Project/);
 await f.input('#next-chat-input','Inside project');await f.$('#next-chat-form').dispatch('submit');await until(()=>f.assignments.length===1);await until(()=>!f.$('#next-chat-new').disabled);
 assert.equal(f.assignments[0].operations[0].folderId,'folder');
 const selected=f.workspace.getState().selected;
 await f.input('#next-chat-input','Unsent reply');const before=f.calls.filter(c=>c.method==='POST').length;
 await f.click('#next-chat-close');assert.equal(f.workspace.getState().selected,'new');assert.equal(f.calls.filter(c=>c.method==='POST').length,before);
 assert.equal(JSON.parse(f.storage.get('blackice.next.drafts'))[selected],'Unsent reply');
 await f.click('#next-chat-new');assert.match(f.$('#next-chat-title').textContent,/Unfiled/);
 await f.input('#next-chat-input','Global request');await f.$('#next-chat-form').dispatch('submit');await until(()=>f.assignments.length===2);
 assert.equal(f.assignments[1].operations[0].folderId,null);
 assert.equal(f.calls.filter(c=>c.route==='/api/runs').length,2);
 assert.equal(f.calls.some(c=>/archive|delete|cancel/.test(c.route)),false);
});
test('accepted send with rejected folder assignment stays accepted, warns, never repeats run',async t=>{
 const f=await chatFixture(t,{placementFailure:true});await until(()=>f.$('.next-chat-folder-new-chat'));
 await f.click('.next-chat-folder-new-chat');await f.input('#next-chat-input','Once');await f.$('#next-chat-form').dispatch('submit');
 await until(()=>f.$('#next-chat-hint').textContent.includes('folder placement failed'));
 assert.equal(f.calls.filter(c=>c.route==='/api/runs').length,1);assert.equal(f.calls.filter(c=>c.route==='/api/conversation-folders/edit').length,1);
 assert.equal(f.$('#next-chat-input').value,'');assert.match(f.$('#next-chat-hint').textContent,/do not resend/);
});
test('missing destination never silently falls back or sends an assignment',async()=>{
 const calls=[];await assert.rejects(placeNewConversation(async(...args)=>{calls.push(args);return {folderOrganization:{healthy:true,revision:2,folders:[]}};},'run','removed'),/no longer exists/);assert.equal(calls.length,1);
});

