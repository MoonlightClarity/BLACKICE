import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
import {planningProgressForRun,mergeChatRunUpdate} from '../public/next/chat/model.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';

test('saved Planning identity is published before the first inference returns, without starting operational nodes',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'planning-progress-'));
  const store=new PlanningBrowserStore({dataDir:dir});
  const request=await store.create({conversationId:'progress-conversation',title:'Progress fixture',objective:'Explain the bounded fixture.'});
  const run={id:'progress-run',status:'queued',settled:false,input:'Explain the bounded fixture.',planningMode:'on',planningExecutionMode:'automatic',
    workflow:{nodes:[{id:'agent',type:'agent'}],settings:{planningMode:'on'}},nodes:{agent:{status:'queued',output:''}}};
  const notifications=[],engine={runs:new Map([[run.id,run]]),snapshot:value=>structuredClone(value),notify:(type,value,_node,data)=>notifications.push({type,value,data})};
  engine.updateResponseCycleProgress=(value,progress)=>HarnessEngine.prototype.updateResponseCycleProgress.call(engine,value,progress);
  let admitted,finish;const entered=new Promise(resolve=>{admitted=resolve;}),held=new Promise(resolve=>{finish=resolve;});
  const runner={runtime:{status:()=>({defaultModel:'fixture-model'})},
    start:async options=>{const current=await store.get(request.id),node=current.nodes.find(item=>item.id===options.nodeId);assert.equal(node.kind,'inference');assert.equal(options.model,'fixture-model');admitted();return {attempt:{id:'held-inference-attempt'}};},
    wait:async()=>{await held;throw Error('fixture stopped after progress inspection');}};
  const service=new ResponseCycleService({store,runner,engine,
    taskViability:{forRun:async(_run,{beforeAssess})=>{await beforeAssess(request);throw Error('The held inference must not complete.');}}});
  t.after(async()=>{finish();await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  const pending=service.forRun(run);await entered;
  assert.equal(run.responseCycle.requestId,request.id);
  assert.equal(run.responseCycle.state,'running');assert.equal(run.responseCycle.stage,'inference');
  assert.ok(run.responseCycle.cycleId);assert.equal(run.responseCycle.planRef.requestId,request.id);
  assert.equal(run.status,'queued');assert.equal(run.nodes.agent.status,'queued');assert.equal(run.nodes.agent.output,'');
  assert.equal(notifications.at(-1).type,'run.updated');
  assert.equal(notifications.at(-1).data.responseCycle.requestId,request.id);
  assert.equal(planningProgressForRun(run).label,'Planning · Assessing options');
  finish();await assert.rejects(pending,/fixture stopped/);
});

test('Planning progress rejects stale or settled run objects and preserves preferences and completion state',()=>{
  const run={id:'run',status:'queued',settled:false,planningMode:'on',planningExecutionMode:'plan_only',nodes:{agent:{status:'queued'}}};
  const events=[],engine={runs:new Map([[run.id,run]]),snapshot:value=>structuredClone(value),notify:(...args)=>events.push(args)};
  const progress={requestId:'request',cycleId:'cycle',state:'running',stage:'plan'};
  const update=(value,metadata=progress)=>HarnessEngine.prototype.updateResponseCycleProgress.call(engine,value,metadata);
  assert.equal(update({...run}),false);assert.equal(events.length,0);
  assert.equal(update(run),true);assert.equal(update(run),false);
  assert.equal(run.planningMode,'on');assert.equal(run.planningExecutionMode,'plan_only');assert.equal(run.nodes.agent.status,'queued');
  run.status='completed';run.settled=true;assert.equal(update(run,{...progress,stage:'respond'}),false);assert.equal(events.length,1);
});

test('Chat worker projection and live updates preserve early Planning stage and actionable graph identity',()=>{
  const cycle={state:'running',stage:'inference',requestId:'request',cycleId:'cycle',planRef:{requestId:'request',cycleId:'cycle',nodeId:'plan',nodeRevision:1,responseId:null}};
  const run={id:'run',input:'test',status:'queued',settled:false,nodes:{agent:{status:'queued'}},workflow:{nodes:[{id:'agent',type:'agent'}]},responseCycle:cycle};
  const projected=projectFamily({runs:[run]}).runs[0];
  assert.equal(projected.responseCycle.stage,'inference');assert.equal(projected.responseCycle.requestId,'request');
  const merged=mergeChatRunUpdate(projected,{...run,responseCycle:{...cycle,stage:'plan'}});
  assert.equal(planningProgressForRun(merged).label,'Planning · Preparing plan');
  assert.equal(planningProgressForRun({...merged,responseCycle:{...cycle,state:'completed'},status:'completed',settled:true}).preparing,false);
  assert.equal(planningProgressForRun({...merged,responseCycle:undefined}),null);
});
