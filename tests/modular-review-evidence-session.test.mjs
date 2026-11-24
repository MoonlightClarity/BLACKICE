import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assessRecordedOutcome,reviewModularOutcome} from '../lib/modular-completion.mjs';
import {ordinaryOutcomePrompt} from '../lib/chat-outcome-review.mjs';

const model={id:'fixture',contextWindowTokens:258400,runtimeDefaultContextWindowTokens:272000,maxContextWindowTokens:872000,effectiveContextWindowPercent:95};
const response=refs=>({decision:'respond',summary:'The admitted source supports the requested outcome.',remaining:[],nextAction:'',evidenceRefs:refs,blockers:[],metadataOnlyRefs:[]});
const row=(id,body)=>({id,source:'admitted-tool-delivery',tool:'relay_workspace',action:'read',success:true,result:{contentItems:[{type:'inputText',text:body}]}});
const view=options=>JSON.parse(options.prompt.split('\nREVIEW DATA (JSON):\n').at(-1));

test('citation repair retains previously registered read-only source refs without importing inspection credit',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'cascade-evidence-repair-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const records=[row('noise','Unrelated archived content. '.repeat(18000)),row('proof','Exact final check: source was saved and assertions passed.')];
  const snapshot={request:'Verify the current saved file and its test.',policy:{},evidence:{auditRoot:path.join(cwd,'audit'),records,total:records.length,omitted:0}};
  const candidate={output:'The saved code was verified.'};
  let context,derivedRef,sourceRef,attempt=0;
  const runtime={status:()=>({models:[model]}),async runAgent(options){
    const data=view(options),index=data.snapshot.evidence.records;
    assert.equal(data.snapshot.savedReview.mode,'indexed-exact-sources');
    assert.equal(index.length,2);
    attempt++;
    if(attempt===1){
      // Real reviewers may obtain additional host-generated projected source
      // refs after the first prompt. Only this scoped store can register them.
      const derived=await context.store.save({source:'read-only projected view',record:'proof'},{kind:'projected-json'});
      derivedRef=derived.ref;
      return {output:JSON.stringify(response(['invented-reference']))};
    }
    assert.equal(attempt,2);
    const reused=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:derivedRef}});
    assert.equal(reused.success,true,'A source registered in the previous review attempt remains readable.');
    assert.match(reused.contentItems[0].text,/projected view/);
    const unknown=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:'saved-'+'0'.repeat(64)}});
    assert.equal(unknown.success,false,'Unknown refs are not accepted merely because there is a store cache.');
    assert.equal(unknown.code,'EVIDENCE_REFERENCE_UNKNOWN');
    sourceRef=index[1].savedSource.ref;
    const inspected=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:sourceRef}});
    assert.equal(inspected.success,true);
    return {output:JSON.stringify(response(['evidence-0002']))};
  }};
  const updates=[];
  const result=await assessRecordedOutcome({snapshot,candidate,onUpdate:r=>updates.push(r),
    review:args=>{context=args.reviewEvidenceContext;return reviewModularOutcome({...args,runtime,cwd,model:model.id,promptBuilder:ordinaryOutcomePrompt});}});
  assert.equal(attempt,2);
  assert.equal(result.record.decision,'respond');
  assert.deepEqual(result.record.evidenceRefs,['proof']);
  assert.equal(updates[0].validation.invalidReferences[0],'invented-reference');
  assert(result.record.evidenceInspection.reads.some(read=>read.ref===sourceRef&&read.evidenceIds.includes('proof')));
  assert(!result.record.evidenceInspection.reads.some(read=>read.ref===derivedRef),'Read access does not fabricate evidence provenance or inspection credit.');
});

test('a different assessment scope cannot read saved refs from another scope',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'cascade-evidence-scope-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const context={},candidate={output:'A scoped test result.'};
  const evidence={auditRoot:path.join(cwd,'audit'),records:[row('noise','Archived noise '.repeat(26000)),row('proof','Saved test output')],total:2,omitted:0};
  let firstRef,attempt=0;
  const runtime={status:()=>({models:[model]}),async runAgent(options){
    attempt++;
    if(attempt===1){
      firstRef=(await context.store.save({secret:'scoped source'},{kind:'projected-json'})).ref;
    }else{
      const stale=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:firstRef}});
      assert.equal(stale.success,false);
      assert.equal(stale.code,'EVIDENCE_REFERENCE_UNKNOWN');
    }
    return {output:JSON.stringify(response(['user-request']))};
  }};
  for(const request of ['Verify source A','Verify source B']){
    await reviewModularOutcome({runtime,cwd,model:model.id,reviewEvidenceContext:context,
      snapshot:{request,policy:{},evidence},candidate,promptBuilder:ordinaryOutcomePrompt});
  }
  assert.equal(attempt,2);
});

test('prior reviewer concerns do not invalidate refs bound to unchanged admitted task evidence',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'cascade-review-history-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const context={};
  const snapshot={request:'Verify the saved source once',policy:{},evidence:{auditRoot:path.join(cwd,'audit'),
    records:[row('noise','Earlier log '.repeat(26000)),row('proof','Actual source and test result')],total:2,omitted:0}};
  const candidate={output:'The source was checked.'};
  let count=0,priorRef;
  const runtime={status:()=>({models:[model]}),async runAgent(options){
    count++;
    if(count===1)priorRef=(await context.store.save({proof:'saved source'},{kind:'projected-json'})).ref;
    else{
      const data=view(options);
      assert.equal(data.snapshot.priorReviewConcerns.length,1);
      const read=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:priorRef}});
      assert.equal(read.success,true,'Reviewer-only history must not reset source capabilities for the same assessment.');
    }
    return {output:JSON.stringify(response(['user-request']))};
  }};
  await reviewModularOutcome({runtime,cwd,model:model.id,reviewEvidenceContext:context,snapshot,candidate,promptBuilder:ordinaryOutcomePrompt});
  await reviewModularOutcome({runtime,cwd,model:model.id,reviewEvidenceContext:context,
    snapshot:{...snapshot,priorReviewConcerns:[{scope:'previous analysis only',status:'resolved'}]},
    candidate,promptBuilder:ordinaryOutcomePrompt});
  assert.equal(count,2);
});
