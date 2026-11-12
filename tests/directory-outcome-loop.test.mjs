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
      return {output:JSON.stringify({finding:works===1?'Read instructions only':'Wrote result.txt and read it back',candidate_answer:works===1?'Unfinished':'actual verified output',uncertainty:works===1?'Required file not yet written':''})};
    }
    assert.equal(input.label,'integration');
    return {output:JSON.stringify({answer:works===1?'No work completed yet.':'Created and verified result.txt.',used_refs:input.payload.required_refs})};
  }};
  const result=await runPreparedDirectoryAgent({runtime,
    input:'/directory Create and read back result.txt.',conversationId:'same_task',runId:'same_run',model:'fixture',planningOntology:policy,
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
  const root=path.join(cwd,'.shadowdancer','same_task');
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
