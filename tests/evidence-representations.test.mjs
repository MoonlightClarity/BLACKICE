import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createEvidenceStore,evidenceResponseTokens} from '../lib/evidence-context.mjs';
import {estimateContextTokens} from '../lib/context.mjs';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
import {reviewModularOutcome,createModularCompletionController} from '../lib/modular-completion.mjs';
import {DEFAULT_PLANNING_ONTOLOGY} from '../public/planning-module-policy.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const page=receipt=>JSON.parse(receipt.contentItems.find(item=>item.type==='inputText').text);
async function workspace(t){const cwd=await mkdtemp(path.join(os.tmpdir(),'evidence-representation-'));t.after(()=>rm(cwd,{recursive:true,force:true}));return cwd;}

test('raw media aggregates redirect without content, while projected JSON and original images have distinct exact provenance',async t=>{
  const cwd=await workspace(t),store=createEvidenceStore({root:path.join(cwd,'store')}),imageUrl='data:image/png;base64,'+'ABCD'.repeat(1000);
  const result={success:true,contentItems:[{type:'inputText',text:'Exact text 😀 retained.'},{type:'inputImage',imageUrl}]};
  const value={records:[{source:'host-dispatch-receipt',callId:'call-one',result},{source:'host-dispatch-receipt',callId:'call-two',result:structuredClone(result)}]};
  const source=await store.save(value,{kind:'original-review'}),originalBytes=await readFile(source.file,'utf8');
  const redirected=await store.handle({action:'read',ref:source.ref,offset:11},{tokenBudget:20000}),redirect=page(redirected);
  assert.equal(redirected.success,true);assert.equal(redirect.contentReturned,false);assert.equal(redirect.representation,'descriptor');
  assert.equal(redirect.offset,undefined);assert.equal(redirect.text,undefined);assert.equal(redirect.original.ref,source.ref);assert.equal(redirect.original.sha256,sha(originalBytes));
  assert.equal(redirect.projected.representation,'projected-json');assert.notEqual(redirect.projected.ref,source.ref);assert.notEqual(redirect.projected.sha256,source.sha256);
  assert.equal(redirected.contentItems.some(item=>item.type==='inputImage'),false);assert.equal(JSON.stringify(redirected).includes(imageUrl),false);
  const projectedRead=await store.handle({action:'read',ref:redirect.projected.ref},{tokenBudget:20000}),projectedPage=page(projectedRead),projected=JSON.parse(projectedPage.text);
  assert.equal(projectedPage.representation,'projected-json');assert.equal(projectedPage.contentReturned,true);assert.equal(projectedPage.sha256,sha(await readFile(redirect.projected.file,'utf8')));
  assert.deepEqual(projected.records.map(row=>row.callId),['call-one','call-two']);assert.equal(projected.records[0].result.contentItems[1].type,'savedImage');
  assert.equal(projected.records[1].result.representation,'projected-json');assert.equal(projected.records[1].result.original.representation,'raw-json');
  const image=await store.handle({action:'read',ref:redirect.mediaRefs[0].ref},{tokenBudget:4000});
  assert.equal(image.contentItems[1].type,'inputImage');assert.equal(image.contentItems[1].imageUrl,imageUrl);assert.equal(page(image).representation,'media');
  assert.equal(await readFile(source.file,'utf8'),originalBytes,'Projection never rewrites the original archive');
});

test('explicit raw encoded JSON preserves UTF-16 ranges and charges each serialized byte against capacity',async t=>{
  const cwd=await workspace(t),store=createEvidenceStore({root:path.join(cwd,'store')});
  const value={note:'before 😀 after \\ "quote"',image:{type:'inputImage',imageUrl:'data:image/png;base64,'+'A1b2C3d4'.repeat(400)}};
  const saved=await store.save(value,{kind:'original-snapshot'}),encoded=await readFile(saved.file,'utf8'),parts=[];let offset=0;
  do{
    const receipt=await store.handle({action:'read',ref:saved.ref,representation:'raw',offset},{tokenBudget:1300});
    assert.equal(receipt.success,true);const raw=page(receipt);
    assert.equal(raw.representation,'raw-json');assert.equal(raw.containsEncodedMedia,true);assert.equal(raw.mediaObserved,false);
    assert.equal(raw.tokenBudgetMethod,'conservative-utf8-byte-bound');assert.equal(raw.ref,saved.ref);assert.equal(raw.sha256,saved.sha256);
    assert.equal(raw.offset,offset);assert.equal(raw.text,encoded.slice(raw.offset,raw.end));assert.doesNotMatch(raw.text,/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    assert.equal(receipt.contentItems.some(item=>item.type==='inputImage'),false);
    assert.equal(evidenceResponseTokens(receipt),Buffer.byteLength(JSON.stringify(receipt),'utf8'));
    assert.ok(evidenceResponseTokens(receipt)<=1300);assert.ok(evidenceResponseTokens(receipt)>estimateContextTokens(receipt));
    parts.push(raw.text);offset=raw.nextOffset;
  }while(offset!==null);
  assert.ok(parts.length>1);assert.equal(parts.join(''),encoded);assert.equal(await readFile(saved.file,'utf8'),encoded);
});

test('Directory charges conservative raw costs across reads rather than refunding them through the prose heuristic',async t=>{
  const cwd=await workspace(t);let runner;
  runner=new ShadowdancerDirectory({cwd,conversationId:'raw-budget',runId:'raw-budget-run',model:'fixture',inputBudgetTokens:7000,runtime:{async runAgent(options){
    const payload=JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1)).payload;
    options.onEvent({type:'usage',usage:{last:{inputTokens:5000,outputTokens:0},total:{inputTokens:5000}}});
    const args={action:'read',ref:payload.rawRef,representation:'raw'};
    const first=await options.onToolCall({name:'relay_directory_context',callId:'raw-one',arguments:args});assert.equal(first.success,true);
    assert.ok(evidenceResponseTokens(first)>estimateContextTokens(first));assert.notEqual(page(first).nextOffset,null);
    const second=await options.onToolCall({name:'relay_directory_context',callId:'raw-two',arguments:{...args,offset:page(first).nextOffset}});
    assert.equal(second.success,false,'The previous raw reply already spent the remaining byte-based capacity');
    return {output:JSON.stringify({answer:'Only an encoded archive fragment was inspected; no image pixels were observed.',used_refs:[]})};
  }}});
  await runner.open();const raw=await runner.evidenceStore.save({image:{type:'inputImage',imageUrl:'data:image/png;base64,'+'ABCD'.repeat(10000)}},{kind:'original-archive'});
  await runner.infer('integration','integration/raw-budget',{task:'Inspect encoded bytes only.',instructions:'No pixel claims.',rawRef:raw.ref,required_refs:[]});
});

