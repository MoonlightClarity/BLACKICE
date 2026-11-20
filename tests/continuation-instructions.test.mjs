import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessEngine } from '../lib/engine.mjs';
import { readBundledSkill } from '../lib/skill-library.mjs';
import { CodexRuntime } from '../lib/codex.mjs';

test('revised continuation instructions reach the native turn on the same provider thread', async t => {
  const directory=await mkdtemp(path.join(tmpdir(),'relay-continuation-instructions-'));
  const fixture=fileURLToPath(new URL('./fixtures/fake-app-server.mjs',import.meta.url));
  const runtime=new CodexRuntime({command:process.execPath,args:[fixture],cwd:directory,requestTimeoutMs:5000,runTimeoutMs:8000});
  const requests=[],request=runtime._request.bind(runtime);
  const injected=await readBundledSkill('library-what-makes-done');
  const receipt={type:'skill_context_submitted',skillId:'library-what-makes-done',title:'What Makes Done'};
  let rejectTurn=false;
  runtime._request=(method,params={},...args)=>{requests.push({method,params:structuredClone(params)});if(rejectTurn&&method==='turn/start')return Promise.reject(Error('Synthetic native rejection'));return request(method,params,...args);};
  const engine=new HarnessEngine({runtime,dataDir:path.join(directory,'data'),defaultCwd:directory});
  t.after(async()=>{await engine.close();await runtime.close();await rm(directory,{recursive:true,force:true});});
  await runtime.start();await engine.init();
  const workflow={id:'native-instruction-continuity',name:'Native instruction continuity',
    nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Worker',model:'fixture-model',prompt:'ORIGINAL_AGENT_BRIEF: Inspect the saved task.'},{id:'output',type:'output'}],
    edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],
    settings:{planningMode:'off',maxParallel:1}};
  const first=engine.startRun({workflow,input:'Begin the isolated fixture.'});
  await engine.executions.get(first.id);
  assert.equal(engine.getRun(first.id).status,'completed',engine.getRun(first.id).error);
  const prompt='REVISED_AGENT_BRIEF: Use the current evidence, preserving confirmed work.';
  const next=engine.continueRun(first.id,{nodeId:'agent',message:'Continue the fixture.',prompt});
  await engine.executions.get(next.id);
  const completed=engine.getRun(next.id);
  assert.equal(completed.status,'completed',completed.error);
  assert.equal(completed.taskId,first.taskId);
  const starts=requests.filter(item=>item.method==='thread/start'),resumes=requests.filter(item=>item.method==='thread/resume'),turns=requests.filter(item=>item.method==='turn/start');
  assert.equal(starts.length,1);assert.equal(resumes.length,1);assert.equal(turns.length,2);
  const threadId=engine.getRun(first.id).nodes.agent.threadId;
  assert.equal(resumes[0].params.threadId,threadId);
  assert.equal(turns[1].params.threadId,threadId);
  const sent=turns[1].params.input.map(item=>item.text||'').join('\n');
  for(const turn of turns)assert.ok(turn.params.input[0].text.includes(injected.content));
  for(const runId of [first.id,next.id]){
    const run=engine.getRun(runId);assert.deepEqual(run.skillLoadReceipts,[receipt]);
    assert.equal(run.events.filter(event=>event.data.type===receipt.type).length,1);
  }
  assert.ok(sent.includes(prompt),'the actual native turn request carries the new brief');
  assert.ok(!sent.includes('ORIGINAL_AGENT_BRIEF'),'the resumed turn does not resend superseded instructions');
  assert.equal(engine.getRun(first.id).workflow.nodes.find(node=>node.id==='agent').prompt,workflow.nodes[1].prompt);
  rejectTurn=true;
  const failed=engine.continueRun(next.id,{nodeId:'agent',message:'Reject this synthetic turn.'});
  await engine.executions.get(failed.id);
  assert.equal(engine.getRun(failed.id).status,'failed');
  assert.equal(engine.getRun(failed.id).skillLoadReceipts,undefined);
});
