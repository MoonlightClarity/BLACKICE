import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createDirectoryInspector} from '../public/next/chat/artifacts.mjs';

const resultFile='runs/run-a/modules/1/result.json';
const sourceFile='runs/run-b/modules/1/result.json';
const summaryFile='conversation/context/summary.json';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(t){
  const dom=planningDOM(t),actions=dom.document.createElement('div');actions.className='next-chat-head-actions';dom.mount.append(actions);
  const turn={id:'run-a-t0001',runId:'run-a',label:'work',module:'modules/1',excerpt:'The current conversation only.',at:'2026-11-12T18:00:00Z'};
  const a=new Map([
    [summaryFile,{value:{conversationId:'conversation-a',currentRun:'run-a',userSummary:'A notes',pinnedConstraints:['A constraint']},editableFields:['userSummary','pinnedConstraints']}],
    ['conversation/context/turns.json',{value:[turn],editableFields:[]}],
    [resultFile,{value:{finding:'A finding',candidate_answer:'A answer',uncertainty:''},editableFields:['finding','candidate_answer','uncertainty']}],
    ['runs/run-a/turns/run-a-t0001.json',{value:turn,editableFields:[]}],
    ['conversation/context/audit.json',{value:[],editableFields:[],editable:false,deletable:false,replaceable:false,importable:false}],
  ]);
  const b=new Map([
    [summaryFile,{value:{conversationId:'conversation-b',currentRun:'run-b',userSummary:'B notes'},editableFields:['userSummary','pinnedConstraints']}],
    [sourceFile,{value:{finding:'B finding',candidate_answer:'B answer',uncertainty:''},editableFields:['finding','candidate_answer','uncertainty']}],
  ]);
  const scopes=new Map([['run-a',a],['run-b',b]]),calls=[],edits=[];let getRunId='run-a',currentScope=null,hook;
  const metadata=(file,row)=>({file,bytes:JSON.stringify(row.value).length,kind:'context',editable:true,deletable:true,replaceable:true,importable:true,managedEditId:null,...row,hash:hash(row.value)});
  const request=async(route,method='GET',body)=>{
    const url=new URL(route,'http://fixture'),runId=body?.runId||url.searchParams.get('runId'),scope=scopes.get(runId);
    if(url.pathname.endsWith('/conversations'))return{currentConversationId:'conversation-a',conversations:[
      {conversationId:'conversation-a',runId:'run-a',title:'Current project',state:'active',current:true},
      {conversationId:'conversation-b',runId:'run-b',title:'Other project',state:'active',current:false},
    ]};
    if(!scope)throw Error('Unknown fixture conversation: '+runId);
    if(method==='GET'&&url.pathname.endsWith('/file')){
      const file=url.searchParams.get('file'),row=scope.get(file);if(!row)throw Error('File absent');return structuredClone(metadata(file,row));
    }
    if(method==='GET'&&url.pathname.endsWith('/audit'))return{items:edits.filter(row=>row.runId===runId).slice().reverse()};
    if(method==='GET')return{conversationId:runId==='run-a'?'conversation-a':'conversation-b',summary:scope.get(summaryFile)?.value||{},files:[...scope].map(([file,row])=>metadata(file,row))};
    if(url.pathname.endsWith('/import')){
      const row=scopes.get(body.sourceRunId).get(body.sourceFile);assert.equal(body.expectedSourceHash,hash(row.value));
      const file='conversation/context/imports/import-one.json';scope.set(file,{value:{content:structuredClone(row.value),importedFrom:{conversationId:'conversation-b',file:body.sourceFile}},editableFields:['content']});
      edits.push({...body,file,action:'import',at:'2026-11-12T18:01:00Z'});return{file};
    }
    const row=scope.get(body.file);assert.equal(body.expectedHash,hash(row.value));
    if(url.pathname.endsWith('/edit')){row.value=Object.hasOwn(body,'value')?structuredClone(body.value):{...row.value,...body.changes};edits.push({...body,action:'edit',at:'2026-11-12T18:02:00Z'});return{file:body.file,hash:hash(row.value)};}
    if(url.pathname.endsWith('/delete')){scope.delete(body.file);edits.push({...body,action:'delete',at:'2026-11-12T18:03:00Z'});return{file:body.file};}
    throw Error('Unexpected route '+route);
  };
  const api=async(route,method='GET',body)=>{calls.push({route,method,body:structuredClone(body)});const special=hook?.(route,method,body);return special===undefined?request(route,method,body):special;};
  const inspector=createDirectoryInspector({frame:dom.mount,getRunId:()=>getRunId,getConversationId:()=>currentScope,api});
  t.after(()=>inspector.destroy());
  return{dom,inspector,calls,scopes,edits,request,hook:fn=>hook=fn,setRunId:id=>getRunId=id,setScope:id=>currentScope=id,
    select:async id=>{const select=dom.$('.next-directory-conversation');select.value=id;await select.dispatch('change');},
    openFile:async file=>{await dom.click('[data-context-tab="files"]');await dom.click('[data-context-file="'+file+'"]');},
  };
}

