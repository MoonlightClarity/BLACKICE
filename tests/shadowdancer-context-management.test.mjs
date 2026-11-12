import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  listShadowdancerContext,readShadowdancerFile,editShadowdancerContext,
  deleteShadowdancerContext,importShadowdancerContext,readManagedDirectoryContext,contextAuditHistory,
} from '../lib/shadowdancer-context.mjs';
import {handleShadowdancerContextHttp} from '../lib/shadowdancer-context-http.mjs';
import {createShadowdancerContextToolHandler} from '../lib/shadowdancer-context-tool.mjs';

const put=async(file,value)=>{await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));};
async function fixture(t){
  const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-context-management-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const scope=conversationId=>({cwd,conversationId});
  const root=conversationId=>path.join(cwd,'.shadowdancer',conversationId);
  const relative={summary:'conversation/context/summary.json',result:'runs/run-a/modules/1/result.json',final:'runs/run-a/integration/final.json',turn:'runs/run-a/turns/run-a-t0001.json'};
  const turn={id:'run-a-t0001',runId:'run-a',label:'work',excerpt:'Old observed work',module:'modules/1'};
  await put(path.join(root('a'),relative.summary),{conversationId:'a',currentRun:'run-a',userSummary:'Current conversation',totalTurns:1});
  await put(path.join(root('a'),relative.result),{finding:'Old result',verified:true});
  await put(path.join(root('a'),relative.final),{answer:'Old final',verified:true});
  await put(path.join(root('a'),relative.turn),turn);
  await put(path.join(root('a'),'conversation/context/turns.json'),[turn]);
  await put(path.join(root('b'),'conversation/context/summary.json'),{currentRun:'run-b',userSummary:'Foreign summary must stay out'});
  await put(path.join(root('b'),'runs/run-b/sources/page-0001/source.json'),{content:'EXPLICIT_SELECTED_SOURCE'});
  await put(path.join(root('b'),'runs/run-b/sources/page-0002/source.json'),{content:'UNSELECTED_FOREIGN_SOURCE'});
  const runs=new Map([
    ['run-a',{id:'run-a',taskId:'a',cwd,status:'completed',settled:true}],
    ['run-b',{id:'run-b',taskId:'b',cwd,status:'completed',settled:true}],
  ]);
  const summaries=[{rootId:'a',id:'run-a',latestRunId:'run-a',title:'Current',state:'active'},
    {rootId:'b',id:'run-b',latestRunId:'run-b',title:'Reference',state:'archived'},
    {rootId:'b',id:'old-b',latestRunId:'old-b',title:'Duplicate reference run',state:'archived'},
    {rootId:'deleted',id:'deleted',title:'Removed conversation',state:'deleted'}];
  const conversations={status:()=>({}),list:()=>summaries,get:async id=>{const run=runs.get(id)||[...runs.values()].find(run=>run.taskId===id);if(!run)throw Object.assign(Error('Missing run'),{status:404});return run;}};
  const engine={runs},events=[],mutations=new Set();
  async function request(suffix,method='GET',value){
    const req={url:'/api/shadowdancer/context'+suffix,method},res={};
    const handled=await handleShadowdancerContextHttp({req,res,pathname:req.url.split('?')[0],host:'localhost',conversations,engine,body:async(_req,maxBytes)=>{
      if(Buffer.byteLength(JSON.stringify(value))>maxBytes)throw Object.assign(Error('Request is too large.'),{status:413});return value;
    },
      json:(_,status,data)=>Object.assign(res,{status,data}),fileMutations:mutations,onUpdated:event=>events.push(event)});
    assert.equal(handled,true);assert.equal(mutations.size,0);
    return res;
  }
  return {cwd,scope,root,relative,conversations,engine,events,request};
}

test('managed execution context is empty for new conversations and never scans other conversations',async t=>{
  const f=await fixture(t);
  const empty=await readManagedDirectoryContext(f.scope('new'));
  assert.deepEqual(empty,{conversationId:'new',latestEditId:null,hasChanges:false,sources:[],deletedFiles:[],invalidatedRunIds:[]});
  const own=await readManagedDirectoryContext(f.scope('a'));
  assert.equal(own.sources.length,1);
  assert.equal(own.sources[0].value.userSummary,'Current conversation');
  assert.doesNotMatch(JSON.stringify(own),/Foreign|EXPLICIT_SELECTED_SOURCE|UNSELECTED_FOREIGN_SOURCE/);
});

