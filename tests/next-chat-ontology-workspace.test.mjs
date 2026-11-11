import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createChatWorkspace} from '../public/next/chat/chat.mjs';
import {normalizePlanningOntology} from '../public/planning-module-policy.mjs';

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

test('mounted Chat composer uses 36 compact checkboxes and persists only the current conversation',async t=>{
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
 assert.equal(rows.length,9);
 assert.equal(grid.querySelectorAll('input[type="checkbox"]').length,36);
 const option=(label,choice)=>grid.querySelectorAll('input').find(input=>input.getAttribute('aria-label')===label+' '+choice);
 assert.equal(option('Feasibility','forbidden')?.checked,true);
 assert.equal(option('Intent inference','auto')?.checked,true);
 assert.equal(option('Anti-overalignment calibration','mandatory')?.checked,true);
 workspace.enter();
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(option('Feasibility','forbidden').checked,true);
 const mandatory=option('Feasibility','mandatory');mandatory.checked=true;await mandatory.dispatch('change');
 assert.equal(mandatory.checked,true);
 assert.equal(option('Feasibility','forbidden').checked,false);
 assert.equal(option('Intent inference','auto').checked,true);
 assert.equal(JSON.parse(stored.get('blackice.next.chatOntology.new')).planningOntology.modules.feasibility,'mandatory');
 assert.equal(JSON.parse(stored.get('blackice.next.chatOptions')||'{}').planningOntology,undefined);
 await dom.click('#next-chat-ontology-default');await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(status.runtimeSettings.planningOntology.modules.feasibility,'mandatory');
 assert.equal(dom.$('#next-chat-ontology-feedback').textContent,'Saved.');
 await dom.click('#next-chat-new');await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(option('Feasibility','mandatory').checked,true);
});
