import test from 'node:test';
import assert from 'node:assert/strict';
import {projectReviewOperationEvidence} from '../lib/review-operation-evidence.mjs';
import {modularOutcomeReferenceIndex} from '../lib/modular-completion.mjs';
import {ordinaryOutcomePrompt} from '../lib/chat-outcome-review.mjs';
const ref='11111111-2222-3333-4444-555555555555',foreign='11111111-2222-3333-4444-555555555556';
const payload='status=READY; café\n',offset=100,bytes=500;
const page=(reference=ref,at=offset,text=payload)=>({reference,tool:'relay_workspace',bytes,offset:at,nextOffset:at+Buffer.byteLength(text),complete:false,text});
const receipt=(id,tool,action,args,result,extra={})=>({id,callId:id,source:'admitted-tool-delivery',tool,namespace:'',action,arguments:{action,...args},success:true,result:{contentItems:[{type:'inputText',text:JSON.stringify(result)}]},...extra});
const source=(reference=ref,id='src')=>receipt(id,'relay_workspace','read',{path:'log.txt',startLine:1,lineCount:300},{externalContext:true,reference,bytes,tool:'relay_workspace',contentIndex:0,searchCallTemplate:{tool:'relay_context_page',arguments:{action:'search',reference,needle:'<target text>'}},preview:{truncated:true,startLine:1,endLine:224,nextStartLine:225}});
const search=(id='search',args={},data={},extra={})=>receipt(id,'relay_context_page','search',{reference:ref,needle:'status=',...args},{reference:ref,bytes,needle:'status=',startOffset:0,scannedBytes:bytes,complete:true,nextScanOffset:null,matches:[{offset}],firstMatchEvidence:page(),matchedReadCallTemplate:{tool:'relay_context_page',arguments:{action:'read',reference:ref,offset,maxBytes:512}},...data},extra);
const read=(id='read',args={},p=page(),extra={})=>receipt(id,'relay_context_page','read',{reference:ref,offset,maxBytes:512,...args},p,extra);
const snapshot=records=>({request:'Inspect the source and return the status.',scope:{kind:'ordinary-chat'},evidence:{records,total:records.length,omitted:0}});
const project=records=>{const s=snapshot(records);return projectReviewOperationEvidence(s,modularOutcomeReferenceIndex(s))};
const chain=records=>project(records).archives[0];
test('exact search text and a distinct subsequent read have independent provenance',()=>{
 const records=[source(),search()],before=structuredClone(records),r=chain(records);
 assert.equal(r.sourceReceipts[0].receipt,'evidence-0001');
 assert.deepEqual(r.sourceReceipts[0].returnedSourceLines,[1,224]);
 assert.equal(r.sourceReceipts[0].nextSourceLine,225);
 assert.equal(r.searches[0].receipt,'evidence-0002');
 assert.equal(r.searches[0].firstMatch.text,payload);
 assert.deepEqual(r.searches[0].separateReadAfterSearchAtFirstMatch,{state:'not-observed-in-admitted-view',receipts:[]});
 assert.equal(r.searches[0].availableReadCall.arguments.offset,offset);
 assert.deepEqual(records,before);
 const after=chain([...records,read()]);
 assert.deepEqual(after.searches[0].separateReadAfterSearchAtFirstMatch,{state:'observed',receipts:['evidence-0003']});
 assert.equal(after.searches[0].availableReadCall,undefined);
 assert.deepEqual(after.separateReadReceipts,[{receipt:'evidence-0003',offset,nextOffset:offset+Buffer.byteLength(payload)}]);
});
test('failed, foreign, unadmitted, earlier and different-offset reads cannot satisfy the subsequent matching-read relation',()=>{
 const cases=[
   [source(),search(),read('failed',{},page(),{success:false})],
   [source(),search(),read('foreign',{reference:foreign},page(foreign))],
   [source(),search(),read('unadmitted',{},page(),{source:'worker-claim'})],
   [source(),search(),read('namespaced',{},page(),{namespace:'external'})],
   [source(),read(),search()],
   [source(),search(),read('wrong-offset',{offset:101},page(ref,101))],
   [source(),search(),read('wrong-content',{},page(ref,offset,'status=DIFFERENT;'))],
   [source(),search(),read('duplicate'),read('duplicate')],
   [source(),search(),read('bad-delivery',{},page(),{callId:'other'})],
 ];
 for(const records of cases)assert.equal(chain(records).searches[0].separateReadAfterSearchAtFirstMatch.state,'not-observed-in-admitted-view');
});
test('malformed and foreign search evidence cannot establish a match or usable read template',()=>{
 for(const r of [
   search('bad-ref',{reference:foreign}),
   search('bad-needle',{needle:'unrelated'}),
   search('bad-offset',{}, {firstMatchEvidence:page(ref,offset+1)}),
   search('bad-content',{}, {firstMatchEvidence:page(ref,offset,'other text')}),
   search('bad-length',{}, {firstMatchEvidence:{...page(),nextOffset:offset+1}}),
   search('failed',{}, {},{success:false}),
   search('forged',{}, {},{source:'candidate'}),
 ]) assert.equal(chain([source(),r]).searches.length,0);
 const invalidTemplate=search('bad-template',{}, {matchedReadCallTemplate:{tool:'relay_workspace',arguments:{action:'write',path:'x'}}});
 assert.equal(chain([source(),invalidTemplate]).searches[0].availableReadCall,undefined);
 assert.equal(project([search()]),undefined);
 const ambiguous=source(ref,'conflict');
 const obj=JSON.parse(ambiguous.result.contentItems[0].text);obj.bytes++;
 ambiguous.result.contentItems[0].text=JSON.stringify(obj);
 assert.equal(project([source(),search(),ambiguous]),undefined);
});
test('implicit reference resolves only for an already exposed unique archive',()=>{
 const s=search();delete s.arguments.reference;
 assert.equal(chain([source(),s]).searches.length,1);
 assert.equal(chain([source(),source(foreign,'other'),s]).searches.length,0);
 assert.equal(project([s,source()]).archives[0].searches.length,0);
});
test('no match, incomplete scan and source truncation are represented without asserting absence from the entire source',()=>{
 const s=search('miss',{}, {matches:[],firstMatchEvidence:undefined,matchedReadCallTemplate:undefined,complete:false,scannedBytes:250,nextScanOffset:250});
 const r=chain([source(),s]);assert.equal(r.searches[0].result,'no-match-returned');assert.equal(r.searches[0].scanComplete,false);assert.equal(r.sourceReceipts[0].originalSourceTruncated,true);
 assert.equal(r.searches[0].firstMatch,undefined);
});
test('projection stays separate from lossless original JSON and never invents requested procedure',()=>{
 const records=[source(),search()],s=snapshot(records),original=structuredClone(s);
 const prompt=ordinaryOutcomePrompt(s,{output:'READY'},undefined,{strictRequiredOutput:true});
 const data=JSON.parse(prompt.split('\nREVIEW DATA (JSON):\n').at(-1));
 assert.equal(data.operationEvidence.source,'host-linked-admitted-operation-receipts');
 assert.match(data.operationEvidence.meaning,/only when the actual request requires it/);
 assert.equal(data.snapshot.request,s.request);
 for(let i=0;i<records.length;i++){
  const item=data.snapshot.evidence.records[i].result.contentItems[0];
  assert.equal(JSON.stringify(item.decodedJSON),records[i].result.contentItems[0].text);
 }
 assert.deepEqual(s,original);
 const absent=ordinaryOutcomePrompt(snapshot([]),{output:'hello'},undefined,{strictRequiredOutput:true});
 assert.equal(Object.hasOwn(JSON.parse(absent.split('\nREVIEW DATA (JSON):\n').at(-1)),'operationEvidence'),false);
});