test('catalog groups metadata by conversation without loading any conversation contents',async t=>{
  const f=await fixture(t),result=await f.request('/conversations?runId=run-a');
  assert.equal(result.status,200);
  assert.equal(result.data.currentConversationId,'a');
  assert.deepEqual(result.data.conversations.map(row=>[row.conversationId,row.current]),[['a',true],['b',false]]);
  assert.equal(result.data.metadataOnly,true);
  assert.doesNotMatch(JSON.stringify(result.data),/EXPLICIT_SELECTED_SOURCE|Foreign summary|Current conversation/);
  const listing=await f.request('?runId=run-a');
  assert.equal(listing.data.conversationId,'a');
  assert.ok(listing.data.files.every(row=>!row.file.includes('run-b')));
});

test('full JSON corrections of generated context preserve original revision and invalidate derived answer',async t=>{
  const f=await fixture(t),file=f.relative.final,prior=await readShadowdancerFile({...f.scope('a'),file});
  assert.equal(prior.replaceable,true);assert.equal(prior.deletable,true);
  const result=await f.request('/edit','POST',{runId:'run-a',file,expectedHash:prior.hash,value:{answer:'User corrected result',verified:true},reason:'Correct context'});
  assert.equal(result.status,200,JSON.stringify(result));
  const revised=await readShadowdancerFile({...f.scope('a'),file});
  assert.equal(revised.value.answer,'User corrected result');assert.equal(revised.value.verified,false);
  assert.deepEqual(result.data.invalidatedRuns,['run-a']);
  const before=JSON.parse(await readFile(path.join(f.root('a'),'conversation/context/revisions',result.data.editId,'before.json')));
  assert.equal(before.answer,'Old final');
  const managed=await readManagedDirectoryContext(f.scope('a'));
  assert.equal(managed.sources.find(row=>row.file===file).value.answer,'User corrected result');
  assert.doesNotMatch(JSON.stringify(managed),/Old final/);
  assert.equal((await f.request('/edit','POST',{runId:'run-a',file,expectedHash:prior.hash,value:{answer:'Lost update'},reason:'Old revision'})).status,409);
});

test('deleting a turn removes its exact file and index entry and produces a removal marker',async t=>{
  const f=await fixture(t),file=f.relative.turn,prior=await readShadowdancerFile({...f.scope('a'),file});
  const response=await f.request('/delete','POST',{runId:'run-a',file,expectedHash:prior.hash,reason:'Remove obsolete context'});
  assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.data.deleted,true);
  await assert.rejects(readFile(path.join(f.root('a'),file)),{code:'ENOENT'});
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root('a'),'conversation/context/turns.json'))),[]);
  assert.equal(JSON.parse(await readFile(path.join(f.root('a'),f.relative.summary))).totalTurns,0);
  assert.ok(!(await listShadowdancerContext(f.scope('a'))).files.some(row=>row.file===file));
  const managed=await readManagedDirectoryContext(f.scope('a'));
  assert.deepEqual(managed.deletedFiles.map(row=>row.file),[file]);
  assert.doesNotMatch(JSON.stringify(managed),/Old observed work/);
  assert.equal((await f.request('/delete','POST',{runId:'run-a',file,expectedHash:prior.hash,reason:'Same action'})).status,409);
  assert.equal(f.events.at(-1).type,'shadowdancer.context.deleted');
});

test('editing an individual turn updates the shared index without changing its saved identity',async t=>{
  const f=await fixture(t),file=f.relative.turn,prior=await readShadowdancerFile({...f.scope('a'),file});
  await editShadowdancerContext({...f.scope('a'),file,expectedHash:prior.hash,value:{...prior.value,id:'wrong',runId:'foreign',excerpt:'Corrected observation'},reason:'Fix entry'});
  const turns=JSON.parse(await readFile(path.join(f.root('a'),'conversation/context/turns.json')));
  assert.equal(turns.length,1);assert.equal(turns[0].id,'run-a-t0001');assert.equal(turns[0].runId,'run-a');assert.equal(turns[0].excerpt,'Corrected observation');
});

