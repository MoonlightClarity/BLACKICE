import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {KnowledgeStore} from '../lib/knowledge.mjs';
import {createKnowledgeWorkspace} from '../public/next/workspaces/knowledge.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const until=async predicate=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Knowledge Skills navigation did not settle');};
test('Skills inspector routes saved skills into the existing revision-guarded editor without writing',async t=>{
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperty(prototype,'type',{get:type.get,set(value){this.setAttribute('type',value);}});
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-skills-nav-'));
  const store=await new KnowledgeStore({dataDir:directory}).init();
  await store.upsert({id:'target-procedure',kind:'skill',title:'Target skill',summary:'Source-backed',content:'# Actual current procedure'});
  const calls=[];
  const api=async(route,method='GET',body)=>{
    calls.push({route,method,body});
    const url=new URL(route,'http://fixture'),id=url.pathname.split('/')[3];
    if(!id){const query=url.searchParams;return store.list({kind:query.get('kind')||undefined,query:query.get('query')||undefined,limit:300});}
    if(method==='GET')return store.get(id);
    throw Error('Unexpected implicit knowledge mutation');
  };
  const workspace=createKnowledgeWorkspace({mount:dom.mount,api,events:{subscribe(){return()=>{}}}});
  t.after(async()=>{workspace.destroy();await store.writeChain;await rm(directory,{recursive:true,force:true});});
  workspace.enter();workspace.openSkillId('target-procedure');
  await until(()=>dom.$('#next-knowledge-content').value==='# Actual current procedure');
  assert.equal(dom.$('#next-knowledge-kind').value,'skill');
  assert.equal(dom.$('#next-knowledge-title').value,'Target skill');
  assert.equal(dom.$('#next-knowledge-save').disabled,true);
  assert.ok(calls.every(call=>call.method==='GET'));
  workspace.openSkillId(null);
  await until(()=>dom.$('#next-knowledge-save').textContent==='Create skill');
  assert.equal(dom.$('#next-knowledge-content').value,'');
  assert.equal(dom.$('#next-knowledge-kind').value,'skill');
  assert.equal(store.get('target-procedure').revision,1);
});
