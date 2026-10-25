import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createIdentitySettings} from '../public/next/workspaces/settings-identity.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const doc=(kind,revision=1,content=kind+' saved')=>({kind,revision,content,hash:hash(content),diskHash:hash(content),
  fileName:kind==='soul'?'SOUL.md':'USER.md',path:'C:\\fixture\\identity\\'+(kind==='soul'?'SOUL.md':'USER.md'),
  chars:content.length,updatedAt:'2026-10-25T12:00:00Z',provenance:{source:'user'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(t,{request}={}){
  const dom=planningDOM(t),calls=[],listeners=new Set(),notifications=[];
  const documents={soul:doc('soul'),user:doc('user')};
  const histories={soul:[documents.soul],user:[documents.user]};
  const backend=async(path,method='GET',payload)=>{
    const match=path.match(/^\/api\/identity\/(soul|user)(?:\/(versions|restore))?$/);
    assert.ok(match,'Only existing identity APIs may be used.');
    const [,kind,action]=match;
    if(method==='GET')return structuredClone(action==='versions'?histories[kind].map(({content,...metadata})=>metadata):documents[kind]);
    assert.ok(method==='PUT'&&!action||method==='POST'&&action==='restore');
    const current=documents[kind];
    if(payload.expectedRevision!==current.revision||payload.expectedHash!==current.diskHash)
      throw Object.assign(Error('The file changed since it was opened. Reload before saving.'),{status:409});
    const content=action==='restore'?histories[kind].find(item=>item.revision===payload.revision)?.content:payload.content;
    assert.equal(typeof content,'string');documents[kind]=doc(kind,current.revision+1,content);
    histories[kind].unshift(documents[kind]);return structuredClone(documents[kind]);
  };
  const api=async(path,method='GET',payload,options)=>{
    const call={path,method,payload:payload===undefined?undefined:structuredClone(payload),signal:options?.signal};calls.push(call);
    return request?request(call,backend):backend(path,method,payload);
  };
  const panel=createIdentitySettings({mount:dom.mount,api,events:{subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}},
    notify:(...args)=>notifications.push(args)});
  t.after(()=>panel.destroy());
  return{...dom,panel,calls,documents,histories,notifications,listeners,async event(type='identity.updated'){for(const listener of listeners)listener({type});await settle();},
    async submit(){await dom.$('#next-identity-form').dispatch('submit');await settle();}};
}

test('identity loads only on enter and keeps two global drafts through tab and workspace switches',async t=>{
  const f=fixture(t);assert.deepEqual(f.calls,[]);f.panel.enter();await settle();
  assert.deepEqual(f.calls.map(call=>call.path),['/api/identity/soul']);
  assert.match(f.mount.textContent,/Global character.*all working folders/);
  assert.match(f.mount.textContent,/next agent turn/);
  await f.input('#next-identity-content','Soul draft\nSecond line');
  await f.key(f.$('#next-identity-content'),'Enter');assert.equal(f.calls.length,1,'Enter in Markdown must not save.');
  await f.click('#next-identity-user');await settle();await f.input('#next-identity-content','User draft');
  await f.click('#next-identity-soul');await settle();assert.equal(f.$('#next-identity-content').value,'Soul draft\nSecond line');
  f.panel.leave();assert.equal(f.calls.some(call=>call.method!=='GET'),false);
  f.panel.enter();await settle();assert.equal(f.$('#next-identity-content').value,'Soul draft\nSecond line');
  await f.click('#next-identity-user');assert.equal(f.$('#next-identity-content').value,'User draft');
  assert.equal(f.$('#next-identity-user').getAttribute('aria-selected'),'true');
  await f.key(f.$('#next-identity-user'),'ArrowLeft');assert.equal(f.$('#next-identity-soul').getAttribute('aria-selected'),'true');
  assert.equal(f.document.activeElement,f.$('#next-identity-soul'));
  assert.equal(f.calls.some(call=>call.path.endsWith('/versions')),false,'History must remain lazy.');
});

test('explicit Save uses disk identity and a late receipt preserves text typed during the save',async t=>{
  const saving=deferred();let pending;
  const f=fixture(t,{request:async(call,backend)=>{
    if(call.method==='PUT'){pending=call;await saving.promise;}return backend(call.path,call.method,call.payload);
  }});
  f.panel.enter();await settle();await f.input('#next-identity-content','Submitted text');
  await f.$('#next-identity-form').dispatch('submit');await settle();
  assert.deepEqual(pending.payload,{content:'Submitted text',expectedRevision:1,expectedHash:hash('soul saved')});
  assert.equal(f.$('#next-identity-save').disabled,true);
  await f.input('#next-identity-content','Newer unsaved text');saving.resolve();await settle();
  assert.equal(f.$('#next-identity-content').value,'Newer unsaved text');
  assert.match(f.$('#next-identity-state').textContent,/Unsaved changes/);
  assert.equal(f.documents.soul.content,'Submitted text');
  await f.submit();assert.equal(f.documents.soul.content,'Newer unsaved text');
  assert.equal(f.calls.filter(call=>call.method==='PUT').at(-1).payload.expectedRevision,2);
  assert.equal(f.$('#next-identity-save').disabled,true);
});