test('explicit import copies only the observed source snapshot, preserves provenance, and retries without duplicates',async t=>{
  const f=await fixture(t),sourceFile='runs/run-b/sources/page-0001/source.json';
  const source=await readShadowdancerFile({...f.scope('b'),file:sourceFile});
  const value={runId:'run-a',sourceRunId:'run-b',sourceFile,expectedSourceHash:source.hash,reason:'Use selected reference'};
  const imported=await f.request('/import','POST',value);
  assert.equal(imported.status,200,JSON.stringify(imported));assert.equal(imported.data.imported,true);
  assert.deepEqual(imported.data.importedFrom,{conversationId:'b',runId:'run-b',file:sourceFile,hash:source.hash});
  const current=await readManagedDirectoryContext(f.scope('a'));
  assert.match(JSON.stringify(current),/EXPLICIT_SELECTED_SOURCE/);
  assert.doesNotMatch(JSON.stringify(current),/UNSELECTED_FOREIGN_SOURCE|Foreign summary/);
  assert.ok(current.sources.some(row=>row.importedFrom?.conversationId==='b'));
  const repeated=await f.request('/import','POST',value);
  assert.equal(repeated.data.alreadyImported,true);assert.equal(repeated.data.file,imported.data.file);
  assert.equal((await contextAuditHistory(f.scope('a'))).total,1);
  assert.equal((await readManagedDirectoryContext(f.scope('b'))).sources.length,1,'source conversation was unchanged');
  const badHash=await f.request('/import','POST',{...value,expectedSourceHash:'a'.repeat(64)});
  assert.equal(badHash.status,409);
});

test('editing and deleting imported context changes only its target copy and subsequent execution payload',async t=>{
  const f=await fixture(t),sourceFile='runs/run-b/sources/page-0001/source.json';
  const source=await readShadowdancerFile({...f.scope('b'),file:sourceFile});
  const imported=await importShadowdancerContext({...f.scope('a'),source:{...f.scope('b'),runId:'run-b',file:sourceFile},expectedSourceHash:source.hash,reason:'Import'});
  const read=await readShadowdancerFile({...f.scope('a'),file:imported.file});
  await editShadowdancerContext({...f.scope('a'),file:imported.file,expectedHash:read.hash,changes:{content:{content:'TARGET_CORRECTION'}},reason:'Adapt reference'});
  const changed=await readShadowdancerFile({...f.scope('a'),file:imported.file});
  assert.equal(changed.value.source.hash,source.hash);
  assert.equal((await readShadowdancerFile({...f.scope('b'),file:sourceFile})).hash,source.hash);
  assert.match(JSON.stringify(await readManagedDirectoryContext(f.scope('a'))),/TARGET_CORRECTION/);
  await deleteShadowdancerContext({...f.scope('a'),file:imported.file,expectedHash:changed.hash,reason:'Remove reference'});
  const managed=await readManagedDirectoryContext(f.scope('a'));
  assert.ok(managed.deletedFiles.some(row=>row.file===imported.file));
  assert.doesNotMatch(JSON.stringify(managed.sources),/TARGET_CORRECTION|EXPLICIT_SELECTED_SOURCE/);
});

test('context tool defaults to current conversation and imports only an explicitly selected source',async t=>{
  const f=await fixture(t),handler=createShadowdancerContextToolHandler({conversations:f.conversations,cwd:f.cwd,runId:'run-a',taskId:'a',getActiveRuns:()=>[...f.engine.runs.values()]});
  const call=async args=>{const result=await handler({name:'relay_context',arguments:args});return {result,data:JSON.parse(result.contentItems[0].text)};};
  const own=await call({action:'list'});assert.equal(own.data.conversationId,'a');
  const sourceFile='runs/run-b/sources/page-0001/source.json',read=await call({action:'read',conversationId:'b',file:sourceFile});
  const imported=await call({action:'import',sourceConversationId:'b',sourceFile,expectedSourceHash:read.data.hash,reason:'Selected reference'});
  assert.equal(imported.result.success,true,JSON.stringify(imported));assert.equal(imported.data.conversationId,'a');
  assert.equal((await call({action:'import',sourceFile,expectedSourceHash:read.data.hash,reason:'Missing source'})).result.success,false);
  const copy=await call({action:'read',file:imported.data.file});
  const removed=await call({action:'delete',file:copy.data.file,expectedHash:copy.data.hash,reason:'Remove reference'});
  assert.equal(removed.result.success,true);
});