test('opening Context defaults to the current conversation and groups only metadata for other conversations',async t=>{
  const f=fixture(t);await f.inspector.open();
  assert.equal(f.dom.$('.next-directory-conversation').value,'run-a');
  assert.equal(f.dom.$('.next-directory-scope-badge').textContent,'Current conversation');
  assert.equal(f.dom.$('.next-directory-group-title').textContent,'Current project');
  assert.deepEqual(f.dom.$('.next-directory-conversation').children.map(node=>node.getAttribute('label')),['Current conversation','Other conversations']);
  assert.equal(f.calls.some(row=>row.route.includes('runId=run-b')),false,'No other conversation content is fetched by the catalog');
  await f.dom.click('[data-context-tab="files"]');
  assert.ok(f.dom.$('[data-context-file="'+resultFile+'"]'));
  assert.equal(f.dom.$('[data-context-file="'+sourceFile+'"]'),null);
  assert.equal(f.calls.filter(row=>row.method!=='GET').length,0);
});

test('field editing saves the selected record with its observed revision and preserves unrelated conversation context',async t=>{
  const f=fixture(t);await f.inspector.open();await f.openFile(resultFile);
  const before=structuredClone(f.scopes.get('run-b').get(sourceFile).value),expectedHash=hash(f.scopes.get('run-a').get(resultFile).value);
  await f.dom.click('.next-directory-edit');await f.dom.input('[data-context-field="finding"]','Corrected finding');await f.dom.click('.next-directory-save');
  const mutation=f.calls.find(row=>row.method==='POST');
  assert.deepEqual(mutation.body,{runId:'run-a',file:resultFile,expectedHash,expectedManagedEditId:null,reason:'Edited in Context',changes:{finding:'Corrected finding'}});
  assert.equal(f.scopes.get('run-a').get(resultFile).value.finding,'Corrected finding');
  assert.deepEqual(f.scopes.get('run-b').get(sourceFile).value,before);
  assert.equal(f.dom.$('.next-directory-edit-panel').hidden,true);
  assert.match(f.dom.$('.next-directory-status').textContent,/saved.*refresh/i);
});

test('a generated model turn can be edited as complete JSON or deleted without removing a conversation',async t=>{
  const f=fixture(t);await f.inspector.open();await f.dom.click('[data-context-tab="turns"]');
  const file='runs/run-a/turns/run-a-t0001.json';await f.dom.click('[data-context-file="'+file+'"]');
  assert.equal(f.dom.$('.next-directory-edit').hidden,false);
  await f.dom.click('.next-directory-edit');
  assert.equal(f.dom.$('.next-directory-contents').readOnly,false);
  const next={...f.scopes.get('run-a').get(file).value,excerpt:'Corrected observation'};
  f.dom.$('.next-directory-contents').value=JSON.stringify(next);await f.dom.click('.next-directory-save');
  assert.deepEqual(f.calls.find(row=>row.method==='POST').body.value,next);
  await f.dom.click('.next-directory-delete');
  assert.equal(f.scopes.get('run-a').has(file),false);
  assert.equal(f.scopes.get('run-a').has(summaryFile),true);
  assert.equal(f.scopes.get('run-b').has(sourceFile),true);
  assert.match(f.dom.$('.next-directory-status').textContent,/deleted/);
});

