// Integration tests for the absence of the retired Planning readiness launch gate.
// Historical viability logic has its own unit tests; it is no longer a launch requirement.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OperationsStore} from '../lib/operations.mjs';
import {TaskInbox} from '../lib/inbox.mjs';

const until=async (predicate,label='condition')=>{
  for(let i=0;i<150;i++){
    const value=await predicate();
    if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Timed out: '+label);
};
const workflow=(mode='automatic')=>({
  id:'no-readiness-workflow',name:'One authorized task',
  nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Agent',model:'fixture-model',prompt:'Act on actual evidence.'},{id:'output',type:'output'}],
  edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],
  settings:{cwd:'C:/temporary',maxParallel:1,planningMode:'off',planningExecutionMode:mode},
});
class Engine extends EventEmitter{
  constructor(){super();this.runs=new Map();this.executions=new Map();this.calls=[];this.maxConcurrentRuns=1;this.runtime={status:()=>({connected:true,authenticated:true,defaultModel:'fixture-model'})};}
  listRuns(){return structuredClone([...this.runs.values()]);}
  startRun(value){
    const id='viability-free-'+(this.calls.length+1);
    this.calls.push(structuredClone(value));
    const run={id,status:'running',settled:false,input:value.input.task,cwd:value.input.cwd,
      workflow:value.workflow,metadata:value.metadata,nodes:{agent:{status:'running',threadId:'fixture-'+id}}};
    this.runs.set(id,run);this.executions.set(id,true);
    return structuredClone(run);
  }
  finish(id){
    const run=this.runs.get(id);
    Object.assign(run,{status:'completed',settled:true,output:'One verified fixture result',finishedAt:new Date().toISOString()});
    run.nodes.agent.status='completed';
    this.executions.delete(id);
    this.emit('event',{type:'run.updated',runId:id,data:structuredClone(run)});
  }
}
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'no-planning-readiness-')),cwd=path.join(directory,'workspace');await mkdir(cwd);
  const engine=new Engine(),inbox=await new TaskInbox({dataDir:directory,engine}).init();
  let checks=0;
  const taskViability={
    withDeployment(){checks++;throw Error('Retired readiness gate must not be invoked');},
    async checkDeployment(){checks++;throw Error('Retired readiness model must not run');},
    async forRun(){checks++;throw Error('Retired readiness model must not run');},
  };
  const operations=await new OperationsStore({dataDir:directory,engine,inbox,taskViability,pollMs:50}).init();
  operations.kick=()=>{};
  t.after(async()=>{await operations.close();await inbox.close();await rm(directory,{recursive:true,force:true});});
  const definition=(name,settings={})=>({name,input:'Complete independent authorized work.',cwd,
    workflow:{...workflow(),settings:{...workflow().settings,cwd,...settings}},
    enabled:true,trigger:{type:'manual'},overlap:'queue'});
  return{directory,cwd,engine,inbox,operations,definition,checks:()=>checks};
}

test('enabled cron-style deployment and manual trigger never invoke a model-backed readiness gate',async t=>{
  const f=await fixture(t);
  const deployment=await f.operations.create({...f.definition('First'),trigger:{type:'interval',everySeconds:3600}});
  assert.equal(deployment.enabled,true);
  assert.equal(f.checks(),0);
  const job=await f.operations.trigger(deployment.id,{idempotencyKey:'first'});
  await f.operations.poll();
  await until(()=>f.operations.getJob(job.id).attempts.at(-1)?.runId,'first dispatch');
  assert.equal(f.engine.calls.length,1);
  assert.equal(f.checks(),0);
  f.engine.finish(f.engine.calls.length===1?'viability-free-1':'unexpected');
  await f.operations.poll();
  assert.equal(f.operations.getJob(job.id).status,'completed');
  assert.equal(f.checks(),0);
});

test('retired Plan-only modes reject new deployment and edits before any admission or side effects',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.operations.create({...f.definition('Retired'),planningExecutionMode:'plan_only'}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  await assert.rejects(f.operations.create({...f.definition('Retired workflow',{planningExecutionMode:'plan_only'})}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  assert.equal(f.operations.list().length,0);
  const saved=await f.operations.create(f.definition('Active'));
  await assert.rejects(f.operations.update(saved.id,{planningExecutionMode:'plan_only'}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  assert.equal(f.operations.getDeployment(saved.id).planningExecutionMode,'automatic');
  assert.equal(f.engine.calls.length,0);
  assert.equal(f.checks(),0);
});

test('a saved historical Plan-only job is held locally without blocking a different runnable job',async t=>{
  const f=await fixture(t);
  const left=await f.operations.create(f.definition('Legacy')),
    right=await f.operations.create(f.definition('Independent'));
  const old=await f.operations.trigger(left.id,{idempotencyKey:'legacy'}),
    next=await f.operations.trigger(right.id,{idempotencyKey:'independent'});
  const mutated=structuredClone(f.operations.state);
  const historical=mutated.jobs.find(item=>item.id===old.id);
  historical.definition.planningExecutionMode='plan_only';
  await f.operations.save(mutated);
  await f.operations.poll();
  assert.equal(f.operations.getJob(old.id).status,'blocked','only the old job is held');
  assert.equal(f.engine.calls.length,0);
  await f.operations.poll();
  await until(()=>f.operations.getJob(next.id).attempts.at(-1)?.runId,'independent dispatch');
  assert.equal(f.engine.calls.length,1);
  f.engine.finish('viability-free-1');
  await f.operations.poll();
  assert.equal(f.operations.getJob(next.id).status,'completed');
  assert.equal(f.operations.getJob(old.id).status,'blocked');
  assert.equal(f.checks(),0);
});

test('task-inbox admission rejects historical Plan-only workflow without queueing work',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.inbox.queue({
    input:'Do not silently execute Plan-only',title:'Retired intent',cwd:f.cwd,
    workflow:{...workflow('plan_only'),settings:{...workflow('plan_only').settings,cwd:f.cwd}},
    enqueueKey:'retired-workflow',
  }),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
  assert.equal(f.inbox.snapshot().items.length,0);
  assert.equal(f.engine.calls.length,0);
  assert.equal(f.checks(),0);
});
