import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runPreparedDirectoryAgent} from '../lib/shadowdancer-engine.mjs';
import {createModularCompletionController} from '../lib/modular-completion.mjs';
const policy={version:2,modules:{inference:true,feasibility:true,decomposition:true,branching:true,replanning:true,metacognition:true,anti_overalignment:true,verification:true,subagents:true}};

test('actual tool evidence survives Directory synthesis and report repair does not replay work',async()=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-directory-receipts-'));
 try{
  let workCalls=0,integrationCalls=0,writes=0,assessment=null,reviews=0;
  const tool={name:'relay_workspace',description:'Fixture file operations',inputSchema:{type:'object',properties:{action:{enum:['read','write']},path:{type:'string'},text:{type:'string'}}}};
  const runtime={runAgent:async options=>{
    assert.equal(options.cwd,cwd,'context directory must not replace operational workspace');
    const marker='CURRENT_DIRECTORY:\n',i=options.prompt.indexOf(marker);
    const input=JSON.parse(options.prompt.slice(i+marker.length));
    if(input.label==='decompose')return {output:'{"atomic":true}'};
    if(input.label==='work'){
      workCalls++;assert.deepEqual(options.outputSchema.required,['finding','candidate_answer','uncertainty']);
      await options.onToolCall({name:'relay_workspace',callId:'write-real',arguments:{action:'write',path:'actual.txt',text:'verified bytes\n'}});
      await options.onToolCall({name:'relay_workspace',callId:'read-real',arguments:{action:'read',path:'actual.txt'}});
      return {output:JSON.stringify({finding:'actual.txt was written and read back',candidate_answer:'Verified bytes persisted.',uncertainty:''})};
    }
    assert.equal(input.label,'integration');integrationCalls++;
    assert.deepEqual(options.outputSchema.required,['answer','used_refs']);
    const evidence=input.payload.records.flatMap(x=>x.content.hostEvidence||[]);
    assert.equal(evidence.length,2);assert.ok(evidence.every(x=>x.source==='host-dispatch-receipt'&&x.sourceFile));
    assert.ok(evidence.some(x=>x.action==='read'&&x.excerpt.includes('verified bytes')));
    const attached=options.dynamicTools.find(x=>x.name==='relay_workspace');
    assert.deepEqual(attached.inputSchema.properties.action.enum,['read'],'synthesis can inspect but cannot repeat writes');
    return {output:JSON.stringify({answer:integrationCalls===1?'No observed work is available.':'The saved write and read-back confirm actual.txt contains verified bytes.',used_refs:input.payload.required_refs})};
  }};
  const result=await runPreparedDirectoryAgent({runtime,input:'/directory Create actual.txt and verify it.',conversationId:'receipts',runId:'receipts-run',model:'fixture',planningOntology:policy,getCompletionAssessment:()=>assessment,
    options:{cwd,model:'fixture',sandbox:'danger-full-access',dynamicTools:[tool],
      onToolCall:async call=>{const a=call.arguments;if(a.action==='write'){writes++;await writeFile(path.join(cwd,a.path),a.text);return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({path:a.path,bytesWritten:a.text.length})}]};}return {success:true,contentItems:[{type:'inputText',text:await readFile(path.join(cwd,a.path),'utf8')}]};},
      onBeforeFinal:async()=>{reviews++;if(reviews===1){assessment={decision:'revise_response',summary:'The candidate denies actual recorded tools.'};return {continue:true,responseOnly:true,prompt:'Correct the final report using the actual write/read receipts. Do not repeat the file write.'};}assessment={decision:'respond',summary:'Report matches actual receipts.'};return null;}}
  });
  assert.equal(workCalls,1);assert.equal(writes,1);assert.equal(integrationCalls,2);assert.equal(reviews,2);
  assert.match(result.output,/saved write and read-back/);
  assert.equal(await readFile(path.join(cwd,'actual.txt'),'utf8'),'verified bytes\n');
  const root=path.join(cwd,'.shadowdancer/receipts/runs/receipts-run');
  const first=JSON.parse(await readFile(path.join(root,'integration/round-01/group-001/result.json'),'utf8'));
  assert.equal(first.answer,'No observed work is available.','failed candidate evidence remains immutable');
  const summary=JSON.parse(await readFile(path.join(cwd,'.shadowdancer/receipts/conversation/context/summary.json'),'utf8'));
  assert.equal(summary.outcomeAssessment.decision,'respond');
 }finally{await rm(cwd,{recursive:true,force:true});}
});

test('a reporting contradiction requests response-only repair, not repeated effects',async()=>{
 const snapshot={request:{id:'user-request',text:'Create file'},evidence:{records:[{id:'readback',success:true,excerpt:'exact bytes'}]}};
 const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,review:async()=>({decision:'revise_response',summary:'The report contradicts the recorded read-back.',remaining:[],nextAction:'Correct the report only.',evidenceRefs:['readback'],blockers:[]})});
 const result=await c.beforeFinal({output:'No file was created.'});
 assert.equal(result.continue,true);assert.equal(result.responseOnly,true);assert.match(result.prompt,/DO NOT REPEAT COMPLETED EFFECTS/);
});
