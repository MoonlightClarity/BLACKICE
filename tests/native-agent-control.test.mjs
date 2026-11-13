import test from 'node:test';
import assert from 'node:assert/strict';
import {NATIVE_AGENT_TOOL, createNativeAgentToolHandler} from '../lib/native-agent-control.mjs';

const tool = (handler, args) => handler({name:NATIVE_AGENT_TOOL.name,arguments:args})
  .then(value => JSON.parse(value.contentItems[0].text));

function harness() {
  const parent = {
    id:'parent', taskId:'parent', input:'Coordinate agents', cwd:process.cwd(),
    status:'running',settled:false,
    workflow:{nodes:[{id:'agent',type:'agent',model:'codex-model'}]},
    nodes:{agent:{status:'running'}}
  };
  const external = {
    id:'external',taskId:'external',input:'Existing external agent',status:'running',settled:false,
    workflow:{nodes:[{id:'ext',type:'agent',model:'external-model'}]},nodes:{ext:{status:'running'}}
  };
  const runs = new Map([[parent.id,parent],[external.id,external]]);
  const starts = [], steers = [], cancels = [], goalControls = [];
  const admitted = new Map(), storedGoals = new Map();
  let writes = 0, failSteer = false;
  const engine = {
    runs,
    get writes(){return writes;},
    startRun(input) {
      starts.push(input);
      const prior = admitted.get(input.requestId);
      if (prior) {
        assert.deepEqual(prior.input,input,'a replay must preserve its exact request');
        return {id:prior.run.id,status:prior.run.status};
      }
      const run = {id:'child' + admitted.size, taskId:'child' + admitted.size,
        status:'queued',settled:false,input:input.input.task,cwd:input.input.cwd,
        workflow:input.workflow,nodes:{agent:{status:'queued'}}};
      admitted.set(input.requestId,{input,run});runs.set(run.id,run);
      return {id:run.id,status:run.status};
    },
    async persist(){writes++;},
    async steerRun(id,value) {
      steers.push({id,...value});
      if (failSteer) throw new Error('No acknowledged response');
      return {accepted:true,queued:false};
    },
    cancelRun(id){cancels.push(id);const target=runs.get(id);target.status='cancelled';return target;},
    goals:{
      conversations:{async family(id){return {runs:[...runs.values()].filter(run=>run.id===id)};}},
      forRun(run){return storedGoals.get(run.taskId || run.id) || null;},
      async get(id){return storedGoals.get(runs.get(id)?.taskId || id) || null;},
      async control(id,input){
        goalControls.push({id,...input});
        const target = runs.get(id), root = target.taskId || id;
        const old = storedGoals.get(root) || null;
        if (input.expectedRevision !== (old?.revision || 0)) {
          throw Object.assign(new Error('Goal revision changed'),{code:'GOAL_REVISION_CONFLICT'});
        }
        const next={revision:(old?.revision || 0)+1,status:input.action==='pause'?'paused':'active',
          objective:input.objective || old?.objective};
        storedGoals.set(root,next);
        return {goal:next};
      }
    }
  };
  const handler=createNativeAgentToolHandler({engine,run:parent,nodeId:'agent'});
  return {engine,parent,external,starts,steers,cancels,goalControls,storedGoals,handler,setFailSteer:v=>failSteer=v};
}

test('native BLACKICE agent tool advertises shared execution controls',() => {
  assert.equal(NATIVE_AGENT_TOOL.name,'relay_agents');
  assert.deepEqual(NATIVE_AGENT_TOOL.inputSchema.properties.action.enum,['list','get','start','steer','stop','goal']);
});

