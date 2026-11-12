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

test('retired Planning admission cannot publish progress or start operational nodes',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'planning-progress-'));
  const store=await new PlanningBrowserStore({dataDir:dir}).init();
  const run={id:'progress-run',status:'queued',settled:false,input:'Explain the bounded fixture.',planningMode:'on',planningExecutionMode:'automatic',
    workflow:{nodes:[{id:'agent',type:'agent'}],settings:{planningMode:'on'}},nodes:{agent:{status:'queued',output:''}}};
  const before=structuredClone(run),notifications=[];let providerCalls=0,viabilityCalls=0;
  const engine={runs:new Map([[run.id,run]]),snapshot:value=>structuredClone(value),notify:(...args)=>notifications.push(args)};
  engine.updateResponseCycleProgress=(value,progress)=>HarnessEngine.prototype.updateResponseCycleProgress.call(engine,value,progress);
  const service=new ResponseCycleService({store,runner:{start:async()=>{providerCalls++;}},engine,taskViability:{forRun:async()=>{viabilityCalls++;}}});
  t.after(async()=>{await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  await assert.rejects(service.forRun(run),{code:'PLANNING_CYCLE_RETIRED',status:410});
  assert.deepEqual(run,before);assert.deepEqual(notifications,[]);
  assert.equal(providerCalls,0);assert.equal(viabilityCalls,0);
  assert.equal(planningProgressForRun(run),null);
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