test('late document reads cannot revive an old selection or replace newer reads after leave',async t=>{
  const first=deferred(),second=deferred();let soulReads=0;
  const f=fixture(t,{request:async(call,backend)=>{
    if(call.path==='/api/identity/soul'&&call.method==='GET')return ++soulReads===1?first.promise:second.promise;
    return backend(call.path,call.method,call.payload);
  }});
  f.panel.enter();await f.click('#next-identity-user');await settle();
  assert.equal(f.$('#next-identity-content').value,'user saved');
  f.panel.leave();assert.equal(f.calls[0].signal.aborted,true);
  await f.click('#next-identity-soul');f.panel.enter();second.resolve(doc('soul',2,'Current file'));await settle();
  await f.input('#next-identity-content','Current draft');first.resolve(doc('soul',1,'Stale file'));await settle();
  assert.equal(f.$('#next-identity-content').value,'Current draft');
  assert.match(f.$('#next-identity-state').textContent,/Unsaved changes/);
  assert.equal(f.calls.some(call=>call.method!=='GET'),false);
});

test('a changed disk file preserves the draft and conflict error until an explicit resolution',async t=>{
  const f=fixture(t);f.panel.enter();await settle();await f.input('#next-identity-content','My kept draft');
  f.documents.soul=doc('soul',2,'An external edit');await f.submit();
  assert.equal(f.$('#next-identity-content').value,'My kept draft');
  assert.equal(f.$('#next-identity-conflict').hidden,false);
  assert.match(f.$('#next-identity-notice').textContent,/changed since it was opened/);
  assert.equal(f.$('#next-identity-notice').dataset.error,'true');
  await f.click('#next-identity-user');await settle();await f.click('#next-identity-soul');
  assert.match(f.$('#next-identity-notice').textContent,/changed since it was opened/);
  assert.equal(f.calls.filter(call=>call.method==='PUT').length,1,'Conflict handling must never replay a save.');
  await f.click('#next-identity-keep-draft');assert.equal(f.$('#next-identity-content').value,'My kept draft');
  await f.submit();assert.equal(f.documents.soul.content,'My kept draft');
  assert.equal(f.calls.filter(call=>call.method==='PUT').at(-1).payload.expectedRevision,2);
});

test('reload checks external changes without discarding a draft and file selection retains recovery',async t=>{
  const f=fixture(t);f.panel.enter();await settle();await f.input('#next-identity-content','An unsaved draft');
  f.documents.soul=doc('soul',2,'Current disk');await f.click('#next-identity-reload');await settle();
  assert.equal(f.$('#next-identity-content').value,'An unsaved draft');assert.equal(f.$('#next-identity-conflict').hidden,false);
  await f.click('#next-identity-use-file');assert.equal(f.$('#next-identity-content').value,'Current disk');
  assert.equal(f.$('#next-identity-recover').hidden,false);await f.click('#next-identity-recover');
  assert.equal(f.$('#next-identity-content').value,'An unsaved draft');assert.equal(f.$('#next-identity-save').disabled,false);
  assert.equal(f.calls.some(call=>call.method!=='GET'),false);
});

test('version metadata stays lazy and bounded; explicit restore retains an unsaved draft',async t=>{
  const f=fixture(t);f.documents.soul=doc('soul',150,'Current saved');
  f.histories.soul=Array.from({length:150},(_,index)=>doc('soul',150-index,'Version content '+(150-index)));
  f.panel.enter();await settle();assert.equal(f.calls.length,1);
  await f.input('#next-identity-content','Unsaved before restore');await f.click('#next-identity-history');await settle();
  assert.equal(f.$('#next-identity-versions').querySelectorAll('li').length,10);
  assert.equal(f.mount.textContent.includes('Version content'),false,'History must not render full saved content.');
  await f.click('#next-identity-more');assert.equal(f.$('#next-identity-versions').querySelectorAll('li').length,20);
  const row=f.$('[data-identity-revision="149"]');await f.click(row);await settle();
  const restore=f.calls.find(call=>call.path.endsWith('/restore'));
  assert.deepEqual(restore.payload,{expectedRevision:150,expectedHash:hash('Current saved'),revision:149});
  assert.equal(f.$('#next-identity-content').value,'Version content 149');assert.match(f.$('#next-identity-notice').textContent,/Restored revision 149 as revision 151/);
  await f.click('#next-identity-recover');assert.equal(f.$('#next-identity-content').value,'Unsaved before restore');
  for(let i=0;i<12;i++)await f.click('#next-identity-more');
  assert.equal(f.$('#next-identity-versions').querySelectorAll('li').length,100);
  assert.equal(f.$('#next-identity-more').hidden,true);
});