test('internal autonomous start inherits pinned model, uses existing engine, and keeps external runs',async() => {
  const h=harness();
  const started=await tool(h.handler,{action:'start',requestId:'mission-1',task:'Audit a workspace'});
  assert.equal(started.accepted,true);
  assert.equal(started.completed,false);
  assert.equal(started.autonomous,true);
  assert.equal(h.starts[0].workflow.nodes.find(node=>node.type==='agent').model,'codex-model');
  assert.deepEqual(h.starts[0].input.goal,{objective:'Audit a workspace',maxTurns:null});
  assert.equal(h.engine.runs.get('external'),h.external);
  assert.deepEqual(h.engine.runs.get(started.run.runId).nativeController,
    {type:'native-agent',runId:'parent',nodeId:'agent',requestId:'mission-1'});
  const again=await tool(h.handler,{action:'start',requestId:'mission-1',task:'Audit a workspace'});
  assert.equal(again.run.runId,started.run.runId);
  assert.deepEqual(h.parent.nativeChildRunIds,[started.run.runId]);
  const mine=await tool(h.handler,{action:'list',scope:'mine'});
  assert.equal(mine.total,1);
  const all=await tool(h.handler,{action:'list',scope:'all'});
  assert.equal(all.total,3);
  assert.equal(h.engine.writes,1);
});

test('an internal agent can read, steer, and stop a concurrent external-controlled run',async() => {
  const h=harness();
  const before=await tool(h.handler,{action:'get',runId:'external'});
  assert.equal(before.run.runId,'external');
  assert.equal(before.run.agent[0].model,'external-model');
  const direction={action:'steer',runId:'external',message:'Examine test coverage',requestId:'direction-1'};
  const first=await tool(h.handler,direction);
  assert.equal(first.delivery.accepted,true);
  const replay=await tool(h.handler,direction);
  assert.equal(replay.replayed,true);
  assert.equal(h.steers.length,1);
  await assert.rejects(tool(h.handler,{...direction,message:'Different direction'}),{code:'NATIVE_AGENT_REQUEST_CONFLICT'});
  const stopped=await tool(h.handler,{action:'stop',runId:'external',requestId:'stop-1'});
  assert.equal(stopped.stopRequested,true);
  assert.deepEqual(h.cancels,['external']);
  assert.equal(h.engine.runs.get('parent').status,'running');
});

test('Goal changes are revision-bound and operate on the same manager external agents use',async() => {
  const h=harness();
  h.storedGoals.set('external',{revision:4,status:'active',objective:'Continue task'});
  await assert.rejects(tool(h.handler,{action:'goal',runId:'external',goalAction:'pause',requestId:'p'}),{code:'NATIVE_AGENT_GOAL_REVISION'});
  await assert.rejects(tool(h.handler,{action:'goal',runId:'external',goalAction:'pause',expectedRevision:3,requestId:'p'}),{code:'GOAL_REVISION_CONFLICT'});
  const paused=await tool(h.handler,{action:'goal',runId:'external',goalAction:'pause',expectedRevision:4,requestId:'p'});
  assert.equal(paused.goal.status,'paused');
  assert.equal(paused.goal.revision,5);
  assert.equal(h.goalControls.at(-1).action,'pause');
  const read=await tool(h.handler,{action:'goal',runId:'external',goalAction:'read'});
  assert.equal(read.goal.revision,5);
});

test('unacknowledged steering is not replayed blindly',async() => {
  const h=harness();h.setFailSteer(true);
  const args={action:'steer',runId:'external',requestId:'uncertain-1',message:'Potentially delivered'};
  await assert.rejects(tool(h.handler,args),{code:'NATIVE_AGENT_UNCERTAIN'});
  await assert.rejects(tool(h.handler,args),{code:'NATIVE_AGENT_UNCERTAIN'});
  assert.equal(h.steers.length,1);
  assert.equal(h.parent.nativeAgentReceipts[0].status,'uncertain');
});

test('stopped controllers cannot start agents or modify other runs',async() => {
  const h=harness(), controller=new AbortController();
  controller.abort();
  const handler=createNativeAgentToolHandler({engine:h.engine,run:h.parent,nodeId:'agent',signal:controller.signal});
  await assert.rejects(tool(handler,{action:'start',requestId:'x',task:'No effect'}),{code:'NATIVE_AGENT_CANCELLED'});
  assert.equal(h.starts.length,0);
});
