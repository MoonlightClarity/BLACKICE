import test from 'node:test';
import assert from 'node:assert/strict';

import {reviewModularOutcome,modularCompletionEnabled,modularOutcomeEvidence,createModularCompletionController,createModularEvidenceJournal} from '../lib/modular-completion.mjs';


const policy={version:2,modules:{inference:true,feasibility:true,decomposition:true,branching:true,replanning:true,metacognition:true,anti_overalignment:true,verification:true,subagents:true}};
const decision=(kind,patch={})=>({decision:kind,summary:kind==='continue'?'Requested effects have not been performed.':'The requested effects were read back.',remaining:kind==='continue'?['write and read back the requested artifact']:[],nextAction:kind==='continue'?'Write the artifact then verify it.':'',evidenceRefs:['user-request'],blockers:[],...patch});
const snapshot=()=>({request:{id:'user-request',text:'Create and verify the result'},policy,evidence:{total:4,omitted:0,records:[1,2,3,4].map(id=>({id:'read-'+id,tool:'relay_workspace',action:'read',success:true}))}});


// Regression for the real Luna response after four successful preparation reads.
test('modular completion continues the same accepted task after preparatory reads',async()=>{
 const state=snapshot(),updates=[];let reviews=0;
 const controller=createModularCompletionController({policy,getSnapshot:()=>state,review:async()=>decision(++reviews===1?'continue':'respond'),onUpdate:r=>updates.push(r)});
 const next=await controller.beforeFinal({output:'I found the registry instructions, but this turn ended. No applications were submitted.'});
 assert.equal(next.continue,true);assert.match(next.prompt,/same task|CURRENT DELEGATED TASK/);
 await assert.rejects(controller.assertReady(),{code:'MODULAR_OUTCOME_INCOMPLETE'});
 state.evidence.records.push({id:'write-verified',tool:'relay_workspace',action:'read',success:true,excerpt:'Actual output bytes match'});
 assert.equal(await controller.beforeFinal({output:'Created and verified the requested result.'}),null);
 assert.equal((await controller.assertReady()).ready,true);
 assert.equal(updates.filter(r=>r.source).length,2);
 assert.equal(policy.modules.verification,true);
});

test('no-progress candidates stay incomplete rather than becoming successful',async()=>{
 const controller=createModularCompletionController({policy,getSnapshot:snapshot,review:async()=>decision('continue')});
 for(let i=0;i<2;i++)assert.equal((await controller.beforeFinal({output:'The turn ended.'})).continue,true);
 await assert.rejects(controller.beforeFinal({output:'The turn ended.'}),{code:'MODULAR_OUTCOME_STALLED'});
 await assert.rejects(controller.assertReady(),{code:'MODULAR_OUTCOME_INCOMPLETE'});
});

test('a local blocker cannot stop independent authorized work',async()=>{
 const controller=createModularCompletionController({policy,getSnapshot:snapshot,review:async()=>decision('blocked',{
   remaining:['two independent items'],nextAction:'Continue the other item.',blockers:[{scope:'one item',evidenceRefs:['read-1'],whyNotRepairable:'Unavailable target'}]
 })});
 assert.equal((await controller.beforeFinal({output:'One target is unavailable.'})).continue,true);
});

test('authored module prohibitions are not silently re-enabled',()=>{
 assert.equal(modularCompletionEnabled(null),false);
 assert.equal(modularCompletionEnabled({modules:{verification:'forbidden',replanning:'forbidden',anti_overalignment:'forbidden'}}),false);
 assert.equal(modularCompletionEnabled(policy),true);
});

test('tool evidence combines actual receipt and retained result, not commentary',()=>{
 const result=modularOutcomeEvidence([
   {data:{type:'message',text:'I will create a file'}},
   {data:{type:'tool.result',callId:'call-1',tool:'relay_workspace',action:'write',success:true,status:'completed'}},
   {data:{type:'item',stage:'completed',item:{type:'dynamicToolCall',id:'call-1',tool:'relay_workspace',action:'write',success:true,resultExcerpt:'bytesWritten=3'}}}
 ]);
 assert.equal(result.total,1);assert.equal(result.records[0].excerpt,'bytesWritten=3');assert.equal(result.records[0].success,true);
});
