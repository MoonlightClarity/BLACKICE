import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createInstructionEditor} from '../public/next/workspaces/settings-instruction-editor.mjs';
import {createInstructionSettings} from '../public/next/workspaces/settings-instructions.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const ENDPOINT='/api/instructions/core';
const hash=text=>createHash('sha256').update(text).digest('hex');
const record=(revision=0,content='Initial profile instructions.',source=revision===0?'initial-default':'user')=>({
  content,text:content,revision,hash:hash(content),source,path:'C:\\fixture\\instructions\\current.json',
  updatedAt:'2026-11-21T00:00:'+String(revision).padStart(2,'0')+'Z',characters:content.length
});
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function fixture(t,{saved=record(),versions=[saved],request}={}){
  const dom=planningDOM(t),calls=[],history=new Map(versions.map(item=>[item.revision,structuredClone(item)]));
  let current=structuredClone(saved);history.set(current.revision,current);
  const backend=async call=>{
    const {route,method,payload}=call;
    if(method==='GET'){
      if(route===ENDPOINT)return structuredClone(current);
      if(route===ENDPOINT+'/versions')return [...history.values()].map(({content,text,...metadata})=>structuredClone(metadata));
      const match=route.match(/^\/api\/instructions\/core\/versions\/(\d+)$/);
      if(match&&history.has(Number(match[1])))return structuredClone(history.get(Number(match[1])));
      throw Error('Unexpected read: '+route);
    }
    assert.equal(route,ENDPOINT);assert.equal(method,'PUT');
    if(payload.expectedRevision!==current.revision||payload.expectedHash!==current.hash)
      throw Object.assign(Error('Saved instructions changed. Reload before saving.'),{status:409});
    assert.equal(typeof payload.content,'string');
    current=record(current.revision+1,payload.content,'user');history.set(current.revision,current);
    return structuredClone(current);
  };
  const api=async(route,method='GET',payload,options={})=>{
    const call={route,method,payload:payload===undefined?undefined:structuredClone(payload),signal:options.signal};
    calls.push(call);return request?request(call,backend):backend(call);
  };
  const panel=createInstructionEditor({mount:dom.mount,api});t.after(()=>panel.destroy());
  return{...dom,panel,calls,api,backend,history,get saved(){return current;},setSaved(value){current=structuredClone(value);history.set(current.revision,current);},
    async open(){panel.enter();await settle();},async save(){await dom.$('#next-instructions-editor-form').dispatch('submit');await settle();}};
}

test('only explicit Save writes; empty content and surrounding whitespace remain exact',async t=>{
  const f=fixture(t,{saved:record(1,'Saved owner instructions.')});
  assert.deepEqual(f.calls,[]);await f.open();
  assert.equal(f.$('#next-instructions-text').value,'Saved owner instructions.');
  assert.equal(f.$('#next-instructions-save').disabled,true);
  await f.input('#next-instructions-text','');
  assert.equal(f.$('#next-instructions-count').textContent,'0 characters');
  assert.equal(f.$('#next-instructions-save').disabled,false);
  await f.key(f.$('#next-instructions-text'),'Enter');
  assert.equal(f.calls.filter(call=>call.method==='PUT').length,0,'Typing never saves.');
  await f.save();
  assert.equal(f.saved.content,'');assert.equal(f.saved.revision,2);
  assert.deepEqual(f.calls.find(call=>call.method==='PUT').payload,{content:'',expectedRevision:1,expectedHash:hash('Saved owner instructions.')});
  f.panel.leave();await f.open();assert.equal(f.$('#next-instructions-text').value,'','An explicit empty save never restores default text.');
  const exact='  Owner text.\n\n';await f.input('#next-instructions-text',exact);await f.save();
  assert.equal(f.saved.content,exact);
});

test('initial saved revision can be saved unchanged and is never automatically written',async t=>{
  const f=fixture(t);await f.open();
  assert.equal(f.$('#next-instructions-save').disabled,false,'The user can explicitly save the initial revision as user-owned.');
  f.panel.leave();await f.open();
  assert.equal(f.calls.filter(call=>call.method==='PUT').length,0);
  assert.match(f.$('#next-instructions-source').textContent,/Initial saved instructions/);
  await f.save();assert.equal(f.saved.revision,1);assert.equal(f.saved.source,'user');
  assert.equal(f.saved.content,'Initial profile instructions.');
  assert.equal(f.$('#next-instructions-save').disabled,true);
});

