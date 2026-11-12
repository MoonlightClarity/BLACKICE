import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModularCompletionController,createModularEvidenceJournal,modularOutcomeReferenceIndex,
  modularOutcomeSchema,modularOutcomeEvidence,reviewModularOutcome} from '../lib/modular-completion.mjs';
import {runShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';

const policy={version:2,modules:{inference:true,verification:true,replanning:true,anti_overalignment:true}};
const assessment=(evidenceRefs,patch={})=>({decision:'respond',summary:'Both accepted outcomes are supported by the recorded receipts.',remaining:[],nextAction:'',evidenceRefs,blockers:[],...patch});
const parseReview=options=>JSON.parse(options.prompt.split('\n\n').find(part=>part.startsWith('{"snapshot":')));

test('snapshot citation schema includes every admitted record and cannot collide with host IDs',()=>{
  const state={evidence:{records:Array.from({length:180},(_,index)=>({id:index===0?'evidence-0001':'long-run-t0005:exec-call-'+index}))}};
  const index=modularOutcomeReferenceIndex(state),schema=modularOutcomeSchema(state);
  assert.equal(index.length,180);assert.equal(new Set(index.map(row=>row.citationRef)).size,180);
  const ids=new Set(state.evidence.records.map(row=>row.id));
  assert.ok(index.every(row=>!ids.has(row.citationRef)));
  assert.deepEqual(schema.properties.evidenceRefs.items.enum,['user-request','candidate',...index.map(row=>row.citationRef)]);
  assert.deepEqual(schema.properties.blockers.items.properties.evidenceRefs.items.enum,schema.properties.evidenceRefs.items.enum);
  assert.deepEqual(schema.properties.remaining.items,{type:'string'},'Unfinished work remains ordinary text, not a citation enum');
  assert.notEqual(schema.properties.remaining,schema.properties.evidenceRefs);
  const long='Observed output '.repeat(300)+'EXACT_TAIL';
  const fallback=modularOutcomeEvidence(Array.from({length:180},(_,i)=>({data:{type:'item',stage:'completed',item:{type:'dynamicToolCall',id:'call-'+i,tool:'relay_browser',resultExcerpt:long}}})));
  assert.equal(fallback.total,180);assert.equal(fallback.omitted,0);assert.equal(fallback.records.length,180);
  assert.ok(fallback.records.every(row=>row.excerpt===long));
});

test('Directory repairs a live-shaped outcome citation failure after two accepted submissions without replaying effects',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'modular-live-reference-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const requests=[],updates=[],reviewCalls=[],workPhases=[];let returns=0;
  const receipts={atlas:'ACCEPT-4cddf231-6212-44e8-941e-0f1c689c4658',birch:'ACCEPT-a4805db3-25fa-446b-a4ba-885486942844'};
  const journal=createModularEvidenceJournal({directory:path.join(cwd,'host-receipts')});
  const dispatch=journal.wrap(async call=>{
    const record=call.arguments.record;requests.push(record);
    assert.equal(requests.filter(value=>value===record).length,1,'Completed submissions must never be replayed for review repair');
    return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({url:'http://127.0.0.1/requests/'+record+'/receipt',
      accepted:true,record,receiptId:receipts[record],text:'Submission accepted'})}]};
  });
  const candidateAnswer='Accepted Atlas '+receipts.atlas+' and Birch '+receipts.birch+'. Cedar was ineligible and was not submitted.';
  const runtime={async runAgent(options){
    if(options.prompt.startsWith('BLACKICE MODULAR OUTCOME REVIEW.')){
      const packet=parseReview(options);reviewCalls.push({options,packet});
      assert.equal(options.responseOnly,true);assert.equal(options.sandbox,'read-only');
      assert.equal(options.dynamicTools,undefined);assert.equal(options.onToolCall,undefined);assert.equal(options.onBeforeFinal,undefined);
      assert.equal(packet.candidate.output,candidateAnswer);
      assert.equal(packet.snapshot.evidence.records.length,2);
      assert.ok(packet.snapshot.evidence.records.every(row=>row.id.startsWith('live-shaped-run-t')));
      const allowed=options.outputSchema.properties.evidenceRefs.items.enum;
      assert.ok(!allowed.includes(receipts.atlas),'Business confirmation identifiers are not host citation bindings');
      if(reviewCalls.length===1){
        // The live failure rejected a nonexact reference after both effects.
        // Its discarded raw assessment is unavailable; business receipt IDs
        // reproduce this class without claiming they were the observed typo.
        return {output:JSON.stringify(assessment(Object.values(receipts)))};
      }
      assert.equal(reviewCalls.length,2);assert.match(options.prompt,/EVIDENCE CITATION CORRECTION ONLY/);
      assert.match(options.prompt,/Citation formatting alone is not unfinished user work/);
      assert.match(options.prompt,/ACCEPT-4cddf231/);
      assert.deepEqual(packet,reviewCalls[0].packet,'A citation correction uses the identical admitted observations and candidate');
      return {output:JSON.stringify(assessment(packet.snapshot.evidence.records.map(row=>row.citationRef)))};
    }
    const view=JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1));
    if(view.label==='decompose')return {output:'{"atomic":true}'};
    if(view.label==='work'){
      workPhases.push(view.label);
      for(const record of ['atlas','birch'])await options.onToolCall({name:'relay_browser',callId:'exec-'+record,arguments:{action:'click',record}});
      return {output:JSON.stringify({status:'complete',nextAction:'',finding:'Both eligible requests were accepted.',candidate_answer:candidateAnswer,uncertainty:''})};
    }
    assert.equal(view.label,'integration');
    return {output:JSON.stringify({answer:candidateAnswer,used_refs:view.payload.required_refs})};
  }};
  const controller=createModularCompletionController({policy,onReturn:()=>returns++,onUpdate:value=>updates.push(value),
    getSnapshot:async()=>({request:{id:'user-request',text:'Submit every eligible intake once, verify receipts, and leave ineligible records unsubmitted.'},policy,evidence:await journal.snapshot()}),
    review:args=>reviewModularOutcome({runtime,cwd,model:'fixture',...args})});
  const done=await runShadowdancerDirectory({cwd,conversationId:'live-shaped',runId:'live-shaped-run',model:'fixture',runtime,
    input:'/directory Submit every eligible intake once, verify receipts, and leave ineligible records unsubmitted.',planningOntology:policy,
    baseTools:[{name:'relay_browser',inputSchema:{type:'object',properties:{action:{enum:['click']}}}}],dispatchTool:dispatch,
    onBeforeFinal:controller.beforeFinal,getCompletionEvidence:()=>journal.snapshot(),getCompletionAssessment:()=>updates.at(-1)});
  assert.deepEqual(requests,['atlas','birch']);assert.equal(returns,0);assert.equal(workPhases.length,1);
  assert.equal(done.stats.outcomeContinuations,undefined);assert.equal(done.stats.completionAssessments,1);
  assert.equal(done.answer,candidateAnswer);assert.equal(reviewCalls.length,2);
  const rejected=updates.find(row=>row.status==='rejected-repairing');
  assert.deepEqual(rejected.assessment.evidenceRefs,Object.values(receipts));
  assert.deepEqual(rejected.validation.invalidReferences,Object.values(receipts));
  const canonical=(await journal.snapshot()).records.map(row=>row.id);
  const accepted=(await controller.assertReady()).assessment;
  assert.deepEqual(accepted.evidenceRefs,canonical);
  assert.deepEqual(accepted.citationBindings.map(row=>row.evidenceId),canonical);
  const saved=JSON.parse(await readFile(path.join(done.root,'conversation/context/summary.json'),'utf8'));
  assert.equal(saved.directoryStatus,'completed');
});