test('explicit import copies one selected foreign record into the original current conversation',async t=>{
  const f=fixture(t);await f.inspector.open();const sourceBefore=structuredClone([...f.scopes.get('run-b')]);await f.select('run-b');
  assert.equal(f.dom.$('.next-directory-scope-badge').textContent,'Viewing another conversation');
  f.inspector.refresh('run-a');assert.equal(f.dom.$('.next-directory-inspector').open,true,'Ordinary chat refresh preserves explicit source browsing');
  await f.openFile(sourceFile);assert.equal(f.dom.$('.next-directory-import').hidden,false);
  assert.equal(f.calls.some(row=>row.method==='POST'),false,'Choosing and reading another conversation does not import it');
  await f.dom.click('.next-directory-import');
  const imported=f.calls.find(row=>row.route.endsWith('/import'));
  assert.deepEqual(imported.body,{runId:'run-a',sourceRunId:'run-b',sourceFile,expectedSourceHash:hash(f.scopes.get('run-b').get(sourceFile).value),expectedSourceManagedEditId:null,reason:'Imported into current conversation in Context'});
  assert.equal(f.dom.$('.next-directory-conversation').value,'run-a');
  assert.equal(f.dom.$('.next-directory-scope-badge').textContent,'Current conversation');
  assert.equal(f.scopes.get('run-a').get('conversation/context/imports/import-one.json').value.content.finding,'B finding');
  assert.deepEqual([...f.scopes.get('run-b')],sourceBefore);
  assert.equal(f.dom.$('.next-directory-import').hidden,true);
});

test('revision conflicts preserve the edit draft and do not silently resend changes',async t=>{
  const f=fixture(t);await f.inspector.open();await f.openFile(resultFile);await f.dom.click('.next-directory-edit');
  await f.dom.input('[data-context-field="finding"]','My draft');
  f.hook((route,method)=>method==='POST'?Promise.reject(Object.assign(Error('This file changed; reload before editing.'),{status:409})):undefined);
  await f.dom.click('.next-directory-save');
  assert.equal(f.dom.$('[data-context-field="finding"]').value,'My draft');assert.equal(f.dom.$('.next-directory-edit-panel').hidden,false);
  assert.match(f.dom.$('.next-directory-status').textContent,/not saved.*changed/);
  assert.equal(f.calls.filter(row=>row.method==='POST').length,1);
  assert.equal(f.scopes.get('run-a').get(resultFile).value.finding,'A finding');
});

test('invalid JSON stays in the editor and never starts a context mutation',async t=>{
  const f=fixture(t);await f.inspector.open();await f.openFile(resultFile);await f.dom.click('.next-directory-edit-json');
  f.dom.$('.next-directory-contents').value='{broken';await f.dom.click('.next-directory-save');
  assert.equal(f.calls.filter(row=>row.method==='POST').length,0);assert.equal(f.dom.$('.next-directory-contents').value,'{broken');
  assert.match(f.dom.$('.next-directory-status').textContent,/valid JSON/);
});

test('a delayed file response cannot overwrite a different selected conversation',async t=>{
  const f=fixture(t);await f.inspector.open();await f.dom.click('[data-context-tab="files"]');const pending=deferred();
  const route='/api/shadowdancer/context/file?runId=run-a&file='+encodeURIComponent(resultFile);const saved=await f.request(route);
  f.hook(url=>url===route?pending.promise:undefined);const reading=f.dom.click('[data-context-file="'+resultFile+'"]');
  await f.select('run-b');pending.resolve(saved);await reading;
  assert.equal(f.dom.$('.next-directory-conversation').value,'run-b');
  assert.match(f.dom.$('.next-directory-contents').value,/B notes/);assert.doesNotMatch(f.dom.$('.next-directory-contents').value,/A finding/);
});

test('change history is conversation scoped and current chat changes close the inspector',async t=>{
  const f=fixture(t);await f.inspector.open();await f.openFile(resultFile);await f.dom.click('.next-directory-delete');await f.dom.click('[data-context-tab="history"]');
  assert.ok(f.calls.some(row=>row.route==='/api/shadowdancer/context/audit?runId=run-a'));
  assert.match(f.dom.$('.next-directory-records').textContent,/delete/);
  f.inspector.refresh('run-b');assert.equal(f.dom.$('.next-directory-inspector').open,false);
});


test('same-conversation run updates keep an open editor while an actual Chat switch closes it',async t=>{
  const f=fixture(t);f.setScope('conversation-a');await f.inspector.open();await f.openFile(resultFile);await f.dom.click('.next-directory-edit');await f.dom.input('[data-context-field="finding"]','Unfinished draft');
  f.setRunId('run-a-new');f.inspector.refresh('run-a-new');
  assert.equal(f.dom.$('.next-directory-inspector').open,true);assert.equal(f.dom.$('[data-context-field="finding"]').value,'Unfinished draft');
  f.setScope('conversation-b');f.inspector.refresh('run-b');assert.equal(f.dom.$('.next-directory-inspector').open,false);
});

