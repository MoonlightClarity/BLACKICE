'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {normalizeContextPublication,MAX_PREFIX_BYTES}=require('./context-publication-observation.cjs');
const {attachPublication}=require('./fixtures/context-publication.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(){
 const now='2026-11-21T12:00:10.000Z',started='2026-11-21T12:00:00.000Z';
 return attachPublication({now,maxEvidenceAgeMs:2000,processIdentity:{pid:42,startedAt:started},
  propsResponse:{at:now,status:200,json:{is_sleeping:false,blackice_runtime:{startupId:'ctx',pid:42,processStartedAt:started}}},
  startupReceipt:{schema:'blackice.minicpm.runtime-startup.v1',id:'ctx',at:'2026-11-21T12:00:01.000Z',observedAt:now,pid:42,processStartedAt:started,complete:true,droppedEvents:0,modelSha256:'a'.repeat(64),binarySha256:'b'.repeat(64),runtime:{},fieldSources:{}}});
}
function rewrite(f,change){
 const rows=f.bytes.contextPrefixBytes.toString().trimEnd().split('\n').map(JSON.parse);change(rows);
 const b=Buffer.from(rows.map(e=>JSON.stringify(e)).join('\n')+'\n');f.bytes.contextPrefixBytes=b;
 const p=f.input.currentPublication;p.contextPrefix.bytes=b.length;p.contextPrefix.sha256=sha(b);p.contextSource.highWaterMark=b.length;
 p.contextSource.before.bytes=b.length;p.contextSource.after.bytes=b.length;p.contextSource.rereadSha256=sha(b);
}
function rejected(change,code){
 const f=fixture();change(f);const q=normalizeContextPublication(f.input,f.bytes);assert.equal(q.complete,false,JSON.stringify(q));
 if(code)assert.ok([...q.missing,...q.conflicts].some(x=>x.code===code),JSON.stringify(q));return q;
}
test('awake current publication requires exact independent bytes and ordered source lifecycle',()=>{
 const f=fixture(),before=structuredClone(f),q=normalizeContextPublication(f.input,f.bytes);
 assert.equal(q.complete,true,JSON.stringify(q));assert.equal(q.recordCount,2);assert.equal(q.context.contextEndCount,0);
 assert.deepEqual(structuredClone(f),before);assert.deepEqual(normalizeContextPublication(f.input,f.bytes),q);
 assert.equal(JSON.stringify(q).includes('"contextPrefixBytes"'),false);
});
test('a source-ended context fails despite unchanged apparently awake props and valid hashes',()=>{
 rejected(f=>rewrite(f,rows=>rows.push({...rows[1],event:'context_end',fileSequence:3,processSequence:6,data:{startupId:'ctx',complete:true}})),'current-context-already-ended');
});
test('sleeping, unavailable, changed or missing current publication cannot promote a previous receipt',()=>{
 for(const which of ['before','after'])for(const kind of ['sleeping','missing','unavailable']){
  rejected(f=>{const p=which==='before'?f.input.propsResponse:f.input.currentPublication.propsAfterResponse;
   if(kind==='sleeping'){p.json.blackice_previous_runtime=p.json.blackice_runtime;p.json.blackice_runtime=null;p.json.blackice_runtime_state='sleeping';p.json.is_sleeping=true;}
   if(kind==='missing')delete p.json.blackice_runtime_state;if(kind==='unavailable')p.status=503;
  },'explicit-awake-context-required');
 }
 rejected(f=>f.input.currentPublication.propsAfterResponse.json.blackice_runtime.startupId='new','current-publication-changed');
});
test('missing raw bytes cannot be replaced by a caller-authored complete or current assertion',()=>{
 const f=fixture();f.input.currentPublication.complete=true;f.input.currentPublication.current=true;
 const q=normalizeContextPublication(f.input);assert.equal(q.complete,false);assert.ok(q.missing.some(x=>x.code==='independently-read-artifact-bytes-required'));
 rejected(f=>delete f.input.currentPublication,'independent-current-publication-required');
});
test('changed raw artifacts, publication digest and structural native receipt are rejected',()=>{
 rejected(f=>{f.bytes.contextPrefixBytes=Buffer.from(f.bytes.contextPrefixBytes);f.bytes.contextPrefixBytes[20]^=1;},'artifact-bytes-or-sha256-conflict');
 rejected(f=>rewrite(f,rows=>rows[1].data.receipt.sha256='c'.repeat(64)),'startup-publication-artifact-conflict');
 rejected(f=>rewrite(f,rows=>rows[1].data.runtime.id='foreign'),'startup-publication-props-conflict');
 rejected(f=>f.input.startupReceipt.runtime.ctxSize=100,'enriched-native-receipt-conflict');
});
test('missing or repeated publication, gaps and foreign process/context headers fail',()=>{
 rejected(f=>rewrite(f,rows=>rows.pop()),'ordered-context-start-and-publication-required');
 rejected(f=>rewrite(f,rows=>rows.push({...rows[1],fileSequence:3,processSequence:5})),'duplicate-runtime-publication');
 for(const field of ['fileSequence','processSequence','pid','processStartedAt','processId']){
  rejected(f=>rewrite(f,rows=>{rows[1][field]=typeof rows[1][field]==='number'?0:'foreign';}));
 }
 rejected(f=>rewrite(f,rows=>rows[1].data.startupId='other'),'context-event-identity-or-sequence-conflict');
});
test('fixed-prefix identity, size and independent source reread must agree',()=>{
 rejected(f=>f.input.currentPublication.contextSource.after.identity.ino='18','context-file-identity-changed');
 rejected(f=>f.input.currentPublication.contextSource.after.bytes++,'context-file-size-changed');
 rejected(f=>f.input.currentPublication.contextSource.highWaterMark--,'exact-source-and-high-water-required');
 rejected(f=>f.input.currentPublication.contextSource.rereadSha256='d'.repeat(64),'independent-source-reread-required');
 rejected(f=>f.input.currentPublication.contextPrefix.path=f.input.currentPublication.contextSource.path,'independent-prefix-copy-required');
});
test('partial final lines, malformed UTF-8 and overflow fail explicitly',()=>{
 rejected(f=>{const b=f.bytes.contextPrefixBytes.subarray(0,-1);f.bytes.contextPrefixBytes=b;const p=f.input.currentPublication;p.contextPrefix.bytes=b.length;p.contextPrefix.sha256=sha(b);p.contextSource.highWaterMark=b.length;p.contextSource.before.bytes=b.length;p.contextSource.after.bytes=b.length;p.contextSource.rereadSha256=sha(b);},'complete-lf-prefix-required');
 rejected(f=>{const b=Buffer.from([255,10]);f.bytes.contextPrefixBytes=b;const p=f.input.currentPublication;p.contextPrefix.bytes=b.length;p.contextPrefix.sha256=sha(b);p.contextSource.highWaterMark=b.length;p.contextSource.before.bytes=b.length;p.contextSource.after.bytes=b.length;p.contextSource.rereadSha256=sha(b);},'invalid-context-json-or-utf8');
 rejected(f=>f.input.currentPublication.contextPrefix.bytes=MAX_PREFIX_BYTES+1,'bounded-exact-artifact-reference-required');
});
test('stale, reversed and unbounded observation clocks are not accepted',()=>{
 rejected(f=>f.input.currentPublication.contextSource.startedAt='2026-11-21T11:59:00.000Z','fresh-context-observation-required');
 rejected(f=>f.input.currentPublication.propsAfterResponse.startedAt='2026-11-21T12:00:09.999Z','props-prefix-props-order-required');
 rejected(f=>f.input.maxEvidenceAgeMs=120001,'bounded-current-context-clock-required');
});
test('malformed inputs return explicit incomplete observations',()=>{
 for(const value of [null,{},[],{now:'wrong'}])assert.equal(normalizeContextPublication(value).complete,false);
});
