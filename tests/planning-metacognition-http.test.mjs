import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { TASK_SCHEMA_VERSION } from '../lib/task-state.mjs';

class Runtime extends EventEmitter {
  status(){return{connected:true,authenticated:true,models:[{model:'metacognition-fixture'}],defaultModel:'metacognition-fixture'};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){assert.fail('Inspecting judgment metadata must not dispatch an agent.');}
}

test('real Planning HTTP preserves cross-domain judgment and criterion evidence through revisioned edits and restart',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-meta-http-'));
  let app;
  const dataDir=path.join(dir,'data'),defaultCwd=dir;
  t.after(async()=>{await app?.close().catch(()=>{});await rm(dir,{recursive:true,force:true});});
  const open=async()=>{
    app=await createHarnessServer({port:0,dataDir,defaultCwd,runtime:new Runtime(),remoteAccess:false,autoAttachDesktop:false});
    await app.learning.updateSettings({mode:'off'});
    return app.listen();
  };
  let origin=await open();
  const initial=await app.tasks.ensure({taskId:'design-decision',runId:'design-decision',cwd:dir,
    goal:'Choose a useful architecture instead of treating vendor claims as hard requirements.',defaultPlan:true});
  const saved=await app.tasks.setPlan(initial.taskId,{
    plan:{layout:'sequence'},steps:[{id:'judge',title:'Make a useful and reversible architecture choice',
      kind:'action',parentId:null,dependsOn:[],status:'pending',doneWhen:'An option is recommended with evidence and a reversible test.'}]
  },{expectedRevision:initial.revision,runId:'design-decision',nodeId:'architect',schemaVersion:TASK_SCHEMA_VERSION});
  // The HTTP editor intentionally scopes writes to an existing saved
  // conversation. This fixture supplies that real archive link.
  await app.conversations.capture({
    id:'design-decision',taskId:'design-decision',
    input:'Choose a useful architecture with realistic tradeoffs.',
    status:'completed',settled:true,
    createdAt:'2026-10-27T10:00:00Z',updatedAt:'2026-10-27T10:00:00Z',
    workflow:{id:'fixture-plan',name:'Architecture review',
      nodes:[{id:'input',type:'input'},{id:'reviewer',type:'agent',name:'Reviewer'},{id:'output',type:'output'}],
      edges:[]},
    nodes:{reviewer:{status:'completed'}},events:[]
  });
  const cookie=async()=>{
    const response=await fetch(origin);const session=response.headers.get('set-cookie').split(';',1)[0];
    await response.arrayBuffer();return session;
  };
  let session=await cookie();
  const request=async(method,route,payload)=>{
    const response=await fetch(origin+route,{method,headers:{Cookie:session,...(payload?{'Content-Type':'application/json'}:{})},
      ...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(12000)});
    return {status:response.status,data:await response.json()};
  };
  const before=await request('GET','/api/tasks/design-decision');
  assert.equal(before.status,200);
  assert.equal(before.data.revision,saved.revision);
  const criterion={id:'vendor',label:'Vendor insists on plugin Z',kind:'stated_requirement',source:'external',
    evidenceStatus:'reported',priority:2,basis:'Vendor documentation says required but does not identify a dependency.'};
  const frame={outcome:'Keep the service reliable without locking the team into an unnecessary library.',
    keyUncertainty:'Does the integration actually depend on plugin Z?',
    nextProbe:'Prototype the API call using the existing library.',
    goodEnough:'One end-to-end integration and a regression test pass.',
    reassessWhen:'Two independent attempts fail for the same dependency reason.'};
  const endpoint='/api/tasks/design-decision/plan/edit';
  const invalid=await request('POST',endpoint,{expectedRevision:saved.revision,
    operations:[{type:'metadata',patch:{decisionCriteria:[{...criterion,kind:'hard_gate'}]}}]});
  assert.equal(invalid.status,400);
  assert.equal((await request('GET','/api/tasks/design-decision')).data.revision,saved.revision);
  const updated=await request('POST',endpoint,{expectedRevision:saved.revision,
    operations:[{type:'metadata',patch:{decisionCriteria:[criterion],metacognition:frame}}]});
  assert.equal(updated.status,200,JSON.stringify(updated.data));
  assert.deepEqual(updated.data.plan.decisionCriteria,[criterion]);
  assert.deepEqual(updated.data.plan.metacognition,frame);
  assert.equal(updated.data.steps[0].status,'pending');
  const stale=await request('POST',endpoint,{expectedRevision:saved.revision,
    operations:[{type:'metadata',patch:{metacognition:null}}]});
  assert.equal(stale.status,409);
  await app.close();app=null;origin=await open();session=await cookie();
  const restored=await request('GET','/api/tasks/design-decision');
  assert.equal(restored.status,200);
  assert.deepEqual(restored.data.plan.decisionCriteria,[criterion]);
  assert.deepEqual(restored.data.plan.metacognition,frame);
  assert.equal(restored.data.steps[0].status,'pending');
});