test('editing and deleting while viewing another conversation targets that selected conversation',async t=>{
  const f=fixture(t);await f.inspector.open();const untouched=structuredClone(f.scopes.get('run-a').get(resultFile).value);await f.select('run-b');await f.openFile(sourceFile);await f.dom.click('.next-directory-edit');
  await f.dom.input('[data-context-field="finding"]','Corrected B');await f.dom.click('.next-directory-save');
  assert.equal(f.calls.find(row=>row.method==='POST').body.runId,'run-b');assert.equal(f.scopes.get('run-b').get(sourceFile).value.finding,'Corrected B');assert.deepEqual(f.scopes.get('run-a').get(resultFile).value,untouched);
  await f.dom.click('.next-directory-delete');assert.equal(f.calls.filter(row=>row.method==='POST').at(-1).body.runId,'run-b');assert.equal(f.scopes.get('run-b').has(sourceFile),false);assert.deepEqual(f.scopes.get('run-a').get(resultFile).value,untouched);
});


test('saved context overlays remain visible after generated records refresh and edits use both observed revisions',async t=>{
  const f=fixture(t),canonical={conversationId:'conversation-a',currentRun:'run-a',userSummary:'Generated summary',pinnedConstraints:['Generated constraint']},managed={userSummary:'My retained notes',pinnedConstraints:['My retained constraint']};
  f.scopes.get('run-a').get(summaryFile).value=canonical;
  const row=f.scopes.get('run-a').get(summaryFile);Object.assign(row,{managedValue:managed,managedEditId:'edit-7',managedHash:'managed-hash',editMode:'fields'});
  f.hook((route,method)=>{
    if(method==='GET'&&route==='/api/shadowdancer/context?runId=run-a')return f.request(route).then(value=>({...value,managedSummary:row.managedValue,managedSummaryEditId:row.managedEditId,managedSummaryEditMode:'fields'}));
  });
  await f.inspector.open();assert.match(f.dom.$('.next-directory-contents').value,/My retained notes/);
  await f.openFile(summaryFile);
  assert.match(f.dom.$('.next-directory-contents').value,/My retained notes/);assert.doesNotMatch(f.dom.$('.next-directory-contents').value,/Generated summary/);
  assert.equal(f.dom.$('.next-directory-generated').hidden,false);assert.match(f.dom.$('.next-directory-generated-contents').value,/Generated summary/);
  await f.dom.click('.next-directory-edit');assert.equal(f.dom.$('[data-context-field="userSummary"]').value,'My retained notes');await f.dom.input('[data-context-field="userSummary"]','My second correction');
  f.hook((route,method,body)=>{
    if(method==='POST'&&route.endsWith('/edit')){assert.equal(body.expectedHash,hash(canonical));assert.equal(body.expectedManagedEditId,'edit-7');assert.deepEqual(body.changes,{userSummary:'My second correction'});row.managedValue={...row.managedValue,...body.changes};row.managedEditId='edit-8';return Promise.resolve({status:'edited'});}
    if(method==='GET'&&route==='/api/shadowdancer/context?runId=run-a')return f.request(route).then(value=>({...value,managedSummary:row.managedValue,managedSummaryEditId:row.managedEditId,managedSummaryEditMode:'fields'}));
  });
  await f.dom.click('.next-directory-save');assert.equal(JSON.parse(f.dom.$('.next-directory-contents').value).userSummary,'My second correction');
  row.value={...canonical,currentRun:'run-a-next',userSummary:'Another generated summary'};await f.inspector.open();await f.openFile(summaryFile);
  assert.match(f.dom.$('.next-directory-contents').value,/My second correction/);assert.match(f.dom.$('.next-directory-generated-contents').value,/Another generated summary/);
  await f.dom.click('.next-directory-edit-json');
  assert.deepEqual(JSON.parse(f.dom.$('.next-directory-contents').value),row.managedValue,'Full replacement begins with saved user context, without accidentally re-importing generated fields');
});

