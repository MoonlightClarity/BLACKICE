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
  const root=conversationId=>path.join(cwd,'.blackice','directory',conversationId);
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

test('editing an individual turn updates the shared index without changing its saved identity',async t=>{
  const f=await fixture(t),file=f.relative.turn,prior=await readShadowdancerFile({...f.scope('a'),file});
  await editShadowdancerContext({...f.scope('a'),file,expectedHash:prior.hash,value:{...prior.value,id:'wrong',runId:'foreign',excerpt:'Corrected observation'},reason:'Fix entry'});
  const turns=JSON.parse(await readFile(path.join(f.root('a'),'conversation/context/turns.json')));
  assert.equal(turns.length,1);assert.equal(turns[0].id,'run-a-t0001');assert.equal(turns[0].runId,'run-a');assert.equal(turns[0].excerpt,'Corrected observation');
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

test('retired context HTTP operations leave saved records and mutation receipts untouched',async t=>{
 const f=await fixture(t),before=await readFile(path.join(f.root('a'),f.relative.summary));
 for(const suffix of ['?runId=run-a','/file?runId=run-a&file='+f.relative.summary,'/conversations?runId=run-a','/audit?runId=run-a','/edit','/delete','/import','/rebuild']){
  for(const method of ['GET','POST']){
   const response=await f.request(suffix,method,{runId:'run-a',file:f.relative.summary,reason:'Retired operation'});
   assert.equal(response.status,410);assert.equal(response.data.code,'DIRECTORY_RETIRED');
  }
 }
 assert.deepEqual(await readFile(path.join(f.root('a'),f.relative.summary)),before);assert.deepEqual(f.events,[]);
});
test('managed execution context rejects even empty or populated storage without consuming it',async t=>{
 const f=await fixture(t);
 for(const id of ['new','a','b'])await assert.rejects(readManagedDirectoryContext(f.scope(id)),{code:'DIRECTORY_RETIRED'});
});
test('standalone saved-record import edits only its target, binds revision, and remains idempotent',async t=>{
 const f=await fixture(t),sourceFile='runs/run-b/sources/page-0001/source.json';
 const source=await readShadowdancerFile({...f.scope('b'),file:sourceFile});
 const args={...f.scope('a'),source:{...f.scope('b'),runId:'run-b',file:sourceFile},expectedSourceHash:source.hash,reason:'Selected recovery copy'};
 const imported=await importShadowdancerContext(args),again=await importShadowdancerContext(args);
 assert.equal(again.file,imported.file);
 const read=await readShadowdancerFile({...f.scope('a'),file:imported.file});
 await editShadowdancerContext({...f.scope('a'),file:imported.file,expectedHash:read.hash,changes:{content:{content:'TARGET_CORRECTION'}},reason:'Adapt recovery copy'});
 const changed=await readShadowdancerFile({...f.scope('a'),file:imported.file});
 assert.match(JSON.stringify(changed.value),/TARGET_CORRECTION/);
 assert.equal((await readShadowdancerFile({...f.scope('b'),file:sourceFile})).hash,source.hash);
 await deleteShadowdancerContext({...f.scope('a'),file:imported.file,expectedHash:changed.hash,reason:'Remove recovery copy'});
 await assert.rejects(readShadowdancerFile({...f.scope('a'),file:imported.file}));
 await assert.rejects(readManagedDirectoryContext(f.scope('a')),{code:'DIRECTORY_RETIRED'});
});
test('standalone overlays preserve owner corrections while canonical bytes change and reject stale revisions',async t=>{
 const f=await fixture(t),file=f.relative.summary,prior=await readShadowdancerFile({...f.scope('a'),file});
 const edit=await editShadowdancerContext({...f.scope('a'),file,expectedHash:prior.hash,expectedManagedEditId:null,value:{...prior.value,userSummary:'OWNER_CORRECTION'},reason:'Recovery correction'});
 await put(path.join(f.root('a'),file),{currentRun:'later',userSummary:'GENERATED'});
 const read=await readShadowdancerFile({...f.scope('a'),file});
 assert.equal(read.value.userSummary,'GENERATED');assert.equal(read.managedValue.userSummary,'OWNER_CORRECTION');assert.equal(read.managedEditId,edit.editId);
 await assert.rejects(editShadowdancerContext({...f.scope('a'),file,expectedHash:read.hash,expectedManagedEditId:null,changes:{userSummary:'LOST_UPDATE'},reason:'Stale recovery edit'}),{code:'SHADOWDANCER_REVISION_CONFLICT'});
});
test('standalone audit pagination preserves history past the first page',async t=>{
 const f=await fixture(t),audit=Array.from({length:260},(_,i)=>({id:'audit-'+i,at:String(i),status:'historical'}));
 await put(path.join(f.root('a'),'conversation/context/audit.json'),audit);
 const first=await contextAuditHistory({...f.scope('a'),offset:0,limit:80}),older=await contextAuditHistory({...f.scope('a'),offset:240,limit:80});
 assert.equal(first.nextOffset,80);assert.equal(first.items[0].id,'audit-259');assert.equal(older.items.length,20);assert.equal(older.items.at(-1).id,'audit-0');
});

test('standalone audit bookkeeping cannot be deleted',async t=>{
 const f=await fixture(t),file='conversation/context/audit.json';
 await put(path.join(f.root('a'),file),[{id:'retained-audit'}]);
 const before=await readFile(path.join(f.root('a'),file));
 await assert.rejects(deleteShadowdancerContext({...f.scope('a'),file,expectedHash:'a'.repeat(64),reason:'Attempt protected deletion'}),{code:'SHADOWDANCER_READ_ONLY'});
 assert.deepEqual(await readFile(path.join(f.root('a'),file)),before);
});
test('standalone overlay ABA guard rejects stale revision and canonical equality still resets changed overlay',async t=>{
 const f=await fixture(t),file=f.relative.summary,original=await readFile(path.join(f.root('a'),file));
 let read=await readShadowdancerFile({...f.scope('a'),file});
 await editShadowdancerContext({...f.scope('a'),file,expectedHash:read.hash,expectedManagedEditId:null,changes:{userSummary:'FIRST_CORRECTION'},reason:'First'});
 await writeFile(path.join(f.root('a'),file),original);
 read=await readShadowdancerFile({...f.scope('a'),file});
 await editShadowdancerContext({...f.scope('a'),file,expectedHash:read.hash,expectedManagedEditId:read.managedEditId,changes:{userSummary:'SECOND_CORRECTION'},reason:'Second'});
 await writeFile(path.join(f.root('a'),file),original);
 await assert.rejects(editShadowdancerContext({...f.scope('a'),file,expectedHash:read.hash,expectedManagedEditId:read.managedEditId,changes:{userSummary:'LOST_UPDATE'},reason:'Stale'}),{code:'SHADOWDANCER_REVISION_CONFLICT'});
 const current=await readShadowdancerFile({...f.scope('a'),file});
 assert.equal(current.managedValue.userSummary,'SECOND_CORRECTION');
 const reset=await editShadowdancerContext({...f.scope('a'),file,expectedHash:current.hash,expectedManagedEditId:current.managedEditId,value:current.value,reason:'Intentionally accept generated record'});
 assert.equal(reset.updated,true,'canonical equality must not discard changed overlay');
 assert.equal((await readShadowdancerFile({...f.scope('a'),file})).managedValue.userSummary,'Current conversation');
});
test('standalone import binds exact inspected managed-source revision and hashes',async t=>{
 const f=await fixture(t),sourceFile='conversation/context/summary.json',scope=f.scope('b');
 const prior=await readShadowdancerFile({...scope,file:sourceFile});
 await editShadowdancerContext({...scope,file:sourceFile,expectedHash:prior.hash,changes:{userSummary:'VISIBLE_MANAGED_SOURCE'},reason:'Correct source'});
 await put(path.join(f.root('b'),sourceFile),{currentRun:'run-b',userSummary:'OTHER_GENERATED_VALUE'});
 const source=await readShadowdancerFile({...scope,file:sourceFile});
 const args={...f.scope('a'),source:{...scope,runId:'run-b',file:sourceFile},expectedSourceHash:source.hash,expectedSourceManagedEditId:source.managedEditId,reason:'Import visible saved revision'};
 const result=await importShadowdancerContext(args);
 const copied=await readShadowdancerFile({...f.scope('a'),file:result.file});
 assert.equal(copied.value.content.userSummary,'VISIBLE_MANAGED_SOURCE');
 assert.equal(copied.importedFrom.managedEditId,source.managedEditId);
 assert.equal(copied.importedFrom.canonicalHash,source.hash);
 assert.equal(copied.importedFrom.managedHash,source.managedHash);
 await assert.rejects(importShadowdancerContext({...args,expectedSourceManagedEditId:null}),{code:'SHADOWDANCER_REVISION_CONFLICT'});
});
test('standalone saved page edits preserve all 140 long source-supported items',async t=>{
 const f=await fixture(t),sourceFile='runs/run-a/sources/page-0001/source.json',resultFile='runs/run-a/sources/page-0001/result.json';
 const longValue='The full source claim. '.repeat(20),longQuote='The full attributed quote. '.repeat(30);
 await put(path.join(f.root('a'),sourceFile),{content:longValue+longQuote});
 await put(path.join(f.root('a'),resultFile),{summary:'Original',items:[]});
 const prior=await readShadowdancerFile({...f.scope('a'),file:resultFile});
 const items=Array.from({length:140},()=>({value:longValue,quote:longQuote}));
 await editShadowdancerContext({...f.scope('a'),file:resultFile,expectedHash:prior.hash,changes:{items},reason:'Keep every source item'});
 const read=await readShadowdancerFile({...f.scope('a'),file:resultFile});
 assert.deepEqual(read.value.items,items);assert.deepEqual(read.managedValue.items,items);
});