test('drafts survive navigation and cancelled old reads cannot replace the active draft',async t=>{
  const pending=deferred();let held=false;
  const f=fixture(t,{saved:record(1,'Original'),request:(call,backend)=>{
    if(held&&call.route===ENDPOINT&&call.method==='GET'){held=false;return pending.promise;}
    return backend(call);
  }});
  await f.open();await f.input('#next-instructions-text','Unsaved draft');
  held=true;await f.click('#next-instructions-reload');await settle();
  const interrupted=f.calls.at(-1);f.panel.leave();assert.equal(interrupted.signal.aborted,true);
  await f.open();pending.resolve(record(2,'Stale response'));await settle();
  assert.equal(f.$('#next-instructions-text').value,'Unsaved draft');
  assert.equal(f.$('#next-instructions-conflict').hidden,true);
  assert.ok(f.calls.every(call=>call.method==='GET'));
  assert.ok(!f.calls.some(call=>call.route.endsWith('/versions')),'History stays lazy.');
});

test('typing during Save remains a draft and an older read cannot roll back the saved revision',async t=>{
  const pending=deferred(),old=record(1,'Before');let submission,returnOld=false;
  const f=fixture(t,{saved:old,request:(call,backend)=>{
    if(call.method==='PUT'){submission=call;return pending.promise;}
    if(returnOld&&call.route===ENDPOINT)return structuredClone(old);
    return backend(call);
  }});
  await f.open();await f.input('#next-instructions-text','Submitted edit');
  await f.$('#next-instructions-editor-form').dispatch('submit');await settle();
  assert.equal(f.$('#next-instructions-save').disabled,true);
  assert.equal(f.$('#next-instructions-text').disabled,false);
  await f.input('#next-instructions-text','Later typing');
  pending.resolve(await f.backend(submission));await settle();
  assert.equal(f.saved.content,'Submitted edit');
  assert.equal(f.$('#next-instructions-text').value,'Later typing');
  assert.match(f.$('#next-instructions-save-state').textContent,/Unsaved changes/);
  assert.equal(f.$('#next-instructions-before').textContent,'Submitted edit');
  returnOld=true;await f.click('#next-instructions-reload');await settle();
  assert.match(f.$('#next-instructions-saved').textContent,/Saved revision 2/);
  assert.equal(f.$('#next-instructions-text').value,'Later typing');
});

test('revision conflicts preserve the draft and require an explicit choice of saved base',async t=>{
  const f=fixture(t,{saved:record(1,'Before')});await f.open();
  await f.input('#next-instructions-text','My intended edit');
  const other=record(2,'Changed in another Config view');f.setSaved(other);
  await f.save();await settle();
  assert.equal(f.$('#next-instructions-text').value,'My intended edit');
  assert.equal(f.$('#next-instructions-conflict').hidden,false);
  assert.equal(f.$('#next-instructions-save').disabled,true);
  assert.equal(f.$('#next-instructions-before').textContent,other.content);
  await f.click('#next-instructions-keep-draft');await f.save();
  const writes=f.calls.filter(call=>call.method==='PUT');
  assert.equal(writes.length,2);
  assert.deepEqual(writes[1].payload,{content:'My intended edit',expectedRevision:2,expectedHash:other.hash});
  assert.equal(f.saved.revision,3);assert.equal(f.saved.content,'My intended edit');
});