test('active target changes and revision-bookkeeping deletion are rejected without modifying context',async t=>{
  const f=await fixture(t),file=f.relative.result,prior=await readShadowdancerFile({...f.scope('a'),file});
  f.engine.runs.get('run-a').status='running';f.engine.runs.get('run-a').settled=false;
  assert.equal((await f.request('/delete','POST',{runId:'run-a',file,expectedHash:prior.hash,reason:'Remove'})).status,409);
  assert.equal((await readShadowdancerFile({...f.scope('a'),file})).hash,prior.hash);
  await assert.rejects(deleteShadowdancerContext({...f.scope('a'),file:'conversation/context/audit.json',expectedHash:prior.hash,reason:'Remove audit'}),{code:'SHADOWDANCER_READ_ONLY'});
});

test('full summary edits and later field changes remain effective after runtime summary refresh',async t=>{
  const f=await fixture(t),file=f.relative.summary,prior=await readShadowdancerFile({...f.scope('a'),file});
  await editShadowdancerContext({...f.scope('a'),file,expectedHash:prior.hash,value:{...prior.value,request:'USER_CORRECTED_REQUEST',userSummary:'USER_SUMMARY'},reason:'Correct the active context'});
  await put(path.join(f.root('a'),file),{currentRun:'new-run',request:'Runtime generated request',userSummary:'Old runtime value',totalTurns:80});
  let managed=await readManagedDirectoryContext(f.scope('a'));
  assert.equal(managed.sources.find(row=>row.file===file).value.request,'USER_CORRECTED_REQUEST');
  const current=await readShadowdancerFile({...f.scope('a'),file});
  await editShadowdancerContext({...f.scope('a'),file,expectedHash:current.hash,changes:{pinnedConstraints:['New user constraint']},reason:'Add constraint'});
  managed=await readManagedDirectoryContext(f.scope('a'));
  const overlay=managed.sources.find(row=>row.file===file).value;
  assert.equal(overlay.request,'USER_CORRECTED_REQUEST');assert.equal(overlay.userSummary,'USER_SUMMARY');
  assert.deepEqual(overlay.pinnedConstraints,['New user constraint']);
});

test('a pending saved context change is reconciled once before execution reads its overlay',async t=>{
  const f=await fixture(t),file=f.relative.result,prior=await readShadowdancerFile({...f.scope('a'),file});
  const changed=await editShadowdancerContext({...f.scope('a'),file,expectedHash:prior.hash,changes:{finding:'Recovered correction'},reason:'Correct'});
  const context=path.join(f.root('a'),'conversation/context');
  const audit=JSON.parse(await readFile(path.join(context,'audit.json'))),row=audit.at(-1);
  const invalidation=JSON.parse(await readFile(path.join(context,'invalidation.json')));
  await put(path.join(context,'audit.json'),audit.slice(0,-1));
  await put(path.join(context,'pending-change.json'),{version:1,row,invalidation});
  const managed=await readManagedDirectoryContext(f.scope('a'));
  assert.equal(managed.latestEditId,changed.editId);
  assert.equal(managed.sources.find(source=>source.file===file).value.finding,'Recovered correction');
  assert.equal((await contextAuditHistory(f.scope('a'))).total,1);
  await assert.rejects(readFile(path.join(context,'pending-change.json')),{code:'ENOENT'});
  assert.equal((await readManagedDirectoryContext(f.scope('a'))).latestEditId,changed.editId);
  assert.equal((await contextAuditHistory(f.scope('a'))).total,1);
});

test('large context, long pinned constraints and complete HTTP edits survive without fixed byte limits',async t=>{
  const f=await fixture(t),file=f.relative.summary,prior=await readShadowdancerFile({...f.scope('a'),file});
  const long='Complete context. '.repeat(75000)+'TAIL_AFTER_ONE_MILLION_CHARACTERS';
  const pinned=Array.from({length:65},(_,i)=>'Constraint '+i+' '+('detail '.repeat(200))+' END_'+i);
  const response=await f.request('/edit','POST',{runId:'run-a',file,expectedHash:prior.hash,expectedManagedEditId:null,
    changes:{userSummary:long,pinnedConstraints:pinned},reason:'Retain complete context'});
  assert.equal(response.status,200,JSON.stringify(response));
  const current=await readShadowdancerFile({...f.scope('a'),file});
  assert.equal(current.value.userSummary,long);assert.deepEqual(current.managedValue.pinnedConstraints,pinned);
  assert.equal(current.managedEditId,response.data.editId);
  const managed=await readManagedDirectoryContext(f.scope('a'));
  assert.equal(managed.sources.find(row=>row.file===file).value.userSummary,long);
  const listing=await listShadowdancerContext(f.scope('a'));
  assert.equal(listing.managedSummary.userSummary,long);
  assert.equal(listing.managedSummaryEditId,response.data.editId);
});

