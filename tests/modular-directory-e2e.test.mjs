import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {modularCompletionEnabled,modularOutcomeEvidence,createModularCompletionController,createModularEvidenceJournal} from '../lib/modular-completion.mjs';
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
   inputs.push(payload);return {parsed:{status:'complete',nextAction:'',finding:'recorded '+payload.objective,candidate_answer:'fixture result',uncertainty:''},output:'fixture result'};
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

test('fresh Directory work continues from full host observations and performs the unfinished effects',async()=>temp(async cwd=>{
 const source='saved source '.repeat(200)+'\nVALUE=carried-without-rereading';
 await writeFile(path.join(cwd,'source.txt'),source);
 const calls=[],phases=[];
 const journal=createModularEvidenceJournal({directory:path.join(cwd,'receipts')});
 const dispatch=journal.wrap(async call=>{
   const args=call.arguments;calls.push(args);
   if(args.action==='write')await writeFile(path.join(cwd,args.path),args.text);
   const value=args.action==='write'?{path:args.path,written:true}:{path:args.path,content:await readFile(path.join(cwd,args.path),'utf8')};
   return {success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]};
 });
 const controller=createModularCompletionController({policy,
   getSnapshot:async()=>({request:{id:'user-request',text:'Read source.txt, write its VALUE to result.txt, and verify it.'},policy,evidence:await journal.snapshot()}),
   review:async({snapshot})=>snapshot.evidence.records.some(row=>row.action==='read'&&row.arguments.path==='result.txt')
     ?decision('respond'):decision('continue',{nextAction:'Use the previously read source to create result.txt and read it back.'}),
 });
 let workCalls=0;
 const runtime={runAgent:async options=>{
   const view=JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n')[1]);phases.push(view.label);
   if(view.label==='decompose')return {output:JSON.stringify({atomic:true})};
   if(view.label==='integration')return {output:JSON.stringify({answer:workCalls>1?'Created and verified result.txt.':'Preparation is unfinished.',used_refs:view.payload.required_refs})};
   assert.equal(view.label,'work');
   const hostInstruction=options.prompt.slice(0,options.prompt.indexOf('CURRENT_DIRECTORY:\n'));
   assert.match(hostInstruction,/EXECUTION PHASE/);
   assert.match(hostInstruction,/HOST PHASE INSTRUCTIONS/);
   assert.match(hostInstruction,/not the limit of available files, websites or actions/);
   assert.doesNotMatch(hostInstruction,/Work only with CURRENT_DIRECTORY contents/);
   assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_workspace'));
   if(++workCalls===1){
     await options.onToolCall({name:'relay_workspace',callId:'read',arguments:{action:'read',path:'source.txt'}});
     // A premature model summary is not proof that the source is missing.
     return {output:JSON.stringify({status:'complete',nextAction:'',finding:'Source not available in this package.',candidate_answer:'Unfinished.',uncertainty:'Need source.'})};
   }
   const evidence=view.payload.hostEvidence;
   assert.equal(evidence.length,1);
   assert.equal(evidence[0].source,'host-dispatch-receipt');
   assert.ok(evidence[0].omittedCharacters>0,'fixture crosses the former excerpt boundary');
   const actual=JSON.parse(evidence[0].result.contentItems[0].text);
   assert.equal(actual.content,source,'full observed content survives a fresh provider session');
   const value=actual.content.match(/VALUE=(.*)/)[1];
   await options.onToolCall({name:'relay_workspace',callId:'write',arguments:{action:'write',path:'result.txt',text:value}});
   const checked=await options.onToolCall({name:'relay_workspace',callId:'read',arguments:{action:'read',path:'result.txt'}});
   assert.equal(JSON.parse(checked.contentItems[0].text).content,value);
   return {output:JSON.stringify({status:'complete',nextAction:'',finding:'Wrote and read back result.txt.',candidate_answer:'Created and verified result.txt.',uncertainty:''})};
 }};
 const result=await runShadowdancerDirectory({cwd,conversationId:'operational',runId:'operational-run',model:'fixture',runtime,
   planningOntology:policy,input:'/directory Read source.txt, write its VALUE to result.txt, and verify it.',
   baseTools:[{name:'relay_workspace',inputSchema:{type:'object',properties:{action:{enum:['read','write']}}}}],dispatchTool:dispatch,
   onBeforeFinal:controller.beforeFinal,
 });
 assert.equal(await readFile(path.join(cwd,'result.txt'),'utf8'),'carried-without-rereading');
 assert.deepEqual(calls.map(call=>call.action+':'+call.path),['read:source.txt','write:result.txt','read:result.txt']);
 assert.equal(result.stats.outcomeContinuations,1);
 assert.equal((await controller.assertReady()).ready,true);
 assert.equal(phases.filter(label=>label==='work').length,2);
}));