test('explicit import and delete retain the observed managed-context identity',async t=>{
  const f=fixture(t),row=f.scopes.get('run-b').get(sourceFile);Object.assign(row,{managedValue:{finding:'User-corrected foreign context'},managedEditId:'edit-9',editMode:'replace'});
  await f.inspector.open();await f.select('run-b');await f.openFile(sourceFile);
  assert.deepEqual(JSON.parse(f.dom.$('.next-directory-contents').value),row.managedValue);
  await f.dom.click('.next-directory-import');assert.equal(f.calls.find(call=>call.route.endsWith('/import')).body.expectedSourceManagedEditId,'edit-9');
  await f.select('run-b');await f.openFile(sourceFile);await f.dom.click('.next-directory-delete');assert.equal(f.calls.find(call=>call.route.endsWith('/delete')).body.expectedManagedEditId,'edit-9');
});


test('older audit history remains reachable through conversation-scoped pagination',async t=>{
  const f=fixture(t),rows=Array.from({length:83},(_,index)=>({id:'edit-'+(83-index),file:resultFile,action:'edit',at:'2026-11-12T18:00:00Z',reason:'Saved change '+index}));
  f.hook((route,method)=>{
    const url=new URL(route,'http://fixture');if(method==='GET'&&url.pathname.endsWith('/audit')){
      assert.equal(url.searchParams.get('runId'),'run-a');const offset=Number(url.searchParams.get('offset')||0),items=rows.slice(offset,offset+80);
      return Promise.resolve({items,total:rows.length,offset,nextOffset:offset+items.length<rows.length?offset+items.length:null});
    }
  });
  await f.inspector.open();await f.dom.click('[data-context-tab="history"]');
  assert.equal(f.dom.$('.next-directory-history-more').hidden,false);assert.match(f.dom.$('.next-directory-contents').value,/80 of 83/);
  await f.dom.click('.next-directory-history-more');assert.ok(f.calls.some(row=>row.route.endsWith('/audit?runId=run-a&offset=80')));
  assert.equal(f.dom.$('.next-directory-records').querySelectorAll('button').length,83);assert.equal(f.dom.$('.next-directory-history-more').hidden,true);
});

test('large context fields are shown and saved in full without a UI truncation limit',async t=>{
  const f=fixture(t),content='Long contextual evidence. '.repeat(22000)+'END_OF_CONTEXT';f.scopes.get('run-a').get(resultFile).value.finding=content;
  await f.inspector.open();await f.openFile(resultFile);assert.equal(JSON.parse(f.dom.$('.next-directory-contents').value).finding,content);
  await f.dom.click('.next-directory-edit');assert.equal(f.dom.$('[data-context-field="finding"]').value,content);
  const revised=content+' USER_CORRECTION';await f.dom.input('[data-context-field="finding"]',revised);await f.dom.click('.next-directory-save');
  assert.equal(f.calls.find(row=>row.method==='POST').body.changes.finding,revised);assert.equal(f.scopes.get('run-a').get(resultFile).value.finding,revised);
});


test('editing one field does not promote unchanged generated values into user context',async t=>{
  const f=fixture(t),row=f.scopes.get('run-a').get(resultFile);Object.assign(row,{managedValue:{finding:'My prior correction'},managedEditId:'edit-10',editMode:'fields'});
  row.value={finding:'Regenerated finding',candidate_answer:'New generated answer',uncertainty:'Generated uncertainty'};
  await f.inspector.open();await f.openFile(resultFile);await f.dom.click('.next-directory-edit');
  await f.dom.input('[data-context-field="finding"]','My updated correction');await f.dom.click('.next-directory-save');
  assert.deepEqual(f.calls.find(call=>call.method==='POST').body.changes,{finding:'My updated correction'});
});


const flushRefresh=()=>new Promise(resolve=>setImmediate(resolve));
async function refreshTick(t){t.mock.timers.tick(2000);await flushRefresh();}

test('open Directory audit refreshes new context and model turns without reopening',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.inspector.open();
  const scope=f.scopes.get('run-a'),turn={id:'run-a-t0002',runId:'run-a',label:'work',module:'modules/2'};
  scope.get('conversation/context/turns.json').value.push(turn);
  scope.set('runs/run-a/turns/run-a-t0002.json',{value:turn,editableFields:[]});
  await refreshTick(t);
  const overview=JSON.parse(f.dom.$('.next-directory-contents').value);
  assert.equal(overview.auditRecords,2);assert.equal(overview.contextFiles,6);
  assert.equal(f.dom.$('.next-directory-inspector').open,true);
  await f.dom.click('[data-context-tab="turns"]');
  assert.ok(f.dom.$('[data-context-file="runs/run-a/turns/run-a-t0002.json"]'));
  assert.equal(f.calls.filter(row=>row.method!=='GET').length,0);
});

