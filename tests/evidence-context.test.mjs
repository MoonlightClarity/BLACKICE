import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createEvidenceStore,splitTextByCapacity} from '../lib/evidence-context.mjs';
import {estimateContextTokens} from '../lib/context.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'saved-evidence-context-'));t.after(()=>rm(root,{recursive:true,force:true}));return createEvidenceStore({root});}

test('capacity pages preserve all characters and account for serialized escaping without a fixed chunk cap',async()=>{
  const source=('A😀"\\\nB'.repeat(230))+'FINAL_SOURCE_VALUE';
  const fits=value=>Buffer.byteLength(JSON.stringify({source:value}),'utf8')<=91;
  const pages=await splitTextByCapacity(source,{fits});
  assert.ok(pages.length>1);assert.equal(pages.map(row=>row.text).join(''),source);
  let end=0;
  for(const page of pages){assert.equal(page.start,end);assert.equal(page.text,source.slice(page.start,page.end));assert.ok(fits(page.text));assert.doesNotMatch(page.text,/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);end=page.end;}
  assert.equal(end,source.length);
  assert.deepEqual(await splitTextByCapacity('😀',{fits:value=>value.length<=2}),[{start:0,end:2,text:'😀'}]);
  await assert.rejects(splitTextByCapacity('😀',{fits:value=>value.length<=1}),{code:'EVIDENCE_CONTEXT_CAPACITY'});
});

test('media projection preserves original bytes and separate repeated-operation identities',async t=>{
  const store=await fixture(t),imageUrl='data:image/png;base64,'+Buffer.from('opaque image fixture '.repeat(30000)).toString('base64');
  const result={success:true,contentItems:[{type:'inputText',text:'Observed receipt ACCEPT-9; image contents require inspection.'},{type:'inputImage',imageUrl}]};
  const original={records:[{id:'call-a',source:'host-dispatch-receipt',tool:'relay_browser',action:'screenshot',success:true,result},{id:'call-b',source:'host-dispatch-receipt',tool:'relay_browser',action:'screenshot',success:true,result:structuredClone(result)}]};
  const encoded=JSON.stringify(original),source=await store.save(original,{kind:'original-review'});
  const projected=await store.project(original,{sourceFile:source.file});
  assert.equal(JSON.stringify(original),encoded);assert.equal(await readFile(source.file,'utf8'),encoded);assert.equal(source.sha256,hash(encoded));
  assert.deepEqual(projected.value.records.map(row=>row.id),['call-a','call-b']);
  assert.ok(projected.value.records.every(row=>row.action==='screenshot'&&row.success));
  assert.equal(projected.mediaRefs.length,1);assert.equal(projected.duplicateRefs.length,1);
  assert.ok(JSON.stringify(projected.value).length<10000);assert.equal(JSON.stringify(projected.value).includes(imageUrl),false);
  const media=await store.handle({action:'read',ref:projected.mediaRefs[0].ref},{tokenBudget:3000});
  assert.equal(media.success,true);assert.equal(media.contentItems[1].type,'inputImage');assert.equal(media.contentItems[1].imageUrl,imageUrl);
  assert.equal(JSON.parse(media.contentItems[0].text).verified,false,'Saving media is not a claim that its pixels were verified');
  const repeated=await store.handle({action:'read',ref:projected.duplicateRefs[0].ref},{tokenBudget:Infinity});
  assert.deepEqual(JSON.parse(JSON.parse(repeated.contentItems[0].text).text),result);
});

test('scoped evidence reads return complete exact pages within capacity and reject unknown or changed artifacts',async t=>{
  const store=await fixture(t),source=('retained 😀 "value" \\\n'.repeat(240))+'SOURCE_TAIL',saved=await store.save(source,{kind:'source'});
  const parts=[];let offset=0;
  do{
    const response=await store.handle({action:'read',ref:saved.ref,offset},{tokenBudget:700});
    assert.equal(response.success,true);assert.ok(estimateContextTokens(response)<=700);
    const page=JSON.parse(response.contentItems[0].text);assert.equal(page.offset,offset);assert.equal(page.text,source.slice(page.offset,page.end));parts.push(page.text);offset=page.nextOffset;
  }while(offset!==null);
  assert.equal(parts.join(''),source);assert.ok(parts.length>1);
  for(const args of [{action:'read',ref:'../unobserved.json'},{action:'read',ref:saved.ref,path:'/unobserved.json'}])assert.equal((await store.handle(args)).success,false);
  await writeFile(saved.file,'"changed"');
  const changed=await store.handle({action:'read',ref:saved.ref},{tokenBudget:1000});assert.equal(changed.success,false);assert.equal(changed.code,'EVIDENCE_SOURCE_CHANGED');
});
