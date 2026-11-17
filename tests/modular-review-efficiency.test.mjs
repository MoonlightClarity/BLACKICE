import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {reviewModularOutcome,createModularCompletionController,MODULAR_REVIEW_INLINE_TOKEN_LIMIT} from '../lib/modular-completion.mjs';
import {estimateContextTokens} from '../lib/context.mjs';
const policy={version:2,modules:{anti_overalignment:true}};
const model={id:'fixture',contextWindowTokens:258400,runtimeDefaultContextWindowTokens:272000,maxContextWindowTokens:872000,effectiveContextWindowPercent:95};
const assessment={decision:'respond',summary:'Observed answer.',remaining:[],nextAction:'',evidenceRefs:['user-request'],blockers:[]};
const packet=options=>JSON.parse(options.prompt.split('\n\n').find(part=>part.startsWith('{"snapshot":')));

test('growing live-like browser receipts switch early to bounded exact-source review, not window-sized replay',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'review-efficiency-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const sizes=[];
 for(const count of [2,8,24]){
  const rows=Array.from({length:count},(_,i)=>({id:'call-'+i,tool:'relay_browser',action:'snapshot',success:true,result:{success:true,contentItems:[{type:'inputText',text:'Observed role '+i+' '+('exact observed page text '.repeat(4000))}]}}));
  const snapshot={request:{id:'user-request',text:'Report the observed first role.'},policy,evidence:{auditRoot:path.join(cwd,'receipts'),records:rows}};
  await reviewModularOutcome({cwd,model:'fixture',snapshot,candidate:{output:'Observed role 0.'},runtime:{status:()=>({models:[model]}),async runAgent(options){
   const p=packet(options);assert.equal(p.snapshot.savedReview.mode,'indexed-exact-sources');
   assert.equal(p.snapshot.evidence.records.length,count);assert.equal(options.prompt.includes('exact observed page text'),false);
   const size=estimateContextTokens([[options.prompt],options.dynamicTools,options.outputSchema]);sizes.push(size);assert.ok(size<MODULAR_REVIEW_INLINE_TOKEN_LIMIT, String(size));
   const original=JSON.parse(await readFile(p.snapshot.savedReview.original.file,'utf8'));assert.deepEqual(original.snapshot,snapshot);
   const ref=p.snapshot.evidence.records[0].savedSource.ref;
   const receipt=await options.onToolCall({name:'relay_directory_context',arguments:{action:'read',ref,limit:1000}});
   assert.equal(receipt.success,true);assert.match(receipt.contentItems[0].text,/Observed role 0/);
   return {output:JSON.stringify({...assessment,evidenceRefs:['evidence-0001'],metadataOnlyRefs:[]})};
  }}});
 }
 assert.ok(sizes.at(-1)-sizes[0]<10000,'Prompt grows with index metadata, not full receipt bodies');
 t.diagnostic('Indexed review prompt tokens for 2/8/24 browser receipts: '+sizes.join('/'));
});

test('successive reviews carry non-authoritative dispositions and explicit contract/evidence changes without action cap',async()=>{
 let snapshot={request:{id:'user-request',text:'Screen roles and continue suitable applications.'},policy,evidence:{records:[{id:'fit',tool:'relay_browser',action:'read',result:'Role is full-time, not temporary'}]}};
 let calls=0;
 const controller=createModularCompletionController({policy,getSnapshot:()=>snapshot,review:async({snapshot:current})=>{
  calls++;
  if(calls===1)assert.equal(current.priorOutcomeAssessment,undefined);
  else{
   const prior=current.priorOutcomeAssessment;assert.equal(prior.authority,'none');assert.equal(prior.outcomeChecks[0].disposition,'supported');
   assert.equal(prior.source,'previous-reviewer-interpretation-not-evidence');
   if(calls===2)assert.equal(prior.evidenceChanges[0].state,'unchanged');
   if(calls===3)assert.equal(prior.evidenceChanges[0].state,'changed');
   if(calls===4)assert.equal(prior.contractChanged,true);
   if(calls===5)assert.equal(prior.evidenceChanges[0].state,'missing');
  }
  return {...assessment,decision:'continue',remaining:['Inspect another lead'],nextAction:'Inspect the next lead.',evidenceRefs:['user-request',...(current.evidence.records.some(r=>r.id==='fit')?['fit']:[])],outcomeChecks:[{
   obligation:'Assess employment arrangement',basis:'user-request',contractQuote:'Screen roles',contractRefs:['user-request'],resultRefs:['fit'],disposition:'supported',material:true,reason:'Project responsibilities alone do not establish temporary employment.'
  }]};
 }});
 for(let i=1;i<=12;i++){
  if(i===3)snapshot.evidence.records[0].result='New evidence: explicitly temporary employment';
  if(i===4)snapshot.request.text='New user direction: include temporary roles.';
  if(i===5)snapshot.evidence.records=snapshot.evidence.records.filter(r=>r.id!=='fit');
  snapshot.evidence.records.push({id:'new-'+i,tool:'relay_browser',action:'read',result:'Genuinely new lead '+i});
  assert.equal((await controller.beforeFinal({output:'Partial report '+i})).continue,true);
 }
 assert.equal(calls,12,'No arbitrary review-count limit stops new work or overrides a reviewer');
});

test('citation repair re-presents a small disputed exact receipt, never treats a prior assertion as evidence',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'review-repair-source-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const snapshot={request:{id:'user-request',text:'Report the confirmed outcome.'},policy,evidence:{auditRoot:path.join(cwd,'receipts'),records:[
  {id:'large',tool:'relay_browser',action:'read',result:{text:'unrelated observation '.repeat(18000)}},
  {id:'receipt',tool:'relay_browser',action:'read',result:{text:'Confirmed receipt EXACT-42'}}
 ]}};
 let attempts=0;const updates=[];
 const controller=createModularCompletionController({policy,getSnapshot:()=>snapshot,onUpdate:r=>updates.push(r),review:args=>reviewModularOutcome({cwd,model:'fixture',...args,runtime:{status:()=>({models:[model]}),async runAgent(options){
  attempts++;const p=packet(options);assert.equal(p.snapshot.savedReview.mode,'indexed-exact-sources');
  if(attempts===1)assert.equal(p.snapshot.evidence.records[1].result,undefined);
  else {assert.equal(attempts,2);assert.equal(p.snapshot.evidence.records[1].result.text,'Confirmed receipt EXACT-42');}
  return {output:JSON.stringify({...assessment,evidenceRefs:['evidence-0002'],metadataOnlyRefs:[]})};
 }}})});
 assert.equal(await controller.beforeFinal({output:'Confirmed receipt EXACT-42'}),null);
 const accepted=(await controller.assertReady()).assessment;
 assert.deepEqual(accepted.evidenceRefs,['receipt']);assert.deepEqual(accepted.evidenceInspection.inlineEvidenceIds,['receipt']);
 assert.equal(updates.filter(r=>r.status==='rejected-repairing').length,1);
});