test('history revision zero is reviewable as inert text and loading it only changes the draft',async t=>{
  const original=record(0,'<img src=x onerror="alert(1)">\nOriginal instructions.'),current=record(2,'Current owner text');
  const f=fixture(t,{saved:current,versions:[original,record(1,'Middle revision'),current]});await f.open();
  await f.click('#next-instructions-history');await settle();
  await f.click('[data-instruction-revision="0"]');await settle();
  assert.equal(f.$('#next-instructions-version-text').textContent,original.content);
  assert.equal(f.$('img'),null,'Instruction content is never interpreted as HTML.');
  await f.click('#next-instructions-use-version');
  assert.equal(f.$('#next-instructions-text').value,original.content);
  assert.equal(f.saved.revision,2);
  assert.equal(f.calls.filter(call=>call.method==='PUT').length,0);
  assert.equal(f.$('#next-instructions-before').textContent,current.content);
  assert.equal(f.$('#next-instructions-after').textContent,original.content);
  await f.save();
  assert.equal(f.saved.revision,3);assert.equal(f.saved.content,original.content);
  assert.equal(f.calls.find(call=>call.method==='PUT').payload.expectedRevision,2);
});

test('Revert is recoverable and a rejected save leaves the intended text intact',async t=>{
  const f=fixture(t,{saved:record(1,'Saved text'),request:(call,backend)=>{
    if(call.method==='PUT')throw Object.assign(Error('Only local Config may save instructions.'),{status:403});
    return backend(call);
  }});
  await f.open();await f.input('#next-instructions-text','Draft to keep');
  await f.click('#next-instructions-revert');assert.equal(f.$('#next-instructions-text').value,'Saved text');
  assert.equal(f.$('#next-instructions-recover').hidden,false);
  await f.click('#next-instructions-recover');assert.equal(f.$('#next-instructions-text').value,'Draft to keep');
  await f.save();
  assert.equal(f.saved.revision,1);assert.equal(f.$('#next-instructions-text').value,'Draft to keep');
  assert.equal(f.$('#next-instructions-notice').getAttribute('role'),'alert');
  assert.match(f.$('#next-instructions-notice').textContent,/Only local Config/);
});

test('Config edits use the authoritative store and do not rewrite a captured execution',async t=>{
  const f=planningDOM(t);let saved=record(1,'Current saved instructions');
  const captured={runId:'captured',status:'completed',nodes:[{nodeId:'agent',name:'Agent',audit:{
    version:1,captureStage:'adapter-prepared',sections:[{id:'core',title:'Instructions',source:'Saved instructions',role:'developer',text:'Exact earlier execution text',characters:28}],
    totals:{characters:28,sections:1},notes:[]
  }}]};
  const api=async(route,method='GET',payload)=>{
    if(route==='/api/instructions')return{version:'2.40.68',core:{text:'Legacy shipped text must not become the editor value'},runs:[{id:'captured',title:'Captured execution',captured:true}]};
    if(route==='/api/runs/captured/instructions')return structuredClone(captured);
    if(route===ENDPOINT&&method==='GET')return structuredClone(saved);
    if(route===ENDPOINT&&method==='PUT'){assert.equal(payload.expectedRevision,saved.revision);assert.equal(payload.expectedHash,saved.hash);saved=record(saved.revision+1,payload.content);return structuredClone(saved);}
    throw Error('Unexpected route: '+route);
  };
  const panel=createInstructionSettings({mount:f.mount,api});t.after(()=>panel.destroy());panel.enter();await settle();
  assert.equal(f.$('#next-instructions-text').value,'Current saved instructions');
  assert.match(f.$('#next-instructions-content').textContent,/Exact earlier execution text/);
  await f.input('#next-instructions-text','');
  await f.$('#next-instructions-editor-form').dispatch('submit');await settle();
  assert.equal(saved.content,'');
  assert.match(f.$('#next-instructions-content').textContent,/Exact earlier execution text/);
  assert.equal(captured.nodes[0].audit.sections[0].text,'Exact earlier execution text');
});


test('a newly saved revision refreshes an open version history without writing',async t=>{
  const f=fixture(t,{saved:record(1,'First saved text.')});await f.open();
  await f.click('#next-instructions-history');await settle();
  assert.equal(f.$('#next-instructions-versions').querySelectorAll('li').length,1);
  f.setSaved(record(2,'Newer saved text.'));
  await f.click('#next-instructions-reload');await settle();
  assert.equal(f.$('#next-instructions-text').value,'Newer saved text.');
  assert.equal(f.$('#next-instructions-versions').querySelectorAll('li').length,2);
  assert.ok(f.$('[data-instruction-revision="2"]'));
  assert.ok(f.calls.every(call=>call.method==='GET'));
});
