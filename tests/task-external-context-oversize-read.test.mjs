import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {TaskExternalContextStore} from '../lib/task-external-context.mjs';

const textResult=text=>({success:true,contentItems:[{type:'inputText',text}]});
const decoded=response=>JSON.parse(response.contentItems[0].text);

test('oversized model-generated read uses a bounded actual archive page instead of a repeated invalid-maxBytes failure',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-archive-page-cap-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const store=new TaskExternalContextStore({dataDir,taskId:'read-recovery',thresholdBytes:500});
 const original='ROOT_DIAGNOSTIC\n'+'line with evidence — 漢字\n'.repeat(1500)+'END_OF_ORIGINAL';
 const saved=await store.archiveResult({name:'relay_workspace',arguments:{action:'read',path:'fixtures/diagnostic.log'}},textResult(original));
 const reference=decoded(saved).reference;
 assert.equal(typeof reference,'string');
 let offset=0,recovered='',pages=0;
 do{
  const response=await store.handle({arguments:{action:'read',reference,offset,maxBytes:65536}});
  assert.equal(response.success,true,'An oversized safe read request should be bounded, not rejected: '+JSON.stringify(response));
  const page=decoded(response);
  assert.equal(page.limitAdjusted,true);
  assert.equal(page.requestedMaxBytes,65536);
  assert.equal(page.effectiveMaxBytes,8192);
  assert.equal(page.offset,offset);
  assert.ok(page.nextOffset>offset,'A successful page must make progress.');
  assert.ok(Buffer.byteLength(page.text,'utf8')<=8192,'The returned content must be bounded by actual bytes.');
  recovered+=page.text;
  offset=page.nextOffset;
  if(++pages>12)assert.fail('A 45KB archive should not need more than 12 bounded pages.');
  if(page.complete)break;
 }while(true);
 assert.equal(recovered,original,'All original UTF-8 bytes must be recovered after paging.');
 assert.ok(pages>1,'The tool must not falsely claim an oversized single page covers the archive.');
});

test('only a positive oversized integer is bounded; invalid values and foreign archives stay rejected',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-archive-invalid-page-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const store=new TaskExternalContextStore({dataDir,taskId:'read-recovery',thresholdBytes:500});
 const archived=await store.archiveResult({name:'relay_workspace',arguments:{action:'read',path:'test'}},textResult('x'.repeat(2100)));
 const reference=decoded(archived).reference;
 for(const maxBytes of [0,-1,511,1.25,'65536',null]){
  const response=await store.handle({arguments:{action:'read',reference,maxBytes}});
  assert.equal(response.success,false,'Do not silently fix an invalid non-oversized value: '+String(maxBytes));
  assert.equal(response.code,'CONTEXT_ARCHIVE_INVALID');
 }
 const foreign=new TaskExternalContextStore({dataDir,taskId:'another-task'});
 const denied=await foreign.handle({arguments:{action:'read',reference,maxBytes:65536}});
 assert.equal(denied.success,false);
 assert.equal(denied.code,'CONTEXT_ARCHIVE_NOT_FOUND');
});