test('552-record global review gives redirects no inspection credit and accepts an exact projected receipt read',async t=>{
  const cwd=await workspace(t),policy=DEFAULT_PLANNING_ONTOLOGY,updates=[];let attempts=0;
  const records=Array.from({length:552},(_,i)=>({id:'global-receipt-'+i,source:'host-dispatch-receipt',callId:'global-call-'+i,tool:'relay_browser',action:'read',success:true,
    result:{success:true,contentItems:[{type:'inputText',text:i===0?'READABLE_RECEIPT_ONE '+('observed record '.repeat(80000)):'Observed record '+i},...(i%101===0&&i<=404?[{type:'inputImage',imageUrl:'data:image/png;base64,'+String(i).padStart(4,'A').repeat(1000)}]:[])]}}));
  const snapshot={request:{id:'user-request',text:'Report the exact first recorded receipt.'},policy,evidence:{auditRoot:path.join(cwd,'journal'),records,total:552,omitted:0}};
  const candidate={output:'The first recorded receipt is READABLE_RECEIPT_ONE.'},context={preset:'custom',windowTokens:240000,outputReserveTokens:10000,headroomTokens:10000};
  const runtime={async runAgent(options){
    attempts++;const packet=JSON.parse(options.prompt.split('\n\n').find(part=>part.startsWith('{"snapshot":'))),saved=packet.snapshot.savedReview;
    assert.equal(saved.mode,'indexed-exact-sources');assert.equal(saved.indexedRecords,552);assert.equal(packet.snapshot.evidence.records.length,552);
    assert.equal(saved.original.representation,'raw-json');assert.equal(saved.projected.representation,'projected-json');
    const before=await readFile(saved.original.file,'utf8');assert.equal(sha(before),saved.original.sha256);assert.equal(JSON.parse(before).snapshot.evidence.records.length,552);
    const raw=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:saved.original.ref}}),redirect=page(raw);
    assert.equal(redirect.contentReturned,false);assert.equal(redirect.projected.ref,saved.projected.ref);
    assert.equal(redirect.mediaRefs.length,5);assert.equal(raw.contentItems.some(item=>item.type==='inputImage'),false);
    if(attempts===2){
      assert.match(options.prompt,/uninspectedReferences/);
      const first=packet.snapshot.evidence.records[0];
      const receipt=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:first.savedSource.ref,limit:1300}});
      assert.equal(receipt.success,true);assert.match(page(receipt).text,/READABLE_RECEIPT_ONE/);assert.equal(page(receipt).representation,'projected-json');
    }
    assert.equal(await readFile(saved.original.file,'utf8'),before);
    return {output:JSON.stringify({decision:'respond',summary:'The recorded text supports the exact first receipt.',remaining:[],nextAction:'',evidenceRefs:['evidence-0001'],metadataOnlyRefs:[],blockers:[]})};
  }};
  const controller=createModularCompletionController({policy,getSnapshot:()=>snapshot,onUpdate:value=>updates.push(value),review:args=>reviewModularOutcome({runtime,cwd,model:'fixture',context,...args})});
  assert.equal(await controller.beforeFinal(candidate),null);assert.equal(attempts,2);
  const rejected=updates.find(row=>row.status==='rejected-repairing');assert.deepEqual(rejected.validation.uninspectedReferences,['evidence-0001']);assert.deepEqual(rejected.evidenceInspection.reads,[]);
  const accepted=(await controller.assertReady()).assessment;assert.equal(accepted.evidenceInspection.indexedRecords,552);
  assert.deepEqual(accepted.evidenceRefs,['global-receipt-0']);assert.equal(accepted.evidenceInspection.reads.length,1);
  assert.equal(accepted.evidenceInspection.reads[0].representation,'projected-json');assert.equal(accepted.evidenceInspection.reads[0].actualMedia,undefined);
});
