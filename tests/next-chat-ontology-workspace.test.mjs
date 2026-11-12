import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createChatWorkspace} from '../public/next/chat/chat.mjs';
import {normalizePlanningOntology} from '../public/planning-module-policy.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';

function testDOM(t){
 const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),append=prototype.append,type=Object.getOwnPropertyDescriptor(prototype,'type');
 Object.defineProperties(prototype,{
   childNodes:{get(){return this.children;}},lastChild:{get(){return this.children.at(-1)||null;}},
   type:{get:type.get,set(value){this.setAttribute('type',value);}},
 });
 prototype.append=function(...items){for(const item of items)append.call(this,...(item.tagName==='#FRAGMENT'?[...item.children]:[item]));};
 prototype.replaceChildren=function(...items){for(const child of [...this.children])child.remove();this.rawText='';this.append(...items);};
 prototype.showModal=function(){this.open=true;};prototype.close=function(){this.open=false;};prototype.scrollIntoView=function(){};
 dom.document.createDocumentFragment=()=>dom.element('#fragment');
 return dom;
}


test('switching saved conversations restores each policy ahead of changing global defaults',async t=>{
 const dom=testDOM(t),stored=new Map(),oldStorage=globalThis.localStorage,oldWorker=globalThis.Worker;
 globalThis.localStorage={getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,String(value)),removeItem:key=>stored.delete(key)};
 const a=normalizePlanningOntology({modules:{inference:'mandatory'}}),b=normalizePlanningOntology({modules:{inference:'forbidden'}});
 const defaults=normalizePlanningOntology({modules:{inference:'auto'}});
 const families=new Map(['one','two'].map((id,i)=>[id,{rootId:id,state:'active',runs:[{
   id,taskId:id,createdAt:'2026-11-11T12:00:00Z',input:'A task',status:'completed',settled:true,
   planningMode:'off',planningOntology:i===0?a:b,events:[],
   workflow:{nodes:[{id:'agent',type:'agent',name:'Agent',model:'fixture'}]},
   nodes:{agent:{status:'completed',threadId:'thread-'+id,output:'Done'}}
 }]}]));
 globalThis.Worker=class{
   handlers=new Map();cancelled=new Set();
   addEventListener(type,handler){this.handlers.set(type,handler);}
   postMessage(packet){
     if(packet.type==='cancel'){this.cancelled.add(packet.id);return;}
     queueMicrotask(()=>{if(!this.cancelled.has(packet.id))this.handlers.get('message')?.({data:{id:packet.id,ok:true,family:projectFamily(structuredClone(families.get(packet.runId)))}});});
   }
   terminate(){}
 };
 const status={cwd:'C:\\fixture',defaultModel:'fixture',models:[{id:'fixture',available:true}],runtimeSettings:{planningOntology:defaults}};
 const api=async(route,method)=>{
   if(route.startsWith('/api/conversations?'))return{conversations:[]};
   if(route==='/api/attachments')return[];
   if(route==='/api/status')return status;
   throw Error('Unexpected API '+route);
 };
 const workspace=createChatWorkspace({mount:dom.mount,api,events:{subscribe:()=>()=>{}},getStatus:()=>status});
 t.after(()=>{workspace.destroy();if(oldStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldStorage;if(oldWorker===undefined)delete globalThis.Worker;else globalThis.Worker=oldWorker;});
 workspace.enter();
 const wait=async id=>{for(let i=0;i<50;i++){if(workspace.getState().selected===id&&workspace.getState().runCount===1)return;await new Promise(r=>setTimeout(r,5));}throw Error('Conversation did not open '+id);};
 const find=(label,choice)=>dom.$('#next-chat-ontology-modules').querySelectorAll('input').find(x=>x.getAttribute('aria-label')===label+' '+choice);
 workspace.openConversationId('one');await wait('one');
 assert.equal(find('Intent inference','on').checked,true);
 const blocked=find('Subagent orchestration','off');blocked.checked=true;await blocked.dispatch('change');
 assert.equal(JSON.parse(stored.get('blackice.next.chatOntology.one')).planningOntology.modules.subagents,false);
 workspace.openConversationId('two');await wait('two');
 assert.equal(find('Intent inference','off').checked,true);
 assert.equal(find('Subagent orchestration','on').checked,true,'other chat cannot inherit first chat edit');
 status.runtimeSettings.planningOntology=normalizePlanningOntology({modules:{subagents:'mandatory'}});
 workspace.updateStatus(status);
 assert.equal(find('Intent inference','off').checked,true,'saved conversation wins over changed application default');
 workspace.openConversationId('one');await wait('one');
 assert.equal(find('Intent inference','on').checked,true);
 assert.equal(find('Subagent orchestration','off').checked,true);
});

