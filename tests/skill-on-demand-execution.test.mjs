import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';

class Runtime extends EventEmitter{
  constructor(){super();this.requests=[];}
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',model:'fixture',available:true}]};}
  async runAgent(options){
    this.requests.push(options);
    await options.onPromptAccepted?.(options.prompt);
    return{output:'Synthetic task report. No actual application was submitted.'};
  }
}

test('skills are not automatically injected and explicit selection reads the current owner revision',async t=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-on-demand-skill-'));
  const runtime=new Runtime(),catalog=createSkillsCatalog({dataDir});
  const engine=await new HarnessEngine({runtime,dataDir,defaultCwd:dataDir}).init();
  t.after(async()=>{await engine.close();await catalog.close();await rm(dataDir,{recursive:true,force:true,maxRetries:12,retryDelay:100});});
  let seq=0;
  const invoke=async task=>{
    const workflow=createMissionWorkflow({id:'authored_skill_fixture_'+(++seq),task,model:'fixture',cwd:dataDir,planningMode:'off'});
    const run=engine.startRun({workflow,input:task});
    await engine.executions.get(run.id);
    const saved=engine.getRun(run.id);
    assert.equal(saved.status,'completed',saved.error);
    return{saved,request:runtime.requests.at(-1)};
  };
  const ordinary=await invoke('Find and apply to relevant remote jobs.');
  assert.deepEqual(ordinary.saved.skillLoadReceipts||[],[],
    'current request, SOUL and tool schemas must stand without automatic skill injection');
  assert.doesNotMatch(ordinary.request.prompt,/JOB SEARCH \(advisory execution method|ANTI-COMPLETION BIAS \(/);
  assert.equal(ordinary.saved.nodes.agent.skillSelection.mode,'on-demand');
  assert.equal(ordinary.saved.nodes.agent.skillSelection.automaticDelivery,false);

  const id='library-job-search';
  const original=await catalog.detail({id});
  const saved=await catalog.save({id,value:{expectedRevision:original.revision,content:'# Job Search\n\nFirst owner revision: ACCURACY_A_5109.'}});
  const explicit=await invoke('Use the Job Search skill. Then explain your plan.');
  assert.match(explicit.request.prompt,/ACCURACY_A_5109/);
  assert.equal(explicit.saved.skillLoadReceipts[0].skillId,id);
  assert.equal(explicit.saved.skillLoadReceipts[0].sourceRevision,saved.revision);
  const saved2=await catalog.save({id,value:{expectedRevision:saved.revision,content:'# Job Search\n\nUpdated owner revision: ACCURACY_B_7703.'}});
  const newer=await invoke('Use the Job Search skill. Then explain your plan.');
  assert.match(newer.request.prompt,/ACCURACY_B_7703/);
  assert.doesNotMatch(newer.request.prompt,/ACCURACY_A_5109/);
  assert.equal(newer.saved.skillLoadReceipts[0].sourceRevision,saved2.revision);
  await catalog.delete({id,value:{expectedRevision:saved2.revision}});
  const removed=await invoke('Use the Job Search skill. Then explain your plan.');
  assert.doesNotMatch(removed.request.prompt,/ACCURACY_[AB]_/);
  assert.equal((removed.saved.skillLoadReceipts||[]).length,0,'deleted skills never resurrect old content');
});
