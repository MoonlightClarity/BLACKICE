import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {assessRecordedOutcome,reviewModularOutcome} from '../lib/modular-completion.mjs';
import {ordinaryOutcomePrompt} from '../lib/chat-outcome-review.mjs';

const model={id:'fixture',contextWindowTokens:258400,runtimeDefaultContextWindowTokens:272000,maxContextWindowTokens:872000,effectiveContextWindowPercent:95};
const response=(evidenceRefs,extra={})=>({decision:'respond',summary:'The file contents and final check support the requested outcome.',remaining:[],nextAction:'',evidenceRefs,blockers:[],metadataOnlyRefs:[],...extra});
const boundary='\nREVIEW DATA (JSON):\n';
const data=options=>JSON.parse(options.prompt.split(boundary).at(-1));
const row=(id,body)=>({id,source:'admitted-tool-delivery',tool:'relay_workspace',action:'read',success:true,result:{contentItems:[{type:'inputText',text:body}]}});
async function fixture(t,reviewer){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'review-continuity-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const records=[row('large-noise','Unrelated prior source text. '.repeat(18000)),
   row('file-read','Exact saved file: requested contents exist.'),
   row('check-result','Exact final check: exit 0 and assertions passed.')];
 const snapshot={request:'Save the requested file and verify its contents.',policy:{},evidence:{auditRoot:path.join(cwd,'evidence'),records,total:records.length,omitted:0}};
 const candidate={output:'The requested file is saved and checked.'};
 const updates=[],requests=[];
 const runtime={status:()=>({models:[model]}),async runAgent(options){
   const view=data(options);assert.equal(view.snapshot.savedReview.mode,'indexed-exact-sources');
   requests.push(view);
   return {output:JSON.stringify(await reviewer(options,view,requests.length))};
 }};
 const result=await assessRecordedOutcome({snapshot,candidate,onUpdate:r=>updates.push(r),
   review:args=>reviewModularOutcome({...args,runtime,cwd,model:model.id,promptBuilder:ordinaryOutcomePrompt})});
 return {result,updates,requests};
}

test('citation-only repair retains the small previously inspected citation as well as the disputed citation',async t=>{
 const f=await fixture(t,async(options,view,attempt)=>{
  const [noise,file,check]=view.snapshot.evidence.records;
  if(attempt===1){
   assert.equal(file.result,undefined);assert.equal(check.result,undefined);
   const observed=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref:file.savedSource.ref}});
   assert.equal(observed.success,true);assert.match(observed.contentItems[0].text,/Exact saved file/);
  }
  return response(['evidence-0002','evidence-0003']);
 });
 assert.equal(f.result.record.decision,'respond');
 assert.equal(f.requests.length,2);
 assert.deepEqual(f.result.record.evidenceRefs,['file-read','check-result']);
 assert.deepEqual(f.updates[0].validation.uninspectedReferences,['evidence-0003']);
 assert.deepEqual(f.result.record.evidenceInspection.inlineEvidenceIds.sort(),['check-result','file-read']);
});

test('citation repair does not convert an invented reference into admitted evidence',async t=>{
 const f=await fixture(t,()=>response(['invented-receipt']));
 assert.equal(f.result.record.decision,'unreviewed');
 assert.equal(f.result.record.reason,'MODULAR_REVIEW_EVIDENCE');
 assert.equal(f.requests.length,3);
 assert.ok(f.updates.filter(r=>r.validation).every(r=>r.validation.invalidReferences.includes('invented-receipt')));
});