test('mounted Chat composer uses 18 explicit On/Off checkboxes and persists only the current conversation',async t=>{
 const dom=testDOM(t),stored=new Map(),oldStorage=globalThis.localStorage,oldWorker=globalThis.Worker;
 globalThis.localStorage={getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,String(value)),removeItem:key=>stored.delete(key)};
 delete globalThis.Worker;
 const defaults=normalizePlanningOntology({modules:{feasibility:'forbidden'}});
 const status={cwd:'C:\\fixture',defaultModel:'fixture',models:[{id:'fixture',available:true}],runtimeSettings:{planningOntology:defaults}};
 const api=async(route,method,body)=>{
   if(route.startsWith('/api/conversations'))return{conversations:[]};
   if(route==='/api/attachments')return[];
   if(route==='/api/status')return status;
   if(route==='/api/runtime/settings'&&method==='POST'){status.runtimeSettings.planningOntology=body.planningOntology;return status.runtimeSettings;}
   throw Error('Unexpected API: '+route);
 };
 const workspace=createChatWorkspace({mount:dom.mount,api,events:{subscribe:()=>()=>{}},getStatus:()=>status});
 t.after(()=>{workspace.destroy();if(oldStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldStorage;if(oldWorker===undefined)delete globalThis.Worker;else globalThis.Worker=oldWorker;});
 const grid=dom.$('#next-chat-ontology-modules'),rows=grid.children;
 const disclosure=dom.$('#next-chat-ontology-inline');
 assert.equal(disclosure.tagName,'DETAILS');
 assert.equal(disclosure.open,false,'initial composer stays compact');
 assert.equal(rows.length,9);
 assert.equal(grid.querySelectorAll('input[type="checkbox"]').length,18);
 const option=(label,choice)=>grid.querySelectorAll('input').find(input=>input.getAttribute('aria-label')===label+' '+choice);
 assert.equal(option('Feasibility','off')?.checked,true);
 assert.equal(option('Intent inference','on')?.checked,true);
 assert.equal(option('Anti-overalignment calibration','on')?.checked,true);
 workspace.enter();
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(option('Feasibility','off').checked,true);
 const mandatory=option('Feasibility','on');mandatory.checked=true;await mandatory.dispatch('change');
 assert.equal(mandatory.checked,true);
 assert.equal(option('Feasibility','off').checked,false);
 assert.equal(option('Intent inference','on').checked,true);
 assert.equal(disclosure.open,false,'editing configuration never expands the panel implicitly');
 assert.equal(JSON.parse(stored.get('blackice.next.chatOntology.new')).planningOntology.modules.feasibility,true);
 assert.equal(JSON.parse(stored.get('blackice.next.chatOptions')||'{}').planningOntology,undefined);
 await dom.click('#next-chat-ontology-default');await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(status.runtimeSettings.planningOntology.modules.feasibility,true);
 assert.equal(dom.$('#next-chat-ontology-feedback').textContent,'Saved.');
 await dom.click('#next-chat-new');await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(option('Feasibility','on').checked,true);
});
