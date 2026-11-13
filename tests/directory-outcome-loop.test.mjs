import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runPreparedDirectoryAgent} from '../lib/shadowdancer-engine.mjs';

const policy={version:2,modules:{inference:true,feasibility:true,decomposition:true,branching:true,replanning:true,metacognition:true,anti_overalignment:true,verification:true,subagents:true}};

test('full prepared Directory resumes an unfinished candidate within the same run',async()=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-directory-outcome-'));
 try{
  const phases=[],events=[];let works=0,reviews=0,assessment=null;
  const runtime={runAgent:async options=>{
    const at=options.prompt.indexOf('CURRENT_DIRECTORY:\n');
    assert.notEqual(at,-1);
    const input=JSON.parse(options.prompt.slice(at+'CURRENT_DIRECTORY:\n'.length));
    phases.push(input.label);
    assert.equal(input.planningOntology.modules.verification,true);
    assert.equal(options.developerInstructions,'Preserve the authored modular policy.');
    assert.equal(options.hostOnlyTools,true);
    assert.equal(options.onBeforeFinal,undefined,'whole-goal completion must not run on a partial phase');
    if(input.label==='decompose')return {output:JSON.stringify({atomic:true,reason:'one bounded deliverable'})};
    if(input.label==='work'){
      works++;
      if(works===2)await writeFile(path.join(cwd,'result.txt'),'actual verified output\n');
      return {output:JSON.stringify({status:'complete',nextAction:'',finding:works===1?'Read instructions only':'Wrote result.txt and read it back',candidate_answer:works===1?'Unfinished':'actual verified output',uncertainty:works===1?'Required file not yet written':''})};
    }
    assert.equal(input.label,'integration');
    return {output:JSON.stringify({answer:works===1?'No work completed yet.':'Created and verified result.txt.',used_refs:input.payload.required_refs})};
  }};
  const result=await runPreparedDirectoryAgent({runtime,
    input:'/directory Create and read back result.txt.',conversationId:'same_task',runId:'same_run',model:'remote::fixture',planningOntology:policy,
    getAcceptedDirections:()=>({currentUserRequest:{text:'Create and read back result.txt.'}}),
    getCompletionAssessment:()=>assessment,
    options:{cwd,model:'fixture',sandbox:'danger-full-access',developerInstructions:'Preserve the authored modular policy.',dynamicTools:[],
      onEvent:e=>events.push(e),onBeforeFinal:async()=>{
        reviews++;
        if(reviews===1){assessment={decision:'continue',summary:'The required file is absent.'};return {continue:true,prompt:'Write result.txt and read it back; preserve any prior work.'};}
        assert.equal(await readFile(path.join(cwd,'result.txt'),'utf8'),'actual verified output\n');
        assessment={decision:'respond',summary:'Exact actual bytes verified.'};return null;
      }} });
  assert.equal(works,2);assert.equal(reviews,2);assert.match(result.output,/Created and verified/);
  assert.equal(phases.filter(x=>x==='decompose').length,1,'do not replay original planning');
  assert.equal(events.filter(x=>x.type==='message'&&x.phase==='final_answer').length,1,'only accepted result is published');
  const root=path.join(cwd,'.blackice','directory','same_task');
  const summary=JSON.parse(await readFile(path.join(root,'conversation/context/summary.json'),'utf8'));
  assert.equal(summary.currentRun,'same_run');assert.equal(summary.directoryStatus,'completed');assert.equal(summary.outcomeAssessment.decision,'respond');
  const first=JSON.parse(await readFile(path.join(root,'runs/same_run/integration/round-01/group-001/result.json'),'utf8'));
  assert.equal(first.answer,'No work completed yet.','old synthesis remains auditable');
  const second=JSON.parse(await readFile(path.join(root,'runs/same_run/integration/continuation-001/round-01/group-001/result.json'),'utf8'));
  assert.equal(second.answer,'Created and verified result.txt.');
  const audit=JSON.parse(await readFile(path.join(root,'runs/same_run/completion/0002.json'),'utf8'));
  assert.equal(audit.continue,false);
 }finally{await rm(cwd,{recursive:true,force:true});}
});

