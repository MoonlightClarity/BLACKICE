import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

async function until(predicate,description) {
  const end=Date.now()+6000;
  while (Date.now()<end) {
    const found=predicate();
    if(found)return found;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Timed out: '+description);
}
class FakeProvider extends EventEmitter {
  calls=[];
  status(){return {connected:true,authenticated:true,defaultModel:'test-model'};}
  async runAgent(options){
    this.calls.push(options);
    if (!options.prompt.includes('PARENT_SPAWN_MARKER')) return {output:'Child finished its independent native task.',threadId:'child-thread'};
    assert.equal(options.dynamicTools.some(tool=>tool.name==='relay_agents'),true,
      'Native control must actually be attached to the provider turn');
    const receipt=await options.onToolCall({name:'relay_agents',arguments:{
      action:'start',requestId:'one-child',task:'Independent native child task',autonomous:false
    }});
    assert.equal(receipt.success,true);
    const child=JSON.parse(receipt.contentItems[0].text);
    assert.equal(child.completed,false,'start is admission, not completion');
    return {output:'Parent observed admission: '+child.run.runId,threadId:'parent-thread'};
  }
  async close(){}
}

test('a real BLACKICE provider turn launches a native child through shared HarnessEngine tool dispatch',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-native-agent-e2e-'));
  const cwd=path.join(dir,'workspace');await mkdir(cwd);
  const runtime=new FakeProvider(),engine=await new HarnessEngine({runtime,dataDir:path.join(dir,'state'),defaultCwd:cwd}).init();
  t.after(async()=>{await engine.close();await rm(dir,{recursive:true,force:true});});
  const workflow=createMissionWorkflow({task:'PARENT_SPAWN_MARKER',model:'default',cwd,planningMode:'off'});
  const parent=engine.startRun({workflow,input:'PARENT_SPAWN_MARKER'});
  const parentRun=await until(()=>{
    const snapshot=engine.getRun(parent.id);
    return snapshot.settled && snapshot;
  },'parent provider turn');
  assert.equal(parentRun.status,'completed',parentRun.error);
  const childId=engine.runs.get(parent.id).nativeChildRunIds?.[0];
  assert.ok(childId,'the new child is recorded on its controlling run');
  const child=await until(()=>{
    const snapshot=engine.getRun(childId);
    return snapshot.settled && snapshot;
  },'independent child turn');
  assert.equal(child.status,'completed',child.error);
  assert.match(child.output,/Child finished/);
  assert.deepEqual(child.nativeController,
    {type:'native-agent',runId:parent.id,nodeId:'agent',requestId:'one-child'});
  assert.equal(runtime.calls.length,2,'one parent and one child, not a duplicated external session');
  assert.ok(runtime.calls.every(call=>call.dynamicTools.some(tool=>tool.name==='relay_agents')),
    'both normal agent turns receive internal BLACKICE controls');
});
