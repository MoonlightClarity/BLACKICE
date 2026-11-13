import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
import {VisualArtifacts,nativeVisualTools} from '../lib/visual-artifacts.mjs';
import {VISUAL_EXAMPLE} from '../public/visual-document.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

test('one provider turn can create a visual and start a supervised native agent',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-shared-turn-'));
  const cwd=path.join(dir,'work');await mkdir(cwd);
  const store=new VisualArtifacts({dataDir:dir});let visualId;
  class Runtime extends EventEmitter {
    status(){return {connected:true,authenticated:true,defaultModel:'fixture'};}
    async close(){}
    async runAgent(options){
      if(!options.prompt.includes('SHARED_TURN_MARKER'))return {output:'Child completed.',threadId:'child'};
      assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_visual'));
      assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_agents'));
      const visual=await options.onToolCall({name:'relay_visual',arguments:{action:'create',requestId:'shared-visual',document:VISUAL_EXAMPLE}});
      assert.equal(visual.success,true);visualId=JSON.parse(visual.contentItems[0].text).id;
      const agent=await options.onToolCall({name:'relay_agents',arguments:{action:'start',requestId:'shared-child',task:'Independent child task',autonomous:false}});
      assert.equal(agent.success,true);
      return {output:'Visual and child created.',threadId:'parent'};
    }
  }
  const engine=await new HarnessEngine({runtime:new Runtime(),dataDir:dir,defaultCwd:cwd,nativeVisualTools:nativeVisualTools(store)}).init();
  t.after(async()=>{await engine.close();await rm(dir,{recursive:true,force:true});});
  const workflow=createMissionWorkflow({task:'SHARED_TURN_MARKER',model:'default',cwd,planningMode:'off'});
  const run=engine.startRun({workflow,input:'SHARED_TURN_MARKER'});
  await engine.executions.get(run.id);
  const done=engine.getRun(run.id);
  assert.equal(done.status,'completed',done.error);
  assert.ok(engine.runs.get(run.id).nativeChildRunIds?.length);
  assert.equal((await store.read({conversationId:run.taskId||run.id,artifactId:visualId})).runId,run.id);
});