test('context file catalog includes entries past the former count and directory-depth cutoffs',async t=>{
  const f=await fixture(t),folder=path.join(f.root('a'),'runs/run-a/extra');
  await mkdir(folder,{recursive:true});
  await Promise.all(Array.from({length:760},(_,i)=>put(path.join(folder,'record-'+i+'.json'),{index:i})));
  const deep='runs/run-a/'+Array.from({length:18},(_,i)=>'layer-'+i).join('/')+'/complete.json';
  await put(path.join(f.root('a'),deep),{content:'DEEP_CONTEXT'});
  const listing=await listShadowdancerContext(f.scope('a'));
  assert.ok(listing.files.length>760);assert.ok(listing.files.some(row=>row.file===deep));
  assert.equal(listing.files.filter(row=>row.file.startsWith('runs/run-a/extra/')).length,760);
});

test('tool transport pages can read beyond one million characters and honor a requested full-size page',async t=>{
  const f=await fixture(t),file='runs/run-a/large-context.json',long='x'.repeat(1100000)+'VISIBLE_TAIL';
  await put(path.join(f.root('a'),file),{content:long});
  const handler=createShadowdancerContextToolHandler({conversations:f.conversations,cwd:f.cwd,runId:'run-a',taskId:'a'});
  const call=async args=>{const result=await handler({name:'relay_context',arguments:args});assert.equal(result.success,true,JSON.stringify(result));return JSON.parse(result.contentItems[0].text);};
  const tail=await call({action:'read',file,offset:1099900,limit:5});
  assert.match(tail.valueExcerpt,/VISIBLE_TAIL/);assert.equal(tail.offset,1099900);assert.equal(tail.nextOffset,null);
  const complete=await call({action:'read',file,limit:12000});
  assert.equal(complete.truncated,false);assert.equal(complete.value.content,long);
});

test('inspection exposes persistent user overlay while preserving the current canonical hash',async t=>{
  const f=await fixture(t),file=f.relative.summary,prior=await readShadowdancerFile({...f.scope('a'),file});
  const edit=await editShadowdancerContext({...f.scope('a'),file,expectedHash:prior.hash,expectedManagedEditId:null,
    value:{...prior.value,userSummary:'PERSISTENT_USER_CONTEXT',request:'CORRECTED_REQUEST'},reason:'Correct summary'});
  await put(path.join(f.root('a'),file),{currentRun:'later',userSummary:'NEW_GENERATED_SUMMARY',request:'Generated request'});
  const read=await f.request('/file?runId=run-a&file='+file);
  assert.equal(read.status,200);assert.equal(read.data.value.userSummary,'NEW_GENERATED_SUMMARY');
  assert.equal(read.data.managedValue.userSummary,'PERSISTENT_USER_CONTEXT');assert.equal(read.data.managedValue.request,'CORRECTED_REQUEST');
  assert.equal(read.data.managedEditId,edit.editId);assert.equal(read.data.editMode,'replace');
  assert.notEqual(read.data.hash,read.data.managedHash);
  const listing=await f.request('?runId=run-a');
  assert.equal(listing.data.summary.currentRun,'later');assert.equal(listing.data.managedSummary.request,'CORRECTED_REQUEST');
});

