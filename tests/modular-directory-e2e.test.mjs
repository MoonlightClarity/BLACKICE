import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {modularCompletionEnabled,modularOutcomeEvidence,createModularCompletionController} from '../lib/modular-completion.mjs';
import {ShadowdancerDirectory,runShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';

const policy={version:2,modules:{inference:true,feasibility:true,decomposition:true,branching:true,replanning:true,metacognition:true,anti_overalignment:true,verification:true,subagents:true}};
const decision=(kind,patch={})=>({decision:kind,summary:kind==='continue'?'Requested effects have not been performed.':'The requested effects were read back.',remaining:kind==='continue'?['write and read back the requested artifact']:[],nextAction:kind==='continue'?'Write the artifact then verify it.':'',evidenceRefs:['user-request'],blockers:[],...patch});
const snapshot=()=>({request:{id:'user-request',text:'Create and verify the result'},policy,evidence:{total:4,omitted:0,records:[1,2,3,4].map(id=>({id:'read-'+id,tool:'relay_workspace',action:'read',success:true}))}});
async function temp(fn){const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-modular-e2e-'));try{return await fn(cwd);}finally{await rm(cwd,{recursive:true,force:true});}}

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

test('Directory honors an executable atomic package instead of resplitting its wording',async()=>temp(async cwd=>{
 const runtime={runAgent:async()=>({output:JSON.stringify({atomic:true,steps:[{objective:'unneeded one'},{objective:'unneeded two'}]})})};
 const runner=new ShadowdancerDirectory({cwd,conversationId:'atomic',runId:'atomic',model:'fixture',runtime,planningOntology:policy});
 await runner.open();await runner.plan('1','Create the deliverable and then verify it');
 assert.equal(runner.work.length,1);assert.equal(runner.stats.planningCalls,1);
 assert.equal(runner.work[0].objective,'Create the deliverable and then verify it');
}));

test('Directory carries expanded prerequisite leaves into dependent work',async()=>temp(async cwd=>{
 const runner=new ShadowdancerDirectory({cwd,conversationId:'dependencies',runId:'dependencies',model:'fixture',runtime:{runAgent:async()=>({output:'{}'})},planningOntology:policy});
 const inputs=[];
 runner.infer=async(label,module,payload)=>{
   if(label==='decompose'){
     if(payload.depth===1)return {parsed:{atomic:false,steps:[{objective:'Prepare source',done_when:'source exists'},{objective:'Consume prepared source',done_when:'derived result exists'}]}};
     if(payload.objective==='Prepare source')return {parsed:{atomic:false,steps:[{objective:'read original',done_when:'read'},{objective:'derive source',done_when:'derived'}]}};
     return {parsed:{atomic:true}};
   }
   inputs.push(payload);return {parsed:{finding:'recorded '+payload.objective,candidate_answer:'fixture result',uncertainty:''},output:'fixture result'};
 };
 await runner.open();await runner.plan('1','Prepare source and consume it');await runner.workLeaves();
 const consumer=inputs.find(input=>input.objective==='Consume prepared source');assert.ok(consumer);
 assert.deepEqual(consumer.imports.map(row=>row.ref),['module:1.1.1','module:1.1.2']);
 assert.ok(consumer.imports.every(row=>row.sourceFile&&row.candidate_answer==='fixture result'));
}));

test('Directory continuation executes only unfinished work and retains old evidence',async()=>temp(async cwd=>{
 const runner=new ShadowdancerDirectory({cwd,conversationId:'resume',runId:'resume',model:'fixture',runtime:{runAgent:async()=>({output:'{}'})},planningOntology:policy});
 await runner.open();runner.request='Create and verify two artifacts';
 const oldPath=path.join(runner.turnRoot,'original-result.json');
 await writeFile(oldPath,JSON.stringify({ref:'module:1',finding:'first artifact exists',candidate_answer:'first.txt',status:'worked_unverified'}));
 runner.allRefs=[{ref:'module:1',kind:'module',path:oldPath}];runner.work=[{id:'1',objective:'first completed package'}];
 const seen=[];
 runner.workLeaves=async steps=>{seen.push(...steps);};
 runner.integrate=async()=>({answer:'continued result',finalPath:path.join(runner.integrations,'final.json')});
 const result=await runner.continueWork('Create the missing second artifact and verify both.');
 assert.equal(result.answer,'continued result');assert.equal(seen.length,1);assert.equal(seen[0].id,'continuation-1');
 assert.deepEqual(seen[0].dependsOn,['1']);assert.equal(runner.work[0].id,'1');
 assert.equal(JSON.parse(await readFile(oldPath,'utf8')).candidate_answer,'first.txt');
 assert.equal(runner.stats.outcomeContinuations,1);
}));