test('live refresh preserves selected file, filter and scroll while updating its contents',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.inspector.open();await f.openFile(resultFile);
  f.dom.$('.next-directory-filter').value='result';
  f.dom.$('.next-directory-contents').scrollTop=117;f.dom.$('.next-directory-records').scrollTop=42;
  f.scopes.get('run-a').get(resultFile).value.finding='Fresh finding';
  await refreshTick(t);
  assert.equal(JSON.parse(f.dom.$('.next-directory-contents').value).finding,'Fresh finding');
  assert.equal(f.dom.$('.next-directory-file-label').textContent,resultFile);
  assert.equal(f.dom.$('.next-directory-filter').value,'result');
  assert.equal(f.dom.$('.next-directory-contents').scrollTop,117);
  assert.equal(f.dom.$('.next-directory-records').scrollTop,42);
});

test('refresh pauses for drafts and cannot replace a draft started during its pending read',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.inspector.open();await f.openFile(resultFile);
  const pending=deferred();f.hook(route=>route==='/api/shadowdancer/context?runId=run-a'?pending.promise:undefined);
  t.mock.timers.tick(2000);await flushRefresh();
  await f.dom.click('.next-directory-edit');await f.dom.input('[data-context-field="finding"]','Keep my draft');
  pending.resolve(await f.request('/api/shadowdancer/context?runId=run-a'));await flushRefresh();
  const count=f.calls.length;await refreshTick(t);
  assert.equal(f.calls.length,count);assert.equal(f.dom.$('[data-context-field="finding"]').value,'Keep my draft');
  f.hook(()=>undefined);await f.dom.click('.next-directory-cancel');await refreshTick(t);
  assert.ok(f.calls.length>count);
});

test('live refresh has no overlapping request cycles and close prevents late updates',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.inspector.open();const pending=deferred();
  f.hook(route=>route==='/api/shadowdancer/context?runId=run-a'?pending.promise:undefined);
  t.mock.timers.tick(2000);await flushRefresh();const count=f.calls.length;
  t.mock.timers.tick(10000);await flushRefresh();assert.equal(f.calls.length,count);
  await f.dom.click('.next-directory-close');
  pending.resolve(await f.request('/api/shadowdancer/context?runId=run-a'));await flushRefresh();
  t.mock.timers.tick(10000);await flushRefresh();
  assert.equal(f.calls.length,count);assert.equal(f.dom.$('.next-directory-inspector').open,false);
});

test('hidden pages skip audit polling and selected foreign conversation remains selected',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.inspector.open();await f.select('run-b');await f.openFile(sourceFile);
  await f.dom.visibility('hidden');const count=f.calls.length;await refreshTick(t);assert.equal(f.calls.length,count);
  f.scopes.get('run-b').get(sourceFile).value.finding='B updated';
  await f.dom.visibility('visible');await refreshTick(t);
  assert.equal(f.dom.$('.next-directory-conversation').value,'run-b');
  assert.equal(JSON.parse(f.dom.$('.next-directory-contents').value).finding,'B updated');
});

test('late refresh cannot overwrite a newly selected conversation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.inspector.open();const pending=deferred();
  f.hook(route=>route==='/api/shadowdancer/context?runId=run-a'?pending.promise:undefined);
  t.mock.timers.tick(2000);await flushRefresh();await f.select('run-b');
  pending.resolve(await f.request('/api/shadowdancer/context?runId=run-a'));await flushRefresh();
  assert.equal(f.dom.$('.next-directory-conversation').value,'run-b');
  assert.match(f.dom.$('.next-directory-contents').value,/B notes/);
  f.hook(()=>undefined);await refreshTick(t);assert.equal(f.dom.$('.next-directory-conversation').value,'run-b');
});

