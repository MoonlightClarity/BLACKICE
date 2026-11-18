import test from 'node:test';
import assert from 'node:assert/strict';

import {createModularCompletionController,createModularEvidenceJournal,modularOutcomeReferenceIndex,
  modularOutcomeSchema,modularOutcomeEvidence,reviewModularOutcome} from '../lib/modular-completion.mjs';


const policy={version:2,modules:{inference:true,verification:true,replanning:true,anti_overalignment:true}};
const assessment=(evidenceRefs,patch={})=>({decision:'respond',summary:'Both accepted outcomes are supported by the recorded receipts.',remaining:[],nextAction:'',evidenceRefs,blockers:[],...patch});


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

test('unknown or fabricated citations remain rejected after review-only repairs even when text contains them',async()=>{
  const state={request:{id:'user-request',text:'Verify the existing outcome'},policy,evidence:{records:[
    {id:'canonical-receipt',sourceFile:'/saved/receipt.json',result:{receiptId:'BUSINESS-123'}}]}};
  const candidate={output:'The business result is BUSINESS-123.'},calls=[],updates=[];let returns=0;
  const controller=createModularCompletionController({policy,getSnapshot:()=>state,onReturn:()=>returns++,onUpdate:value=>updates.push(value),
    review:async args=>{calls.push(args);return assessment(['BUSINESS-123','/saved/receipt.json','fabricated-call']);}});
  assert.equal(await controller.beforeFinal(candidate),null);
  assert.equal(calls.length,3);assert.equal(returns,0);
  assert.ok(calls.every(call=>call.snapshot===state&&call.candidate===candidate));
  assert.equal(calls[0].repair,undefined);assert.equal(calls[1].repair.attempt,1);assert.equal(calls[2].repair.attempt,2);
  assert.equal(updates.at(-2).status,'rejected-evidence');assert.equal(updates.at(-1).status,'unavailable');
  assert.deepEqual(updates.at(-2).assessment.evidenceRefs,['BUSINESS-123','/saved/receipt.json','fabricated-call']);
  assert.equal((await controller.assertReady()).reviewUnavailable,true);
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
