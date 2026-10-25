import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {KnowledgeStore} from '../lib/knowledge.mjs';
import {createKnowledgeWorkspace} from '../public/next/workspaces/knowledge.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const until=async read=>{const end=Date.now()+5000;while(Date.now()<end){if(read())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Knowledge management did not settle.');};
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
async function fixture(t,{hook}={}){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperty(prototype,'type',{get:type.get,set(value){this.setAttribute('type',value);}});
  prototype.replaceChildren=function(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.rawText='';this.markup='';this.append(...children);};
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-knowledge-management-')),store=await new KnowledgeStore({dataDir:directory}).init();
  await store.upsert({id:'related',kind:'memory',title:'Related evidence',content:'Related body',cwd:null});
  const original=await store.upsert({id:'managed',kind:'memory',title:'Managed memory',content:'Full saved body',summary:'Keep summary',cwd:null,memoryType:'fact',
    sources:['literal source <untrusted>'],relations:[{type:'supports',targetId:'related'}]});
  const calls=[],listeners=new Set(),api=async(route,method='GET',body)=>{
    const call={route,method,body};calls.push(call);if(hook){const result=await hook(call,store);if(result!==undefined)return result;}
    const url=new URL(route,'http://fixture'),id=url.pathname.split('/')[3];
    if(!id){const p=url.searchParams;return store.list({kind:p.get('kind')||undefined,deletedOnly:p.get('deletedOnly')==='true',limit:300});}
    if(method==='GET')return route.endsWith('/history')?store.history(id):store.get(id);
    if(method==='DELETE')return store.remove(id,{expectedRevision:body.expectedRevision});
    if(route.endsWith('/restore'))return store.restore(id,body.revision,{source:'user'},{expectedRevision:body.expectedRevision});
    throw Error('Unexpected knowledge mutation '+route);
  };
  const workspace=createKnowledgeWorkspace({mount:dom.mount,api,events:{subscribe(handler){listeners.add(handler);return()=>listeners.delete(handler);}}});
  t.after(async()=>{workspace.destroy();await store.writeChain;await rm(directory,{recursive:true,force:true});});workspace.enter();await until(()=>dom.$('[data-knowledge-id="managed"]'));
  await dom.click('[data-knowledge-id="managed"]');await until(()=>dom.$('#next-knowledge-content').value==='Full saved body');
  return {...dom,workspace,store,original,calls,listeners,restores:()=>calls.filter(call=>call.method==='POST'&&call.route.endsWith('/restore')),
    async trash(){await dom.click('#next-knowledge-delete');await until(()=>store.history('managed').deleted&&dom.$('#next-knowledge-recover').hidden===false&&!dom.$('#next-knowledge-recover').disabled);},
    async idle(){await until(()=>!dom.$('#next-knowledge-new').disabled&&!dom.$('#next-knowledge-recover').disabled);}};
}

test('Move to Trash and direct Restore entry use real revision-guarded recovery once, preserving metadata',async t=>{
  const f=await fixture(t);assert.equal(f.$('#next-knowledge-delete').textContent,'Move to Trash');assert.match(f.$('#next-knowledge-state').textContent,/Trash/);
  await f.trash();assert.equal(f.$('#next-knowledge-content').readOnly,true);assert.equal(f.restores().length,0);
  const reads=f.calls.filter(call=>call.route.endsWith('/history')).length;
  await f.click('#next-knowledge-recover');await f.click('#next-knowledge-recover');await until(()=>!f.store.history('managed').deleted);await f.idle();
  assert.equal(f.calls.filter(call=>call.route.endsWith('/history')).length,reads+1);assert.equal(f.restores().length,1);
  assert.deepEqual(f.restores()[0].body,{revision:1,expectedRevision:2});const restored=f.store.get('managed');
  for(const key of ['id','kind','title','summary','content','cwd','memoryType','sources','relations'])assert.deepEqual(restored[key],f.original[key],key+' preserved');
  assert.equal(restored.revision,3);assert.equal(f.$('#next-knowledge-state').value,'active');assert.equal(f.$('#next-knowledge-recover').hidden,true);assert.equal(f.$('#next-knowledge-content').readOnly,false);
});

test('a concurrent deleted revision rejects direct recovery and retains the error and entry across navigation without replay',async t=>{
  let change=true;const f=await fixture(t,{hook:async(call,store)=>{if(change&&call.method==='POST'&&call.route.endsWith('/restore')){change=false;await store.restore('managed',2,{source:'user'},{expectedRevision:2});}}});
  await f.trash();await f.click('#next-knowledge-recover');await f.idle();assert.match(f.$('#next-knowledge-editor-info').textContent,/changed while you were reading/);
  assert.equal(f.$('#next-knowledge-content').value,'Full saved body');assert.equal(f.store.history('managed').deleted,true);assert.equal(f.store.history('managed').currentRevision,3);
  f.workspace.leave();f.workspace.enter();await settle();assert.match(f.$('#next-knowledge-editor-info').textContent,/changed while you were reading/);assert.equal(f.restores().length,1);
  await f.click('#next-knowledge-recover');await until(()=>!f.store.history('managed').deleted);assert.deepEqual(f.restores()[1].body,{revision:1,expectedRevision:3});
});

test('leaving while recovery history loads cancels that read and never starts an implicit restore on return',async t=>{
  const gate=deferred();let hold=false;const f=await fixture(t,{hook:async(call,store)=>{if(hold&&call.route.endsWith('/history')){hold=false;const snapshot=store.history('managed');await gate.promise;return snapshot;}}});
  await f.trash();hold=true;await f.click('#next-knowledge-recover');await until(()=>f.$('#next-knowledge-recover').disabled);
  f.workspace.leave();f.workspace.enter();gate.resolve();await settle();await settle();assert.equal(f.restores().length,0);assert.equal(f.store.history('managed').deleted,true);
  assert.match(f.$('#next-knowledge-editor-info').textContent,/Restore was not started/);
  await f.click('#next-knowledge-recover');await until(()=>!f.store.history('managed').deleted);assert.equal(f.restores().length,1);
});

test('a late recovery history cannot restore a different selection',async t=>{
  const gate=deferred();let hold=false;const f=await fixture(t,{hook:async(call,store)=>{if(hold&&call.route.endsWith('/history')){hold=false;const snapshot=store.history('managed');await gate.promise;return snapshot;}}});
  await f.trash();hold=true;await f.click('#next-knowledge-recover');await f.click('[data-knowledge-id="related"]');await until(()=>f.$('#next-knowledge-content').value==='Related body');gate.resolve();await settle();await settle();
  assert.equal(f.restores().length,0);assert.equal(f.$('#next-knowledge-content').value,'Related body');assert.equal(f.store.history('managed').deleted,true);
});

test('a history-read error keeps the deleted entry and error across navigation until another explicit restore',async t=>{
  let fail=false;const f=await fixture(t,{hook:call=>{if(fail&&call.route.endsWith('/history')){fail=false;throw Error('History unavailable for this request.');}}});
  await f.trash();fail=true;await f.click('#next-knowledge-recover');await f.idle();assert.match(f.$('#next-knowledge-editor-info').textContent,/History unavailable/);
  f.workspace.leave();f.workspace.enter();await settle();assert.match(f.$('#next-knowledge-editor-info').textContent,/History unavailable/);assert.equal(f.restores().length,0);
  await f.click('#next-knowledge-recover');await until(()=>!f.store.history('managed').deleted);assert.equal(f.restores().length,1);
});