test('unknown or fabricated citations remain rejected after review-only repairs even when text contains them',async()=>{
  const state={request:{id:'user-request',text:'Verify the existing outcome'},policy,evidence:{records:[
    {id:'canonical-receipt',sourceFile:'/saved/receipt.json',result:{receiptId:'BUSINESS-123'}}]}};
  const candidate={output:'The business result is BUSINESS-123.'},calls=[],updates=[];let returns=0;
  const controller=createModularCompletionController({policy,getSnapshot:()=>state,onReturn:()=>returns++,onUpdate:value=>updates.push(value),
    review:async args=>{calls.push(args);return assessment(['BUSINESS-123','/saved/receipt.json','fabricated-call']);}});
  await assert.rejects(controller.beforeFinal(candidate),{code:'MODULAR_REVIEW_EVIDENCE'});
  assert.equal(calls.length,3);assert.equal(returns,0);
  assert.ok(calls.every(call=>call.snapshot===state&&call.candidate===candidate));
  assert.equal(calls[0].repair,undefined);assert.equal(calls[1].repair.attempt,1);assert.equal(calls[2].repair.attempt,2);
  assert.equal(updates.at(-1).status,'rejected-evidence');
  assert.deepEqual(updates.at(-1).assessment.evidenceRefs,['BUSINESS-123','/saved/receipt.json','fabricated-call']);
  await assert.rejects(controller.assertReady(),{code:'MODULAR_OUTCOME_INCOMPLETE'});
});

test('nested blocker references are repaired through the same exact host bindings',async()=>{
  const state={request:{id:'user-request',text:'Perform the authorized action'},policy,evidence:{records:[{id:'guarded-call',result:{code:'USER_REQUIRED',message:'Observed site challenge'}}]}};
  let calls=0,returns=0;
  const controller=createModularCompletionController({policy,getSnapshot:()=>state,onReturn:()=>returns++,review:async({repair})=>{
    calls++;
    return assessment(['user-request'],{decision:'blocked',summary:'The observed site challenge requires user input.',remaining:['Required site challenge'],
      blockers:[{scope:'the only requested site',whyNotRepairable:'The observed challenge requires user input.',evidenceRefs:[repair?'evidence-0001':'invented-challenge-id']}]});
  }});
  assert.equal(await controller.beforeFinal({output:'The requested action is blocked at the observed site challenge.'}),null);
  assert.equal(calls,2);assert.equal(returns,0);
  const final=await controller.assertReady();assert.equal(final.incomplete,true);
  assert.deepEqual(final.assessment.blockers[0].evidenceRefs,['guarded-call']);
  state.evidence.records.push({id:'changed-observation'});
  await assert.rejects(controller.assertReady(),{code:'MODULAR_OUTCOME_STALE'});
});