test('incomplete work checkpoints continue tools in the same phase before any synthesis',async()=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-directory-work-session-'));
 try{
  const phases=[],actions=[];let finalReviews=0,pilot;
  const tool={name:'relay_workspace',inputSchema:{type:'object',properties:{action:{enum:['read','write']},path:{type:'string'},text:{type:'string'}}}};
  const runtime={runAgent:async options=>{
    const input=JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n')[1]);phases.push(input.label);
    if(input.label==='decompose')return {output:'{"atomic":true}'};
    if(input.label==='integration'){
      assert.equal(await readFile(path.join(cwd,'finished.txt'),'utf8'),'observed bytes');
      assert.equal(options.onBeforeFinal,undefined,'synthesis must not use the work checkpoint');
      return {output:JSON.stringify({answer:'Created and read back finished.txt.',used_refs:input.payload.required_refs})};
    }
    assert.equal(input.label,'work');assert.equal(typeof options.onBeforeFinal,'function');
    const checkpoint={status:'incomplete',nextAction:'Write finished.txt, then read it back.',finding:'The destination remains to be created.',candidate_answer:'Unfinished.',uncertainty:'No write yet.'};
    const again=await options.onBeforeFinal({output:JSON.stringify(checkpoint)});
    assert.equal(again.continue,true);assert.match(again.prompt,/same work|THIS EXECUTION PHASE/);
    assert.deepEqual(phases,['decompose','work'],'do not synthesize an intermediate work report');
    await options.onToolCall({name:'relay_workspace',callId:'write',arguments:{action:'write',path:'finished.txt',text:'observed bytes'}});
    const observed=await options.onToolCall({name:'relay_workspace',callId:'read',arguments:{action:'read',path:'finished.txt'}});
    assert.equal(observed.contentItems[0].text,'observed bytes');
    const complete={status:'complete',nextAction:'',finding:'Wrote and read back finished.txt.',candidate_answer:'Created and verified.',uncertainty:''};
    assert.equal(await options.onBeforeFinal({output:JSON.stringify(complete)}),null);
    return {output:JSON.stringify(complete),threadId:'one-work-session'};
  }};
  await runPreparedDirectoryAgent({runtime,input:'/directory Create finished.txt with observed bytes and read it back.',
    conversationId:'same-session',runId:'same-session-run',model:'fixture',planningOntology:policy,onResult:value=>{pilot=value;},
    options:{cwd,sandbox:'danger-full-access',dynamicTools:[tool],onBeforeFinal:async()=>{finalReviews++;return null;},
      onToolCall:async call=>{
        const a=call.arguments;actions.push(a.action);
        if(a.action==='write'){await writeFile(path.join(cwd,a.path),a.text);return {success:true,contentItems:[{type:'inputText',text:'written'}]};}
        return {success:true,contentItems:[{type:'inputText',text:await readFile(path.join(cwd,a.path),'utf8')}]};
      }},
  });
  assert.deepEqual(phases,['decompose','work','integration']);
  assert.deepEqual(actions,['write','read']);assert.equal(finalReviews,1);
  assert.equal(pilot.stats.workContinuations,1);assert.equal(pilot.stats.outcomeContinuations,undefined);
  const checkpointRoot=path.join(cwd,'.blackice/directory/same-session/runs/same-session-run/modules/1/checkpoints');
  assert.equal(JSON.parse(await readFile(path.join(checkpointRoot,'0001.json'),'utf8')).status,'incomplete');
  const completed=JSON.parse(await readFile(path.join(checkpointRoot,'0002.json'),'utf8'));
  assert.equal(completed.status,'complete');assert.equal(completed.hostEvidence.length,2);
 }finally{await rm(cwd,{recursive:true,force:true});}
});

test('repeated incomplete work checkpoints cannot escape as a successful final or loop indefinitely',async()=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-directory-work-stall-'));
 try{
  let workSessions=0,synthesis=0;
  const runtime={runAgent:async options=>{
    const input=JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n')[1]);
    if(input.label==='decompose')return {output:'{"atomic":true}'};
    if(input.label==='integration'){synthesis++;throw Error('Stalled work must not enter synthesis');}
    workSessions++;
    const candidate={output:JSON.stringify({status:'incomplete',nextAction:'Read the available source.',finding:'No work yet.',candidate_answer:'Unfinished.',uncertainty:'Source not inspected.'})};
    assert.equal((await options.onBeforeFinal(candidate)).continue,true);
    assert.equal((await options.onBeforeFinal(candidate)).continue,true);
    await options.onBeforeFinal(candidate);
    throw Error('The third unchanged checkpoint should fail');
  }};
  await assert.rejects(runPreparedDirectoryAgent({runtime,input:'/directory Read the source and create the result.',
    conversationId:'stalled-work',runId:'stalled-work-run',model:'fixture',planningOntology:policy,
    options:{cwd,sandbox:'danger-full-access',dynamicTools:[{name:'relay_workspace',inputSchema:{type:'object',properties:{action:{enum:['read','write']}}}}],onToolCall:async()=>{throw Error('No tool is expected in this non-progress fixture');}},
  }),{code:'DIRECTORY_WORK_STALLED'});
  assert.equal(workSessions,1);assert.equal(synthesis,0);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
