import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {KnowledgeStore} from '../lib/knowledge.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {createSkillsWorkspace} from '../public/next/workspaces/skills.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const until=async predicate=>{const end=Date.now()+5000;while(Date.now()<end){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Skills UI did not settle.');};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {resolve,promise};};
async function fixture(t,{nativeSkills,hook}={}){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperty(prototype,'type',{get:type.get,set(value){this.setAttribute('type',value);}});
  const root=await mkdtemp(path.join(tmpdir(),'blackice-skills-ui-'));
  const cwd=path.join(root,'workspace'),store=await new KnowledgeStore({dataDir:root}).init();
  const saved=await store.upsert({id:'saved-procedure',kind:'skill',title:'Review exact artifacts',summary:'Reliable review',content:'# Inspect\nUse exact revisions.',cwd});
  const catalog=createSkillsCatalog({knowledge:store,defaultCwd:cwd,nativeSkills:nativeSkills||(async()=>({available:false,skills:[],reason:'Not connected'}))});
  const calls=[],navigation=[],listeners=new Set();
  const api=async(route,method='GET',body,{signal}={})=>{
    const call={route,method,body,signal};calls.push(call);
    if(hook){const result=await hook(call,catalog);if(result!==undefined)return result;}
    if(route==='/api/knowledge/folders')return {revision:0,folders:[],assignments:{}};
    if(route.startsWith('/api/knowledge/'))return store.get(route.split('/')[3]);
    if(route.startsWith('/api/knowledge?'))return store.list({kind:'skill',limit:300});
    if(method!=='GET')throw Error('Unexpected implicit write from Skills UI');
    const url=new URL(route,'http://test');
    const options={cwd:url.searchParams.get('cwd')||undefined,refresh:url.searchParams.get('refresh')==='true'};
    if(url.pathname==='/api/skills')return catalog.list({...options,source:url.searchParams.get('source')||'all',query:url.searchParams.get('query')||''});
    if(url.pathname.startsWith('/api/skills/'))return catalog.detail({...options,id:decodeURIComponent(url.pathname.slice('/api/skills/'.length))});
    throw Error('Unknown Skills API: '+route);
  };
  const workspace=createSkillsWorkspace({mount:dom.mount,api,onNavigate:(name,options)=>navigation.push({name,options}),events:{subscribe(handler){listeners.add(handler);return()=>listeners.delete(handler);}}});
  t.after(async()=>{workspace.destroy();await store.writeChain;await rm(root,{recursive:true,force:true});});
  workspace.enter();await until(()=>dom.$('[data-skill-id="saved:saved-procedure"]')).catch(error=>{throw Error(error.message+'; status='+dom.$('#skills-status')?.textContent+'; sources='+dom.$('#skills-source-status')?.textContent+'; list='+dom.$('#skills-list')?.textContent);});
  return {...dom,workspace,catalog,store,saved,cwd,calls,navigation,listeners,async selectSaved(){await dom.click('[data-skill-id="saved:saved-procedure"]');await until(()=>dom.$('#skills-content').textContent.includes('exact revisions'));}};
}
test('DOM selection shows actual full content, source, scope and truthful loading semantics',async t=>{
  const f=await fixture(t);await f.selectSaved();
  assert.match(f.$('#skills-content').textContent,/Use exact revisions/);
  assert.match(f.$('#skills-meta').textContent,/Saved procedure/);
  assert.match(f.$('#skills-tech-meta').textContent,/No per-turn loading evidence/);
  assert.equal(f.$('#skills-edit').hidden,false);
  await f.click('#skills-edit');await until(()=>f.$('#skills-editor-content').value.includes('exact revisions'));assert.equal(f.navigation.length,0);assert.equal(f.$('.next-skills-root').hidden,true);await f.click('#skills-back');
  await f.click('#skills-new');assert.equal(f.navigation.length,0);assert.equal(f.$('#skills-editor-save').textContent,'Create skill');
  assert.ok(f.calls.every(call=>call.method==='GET'),'the inspector never mutates knowledge');
});
test('source filtering and empty state are explicit, and refresh restores nonempty results',async t=>{
  const f=await fixture(t);
  f.$('#skills-query').value='no-match-123456';
  await f.$('#skills-query').dispatch('input');
  await until(()=>f.$('#skills-list').textContent.includes('No matching skills'));
  assert.match(f.$('#skills-status').textContent,/0 skills/);
  f.$('#skills-query').value='';
  await f.$('#skills-query').dispatch('input');
  await until(()=>f.$('[data-skill-id="saved:saved-procedure"]'));
  f.$('#skills-source').value='saved';await f.$('#skills-source').dispatch('change');
  await until(()=>f.$('#skills-status').textContent.includes('1 skill shown'));
  assert.equal(f.$('#skills-list').querySelectorAll('button').length,1);
  await f.click('#skills-refresh');await until(()=>!f.$('#skills-refresh').disabled);
  assert.ok(f.calls.filter(call=>call.route.startsWith('/api/skills?')).length>=4);
});
test('stale saved revision is signaled and explicit reload reads current source',async t=>{
  const f=await fixture(t);await f.selectSaved();
  await f.store.upsert({...f.saved,content:'# Inspect\nUpdated after independent writer',expectedRevision:1});
  for(const listener of f.listeners)listener({type:'knowledge.updated'});
  await until(()=>f.$('#skills-detail-status').textContent.includes('changed since you opened'));
  assert.match(f.$('#skills-content').textContent,/Use exact revisions/);
  await f.click('#skills-reload');
  await until(()=>f.$('#skills-content').textContent.includes('Updated after independent writer'));
  assert.equal(f.$('#skills-content').textContent.includes('Use exact revisions'),false);
});
test('manual Refresh rechecks native discovery while ordinary searches avoid force reloading',async t=>{
  const observed=[];
  const f=await fixture(t,{nativeSkills:async(_cwd,options)=>{observed.push(options?.forceReload);return {available:false,skills:[],reason:'Offline'};}});
  assert.equal(observed.length,0);await f.click('#skills-external');await until(()=>observed.length===1);
  assert.ok(observed.every(value=>value===false));
  f.$('#skills-query').value='review';await f.$('#skills-query').dispatch('input');
  await until(()=>observed.length>=2);
  assert.equal(observed.at(-1),false);
  await f.click('#skills-refresh');
  await until(()=>observed.at(-1)===true);
});
test('late completion of a previous selection cannot replace newer inspected content',async t=>{
  const gate=deferred();let delay=false;
  const f=await fixture(t,{hook:async(call,catalog)=>{
    if(delay&&decodeURIComponent(new URL(call.route,'http://test').pathname).includes('saved:saved-procedure')){
      delay=false;const snapshot=await catalog.detail({id:'saved:saved-procedure'});await gate.promise;return snapshot;
    }
  }});
  delay=true;await f.click('[data-skill-id="saved:saved-procedure"]');
  await until(()=>f.$('#skills-detail-status').textContent.includes('Loading full skill content'));
  await f.click('[data-skill-id="builtin:planning-v5"]');
  await until(()=>f.$('#skills-meta').textContent.includes('BLACKICE built-in'));
  gate.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.$('#skills-heading').textContent,'BLACKICE Planning (current contract)');
  assert.match(f.$('#skills-content').textContent,/BLACKICE Planning/);
  assert.equal(f.$('#skills-edit').hidden,true);
});
test('leave/re-enter during pending detail replaces the read without accepting stale completion',async t=>{
  const first=deferred(),second=deferred();
  let detailReads=0;
  const f=await fixture(t,{hook:async(call,catalog)=>{
    const pathname=decodeURIComponent(new URL(call.route,'http://test').pathname);
    if(!pathname.endsWith('/saved:saved-procedure'))return;
    const index=++detailReads,record=await catalog.detail({id:'saved:saved-procedure'});
    if(index===1)await first.promise;
    if(index===2)await second.promise;
    return record;
  }});
  await f.click('[data-skill-id="saved:saved-procedure"]');
  await until(()=>detailReads===1&&f.$('#skills-reload').disabled);
  f.workspace.leave();
  await f.store.upsert({...f.saved,content:'# Inspect\nUpdated between workspace entries.',expectedRevision:1});
  f.workspace.enter();
  await until(()=>detailReads===2);
  assert.equal(f.$('#skills-reload').disabled,true,'Current detail read is still pending.');
  first.resolve();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.$('#skills-content').hidden,true,'Old response must not paint after re-entry.');
  assert.equal(f.$('#skills-reload').disabled,true,'Old response must not settle the current control.');
  second.resolve();
  await until(()=>!f.$('#skills-reload').disabled&&f.$('#skills-content').textContent.includes('Updated between workspace entries.'));
  assert.equal(f.$('#skills-content').hidden,false);
  assert.equal(f.$('#skills-content').textContent.includes('Use exact revisions.'),false);
  assert.equal(f.$('#skills-list').querySelector('[data-skill-id="saved:saved-procedure"]').getAttribute('aria-pressed'),'true');
  assert.equal(detailReads,2,'Re-entry starts exactly one replacement detail read.');
});
test('failed replacement detail read unlocks explicit Reload without retrying old response',async t=>{
  const first=deferred();
  let detailReads=0;
  const f=await fixture(t,{hook:async(call,catalog)=>{
    const pathname=decodeURIComponent(new URL(call.route,'http://test').pathname);
    if(!pathname.endsWith('/saved:saved-procedure'))return;
    const index=++detailReads;
    if(index===1){const prior=await catalog.detail({id:'saved:saved-procedure'});await first.promise;return prior;}
    if(index===2)throw Error('Fresh detail read failed.');
  }});
  await f.click('[data-skill-id="saved:saved-procedure"]');
  await until(()=>detailReads===1);
  f.workspace.leave();f.workspace.enter();
  await until(()=>detailReads===2&&f.$('#skills-detail-status').textContent.includes('Fresh detail read failed.'));
  assert.equal(f.$('#skills-reload').disabled,false);
  first.resolve();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(f.$('#skills-detail-status').textContent,/Fresh detail read failed/,'Old response cannot clear the error.');
  await f.click('#skills-reload');
  await until(()=>detailReads===3&&f.$('#skills-content').textContent.includes('Use exact revisions.'));
  assert.equal(f.$('#skills-reload').disabled,false);
});
test('re-enter with an already settled selected skill preserves content without another detail request',async t=>{
  const f=await fixture(t);await f.selectSaved();
  const before=f.calls.filter(call=>decodeURIComponent(new URL(call.route,'http://test').pathname).endsWith('/saved:saved-procedure')).length;
  f.workspace.leave();f.workspace.enter();
  await until(()=>!f.$('#skills-refresh').disabled);
  const after=f.calls.filter(call=>decodeURIComponent(new URL(call.route,'http://test').pathname).endsWith('/saved:saved-procedure')).length;
  assert.equal(after,before);
  assert.equal(f.$('#skills-reload').disabled,false);
  assert.match(f.$('#skills-content').textContent,/Use exact revisions/);
});

test('error and disconnected native source states are visible without inventing enabled controls',async t=>{
  const f=await fixture(t,{nativeSkills:async()=>{throw Error('Native skill endpoint unavailable');}});
  await f.click('#skills-external');
  await until(()=>f.$('#skills-status').textContent.includes('0 disabled external discoveries')&&f.$('#skills-source-status').textContent.includes('error'));
  assert.match(f.$('#skills-source-status').textContent,/Native skill endpoint unavailable/);
  assert.match(f.$('#skills-list').textContent,/No matching skills/);
  assert.equal(f.$('#skills-edit').hidden,true);
});
test('list failure retains old list, displays error and succeeds on explicit refresh',async t=>{
  let fail=false;
  const f=await fixture(t,{hook:async call=>{
    if(fail&&call.route.startsWith('/api/skills?')){fail=false;throw Error('Catalog transport failed');}
  }});
  fail=true;await f.click('#skills-refresh');
  await until(()=>f.$('#skills-status').textContent.includes('Catalog transport failed'));
  assert.ok(f.$('[data-skill-id="saved:saved-procedure"]'));
  await f.click('#skills-refresh');
  await until(()=>!f.$('#skills-status').textContent.includes('Catalog transport failed'));
});