test('live history refresh retains older loaded changes and updates pagination',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t),rows=Array.from({length:83},(_,i)=>({id:'edit-'+i,file:resultFile,action:'edit',at:'2026-11-13'}));
  f.hook((route,method)=>{const u=new URL(route,'http://fixture');if(method==='GET'&&u.pathname.endsWith('/audit')){
    const offset=Number(u.searchParams.get('offset')||0),items=rows.slice(offset,offset+80);
    return Promise.resolve({items,total:rows.length,nextOffset:offset+items.length<rows.length?offset+items.length:null});
  }});
  await f.inspector.open();await f.dom.click('[data-context-tab="history"]');await f.dom.click('.next-directory-history-more');
  rows.unshift({id:'new-edit',file:'new-file',action:'edit',at:'2026-11-13'});await refreshTick(t);
  assert.equal(f.dom.$('.next-directory-records').querySelectorAll('button').length,84);
  assert.match(f.dom.$('.next-directory-records').textContent,/new-file/);
  assert.equal(f.dom.$('.next-directory-history-more').hidden,true);
});

test('failed background refresh retains readable content and retries next cycle',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.inspector.open();await f.openFile(resultFile);
  const before=f.dom.$('.next-directory-contents').value;
  f.hook(route=>route==='/api/shadowdancer/context?runId=run-a'?Promise.reject(Error('Temporary failure')):undefined);
  await refreshTick(t);assert.equal(f.dom.$('.next-directory-contents').value,before);
  assert.match(f.dom.$('.next-directory-status').textContent,/refresh failed/);
  f.hook(()=>undefined);f.scopes.get('run-a').get(resultFile).value.finding='Recovered';await refreshTick(t);
  assert.equal(JSON.parse(f.dom.$('.next-directory-contents').value).finding,'Recovered');
});

test('unchanged listings avoid refetching large turns and selected context bytes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.inspector.open();await f.openFile(resultFile);
  const count=f.calls.length;await refreshTick(t);await refreshTick(t);
  assert.deepEqual(f.calls.slice(count).map(row=>row.route),[
    '/api/shadowdancer/context?runId=run-a','/api/shadowdancer/context?runId=run-a']);
});

test('more than one new audit page never skips unseen middle records',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t),rows=Array.from({length:100},(_,i)=>({id:'old-'+i,file:resultFile,action:'edit',at:'2026-11-13'}));
  f.hook((route,method)=>{const u=new URL(route,'http://fixture');if(method==='GET'&&u.pathname.endsWith('/audit')){
    const offset=Number(u.searchParams.get('offset')||0),items=rows.slice(offset,offset+80);
    return Promise.resolve({items,total:rows.length,nextOffset:offset+items.length<rows.length?offset+items.length:null});
  }});
  await f.inspector.open();await f.dom.click('[data-context-tab="history"]');
  rows.unshift(...Array.from({length:100},(_,i)=>({id:'new-'+i,file:'new-'+i,action:'edit',at:'2026-11-13'})));
  await refreshTick(t);await f.dom.click('.next-directory-history-more');
  assert.ok(f.calls.at(-1).route.endsWith('offset=80'));
  assert.match(f.dom.$('.next-directory-records').textContent,/new-99/);
  await f.dom.click('.next-directory-history-more');
  assert.equal(f.dom.$('.next-directory-records').querySelectorAll('button').length,200);
});
test('failed selected-record refresh is retried despite unchanged listing metadata',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.inspector.open();await f.openFile(resultFile);
  f.scopes.get('run-a').get(resultFile).value.finding='New value';
  f.hook(route=>route.includes(encodeURIComponent(resultFile))?Promise.reject(Error('Read temporarily failed')):undefined);
  await refreshTick(t);f.hook(()=>undefined);await refreshTick(t);
  assert.equal(JSON.parse(f.dom.$('.next-directory-contents').value).finding,'New value');
});

test('overview refresh preserves reading scroll and selection',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);await f.inspector.open();const el=f.dom.$('.next-directory-contents');
  el.scrollTop=123;el.setSelectionRange(5,20);
  f.scopes.get('run-a').get(summaryFile).value.userSummary='Updated';
  await refreshTick(t);assert.equal(el.scrollTop,123);assert.equal(el.selectionStart,5);assert.equal(el.selectionEnd,20);
});
test('initial model-turn read failure recovers on the next visible refresh',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);f.hook(route=>route.includes(encodeURIComponent('conversation/context/turns.json'))?Promise.reject(Error('Temporary turns failure')):undefined);
  await f.inspector.open();assert.match(f.dom.$('.next-directory-status').textContent,/could not be loaded/);
  f.hook(()=>undefined);await refreshTick(t);assert.equal(JSON.parse(f.dom.$('.next-directory-contents').value).auditRecords,1);
});