test('overlay guards catch stale managed context even when generated bytes return to their old value',async t=>{
  const f=await fixture(t),file=f.relative.summary,original=await readFile(path.join(f.root('a'),file));
  let read=await readShadowdancerFile({...f.scope('a'),file});
  await editShadowdancerContext({...f.scope('a'),file,expectedHash:read.hash,expectedManagedEditId:null,changes:{userSummary:'FIRST_CORRECTION'},reason:'First'});
  await writeFile(path.join(f.root('a'),file),original);
  read=await readShadowdancerFile({...f.scope('a'),file});
  await editShadowdancerContext({...f.scope('a'),file,expectedHash:read.hash,expectedManagedEditId:read.managedEditId,changes:{userSummary:'SECOND_CORRECTION'},reason:'Second'});
  await writeFile(path.join(f.root('a'),file),original);
  const stale=await f.request('/edit','POST',{runId:'run-a',file,expectedHash:read.hash,expectedManagedEditId:read.managedEditId,changes:{userSummary:'LOST_UPDATE'},reason:'Stale'});
  assert.equal(stale.status,409);assert.match(stale.data.error,/user-managed context changed/);
  const current=await readShadowdancerFile({...f.scope('a'),file});
  const reset=await editShadowdancerContext({...f.scope('a'),file,expectedHash:current.hash,expectedManagedEditId:current.managedEditId,
    value:current.value,reason:'Intentionally accept the generated record'});
  assert.equal(reset.updated,true,'canonical equality must not discard a changed user overlay');
  assert.equal((await readShadowdancerFile({...f.scope('a'),file})).managedValue.userSummary,'Current conversation');
});

test('import copies the inspected managed source and binds its exact managed revision',async t=>{
  const f=await fixture(t),sourceFile='conversation/context/summary.json',scope=f.scope('b');
  const prior=await readShadowdancerFile({...scope,file:sourceFile});
  await editShadowdancerContext({...scope,file:sourceFile,expectedHash:prior.hash,changes:{userSummary:'VISIBLE_MANAGED_SOURCE'},reason:'Correct source'});
  await put(path.join(f.root('b'),sourceFile),{currentRun:'run-b',userSummary:'OTHER_GENERATED_VALUE'});
  const source=await readShadowdancerFile({...scope,file:sourceFile});
  const result=await f.request('/import','POST',{runId:'run-a',sourceRunId:'run-b',sourceFile,expectedSourceHash:source.hash,
    expectedSourceManagedEditId:source.managedEditId,reason:'Import what is visible'});
  assert.equal(result.status,200,JSON.stringify(result));
  const copied=await readShadowdancerFile({...f.scope('a'),file:result.data.file});
  assert.equal(copied.value.content.userSummary,'VISIBLE_MANAGED_SOURCE');
  assert.equal(copied.importedFrom.managedEditId,source.managedEditId);
  assert.equal(copied.importedFrom.canonicalHash,source.hash);
  assert.equal(copied.importedFrom.managedHash,source.managedHash);
  assert.equal((await f.request('/import','POST',{runId:'run-a',sourceRunId:'run-b',sourceFile,expectedSourceHash:source.hash,
    expectedSourceManagedEditId:null,reason:'Stale overlay'})).status,409);
});

test('audit history pages expose older entries without a fixed history cutoff',async t=>{
  const f=await fixture(t),audit=Array.from({length:260},(_,i)=>({id:'audit-'+i,at:String(i),status:'historical'}));
  await put(path.join(f.root('a'),'conversation/context/audit.json'),audit);
  const first=await f.request('/audit?runId=run-a&offset=0&limit=80');
  assert.equal(first.status,200);assert.equal(first.data.nextOffset,80);assert.equal(first.data.items[0].id,'audit-259');
  const older=await f.request('/audit?runId=run-a&offset=240&limit=80');
  assert.equal(older.data.items.length,20);assert.equal(older.data.items.at(-1).id,'audit-0');assert.equal(older.data.nextOffset,null);
  const all=await f.request('/audit?runId=run-a&limit=300');assert.equal(all.data.items.length,260);
});

test('page context retains complete item arrays and long source-supported values and quotes',async t=>{
  const f=await fixture(t),sourceFile='runs/run-a/sources/page-0001/source.json',resultFile='runs/run-a/sources/page-0001/result.json';
  const longValue='The full source claim. '.repeat(20),longQuote='The full attributed quote. '.repeat(30);
  await put(path.join(f.root('a'),sourceFile),{content:longValue+longQuote});
  await put(path.join(f.root('a'),resultFile),{summary:'Original',items:[]});
  const prior=await readShadowdancerFile({...f.scope('a'),file:resultFile});
  const items=Array.from({length:140},()=>({value:longValue,quote:longQuote}));
  await editShadowdancerContext({...f.scope('a'),file:resultFile,expectedHash:prior.hash,changes:{items},reason:'Keep every source item'});
  const managed=await readManagedDirectoryContext(f.scope('a'));
  assert.deepEqual(managed.sources.find(row=>row.file===resultFile).value.items,items);
});