test('a mutation receipt follows its original document when the user switches or leaves',async t=>{
  const saving=deferred();
  const f=fixture(t,{request:async(call,backend)=>{if(call.method==='PUT')await saving.promise;return backend(call.path,call.method,call.payload);}});
  f.panel.enter();await settle();await f.input('#next-identity-content','Saved while elsewhere');
  await f.$('#next-identity-form').dispatch('submit');await f.click('#next-identity-user');await settle();
  await f.input('#next-identity-content','User stays unsaved');f.panel.leave();saving.resolve();await settle();
  assert.equal(f.notifications.length,0,'A hidden panel does not interrupt the active workspace with a save toast.');
  f.panel.enter();await settle();assert.equal(f.$('#next-identity-content').value,'User stays unsaved');
  await f.click('#next-identity-soul');assert.equal(f.$('#next-identity-content').value,'Saved while elsewhere');
  assert.match(f.$('#next-identity-notice').textContent,/saved · revision 2/);
  assert.equal(f.calls.filter(call=>call.method==='PUT').length,1);
});

test('read, history and uncertain save failures remain visible across navigation without mutation retries',async t=>{
  let failRead=true;
  const f=fixture(t,{request:async(call,backend)=>{
    if(call.method==='PUT')throw Error('The save receipt was lost. Reload before trying again.');
    if(call.path.endsWith('/versions'))throw Error('History is temporarily unavailable.');
    if(failRead&&call.path.endsWith('/soul'))throw Error('Identity could not be read.');
    return backend(call.path,call.method,call.payload);
  }});
  f.panel.enter();await settle();assert.match(f.$('#next-identity-notice').textContent,/could not be read/);
  assert.equal(f.$('#next-identity-save').disabled,true);failRead=false;
  await f.click('#next-identity-reload');await settle();await f.input('#next-identity-content','Retain this');await f.submit();
  assert.equal(f.$('#next-identity-content').value,'Retain this');assert.match(f.$('#next-identity-notice').textContent,/receipt was lost/);
  await f.click('#next-identity-history');await settle();assert.match(f.$('#next-identity-history-info').textContent,/temporarily unavailable/);
  await f.click('#next-identity-user');await settle();await f.click('#next-identity-soul');
  assert.match(f.$('#next-identity-notice').textContent,/receipt was lost/);
  assert.match(f.$('#next-identity-history-info').textContent,/temporarily unavailable/);
  assert.equal(f.calls.filter(call=>call.method==='PUT').length,1);
});

test('identity subscribes only while entered and reloads missed updates without losing drafts',async t=>{
  const f=fixture(t);assert.equal(f.listeners.size,0);f.panel.enter();await settle();
  assert.equal(f.listeners.size,1);const enteredReads=f.calls.length;f.panel.enter();await settle();
  assert.equal(f.listeners.size,1);assert.equal(f.calls.length,enteredReads,'Repeated enter is idempotent.');
  await f.input('#next-identity-content','Local draft');
  f.documents.soul=doc('soul',2,'Changed by another turn');await f.event();
  assert.equal(f.$('#next-identity-content').value,'Local draft');assert.equal(f.$('#next-identity-conflict').hidden,false);
  f.panel.leave();assert.equal(f.listeners.size,0);const reads=f.calls.length;
  f.documents.soul=doc('soul',3,'Changed while hidden');await f.event();assert.equal(f.calls.length,reads);
  f.panel.enter();await settle();assert.equal(f.listeners.size,1);assert.equal(f.calls.length,reads+1);
  assert.equal(f.$('#next-identity-content').value,'Local draft');await f.click('#next-identity-use-file');
  assert.equal(f.$('#next-identity-content').value,'Changed while hidden');
  f.panel.leave();assert.equal(f.listeners.size,0);const finalReads=f.calls.length;
  f.panel.destroy();assert.equal(f.listeners.size,0);assert.equal(f.mount.textContent,'');
  f.panel.enter();assert.equal(f.calls.length,finalReads);
});
