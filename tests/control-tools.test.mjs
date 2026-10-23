import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createHarnessServer} from '../server.mjs';
import {CONTROL_TOOL,CONTROL_SCHEMA_VERSION,PRE_FAST_CONTROL_TOOL,PRE_FAST_CONTROL_INSTRUCTIONS,LEGACY_CONTROL_TOOL,createControlToolHandler} from '../lib/control-tools.mjs';
import {validateWorkflow} from '../lib/engine.mjs';
import {validateObservePresentation} from '../lib/live-edits.mjs';
import {recordFixturePlan} from './fixture-task-plan.mjs';

const until=async(check,label='control operation')=>{const end=Date.now()+7000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(`${label} did not settle`);};
const graph=(id='controlled-workflow')=>({id,name:'Configured through chat',nodes:[{id:'input',type:'input',name:'Task'},{id:'agent',type:'agent',name:'Worker',prompt:'Verify the original requested result.',model:'control-fixture-model'},{id:'output',type:'output',name:'Result'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}});
const unpack=result=>JSON.parse(result.contentItems.filter(item=>item.type==='inputText').map(item=>item.text).join('\n'));
const call=async(options,args,success=true)=>{const result=await options.onToolCall({name:'relay_control',arguments:args});assert.equal(result.success,success,JSON.stringify(unpack(result)));return unpack(result);};

test('pre-Fast native schema and instructions retain their exact v3 bytes', () => {
 const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
 // Recorded from the committed v3 export before adding speed fields.
 assert.equal(digest(PRE_FAST_CONTROL_TOOL),'36c87d073f7239be2743d2a865b24d0a21c95f3facc59250a525d3fe8014f007');
 assert.equal(digest(PRE_FAST_CONTROL_INSTRUCTIONS),'cf8e057939eeba9f3e8e25a62a32266a930f05d7d26a683cc9dddaf6c9095b14');
});

test('new chat configuration saves speed separately; v3 continuations and Retry keep their original catalog', async t => {
 const f=await fixture(t,async(options,index)=>{
  await recordFixturePlan(options);
  const definition=options.dynamicTools.find(tool=>tool.name==='relay_control'),description=await call(options,{action:'describe'});
  assert.deepEqual(description.tool,definition);
  if(index===1){
   assert.deepEqual(definition.inputSchema.properties.runtime.properties.defaultServiceTier.enum,['default','fast']);
   const saved=await call(options,{action:'runtime_set',runtime:{defaultServiceTier:'fast',defaultEffort:'max'}});
   assert.equal(saved.defaultServiceTier,'fast');assert.equal(saved.defaultEffort,'max');assert.equal(options.serviceTier,undefined);
   const original=await call(options,{action:'workflow_get',id:'speed-control'});
   const changed=await call(options,{action:'step_update',id:'speed-control',nodeId:'agent',expectedRevision:original.revision,step:{serviceTier:'fast'}});
   assert.equal(changed.workflow.nodes[1].serviceTier,'fast');
   const invalid=await call(options,{action:'step_update',id:'speed-control',nodeId:'agent',expectedRevision:changed.revision,step:{serviceTier:'priority'}},false);
   assert.match(invalid.error,/Standard or Fast/);
  }else{
   assert.deepEqual(definition,PRE_FAST_CONTROL_TOOL);assert.ok(options.prompt.includes(PRE_FAST_CONTROL_INSTRUCTIONS));
   const unsupported=await call(options,{action:'runtime_set',runtime:{defaultServiceTier:'fast'}},false);assert.match(unsupported.error,/saved control schema/);
  }
  options.onEvent({type:'thread',threadId:'native-speed-control'});
  if(index===2)throw Error('Observed old-schema interruption.');
  return{output:'Configuration receipt verified.',threadId:'native-speed-control'};
 });
 await f.app.engine.runtimeSettings.update({codexHistory:'codex'});await f.app.engine.saveWorkflow(validateWorkflow(graph('speed-control')));
 const first=await f.settled(f.app.engine.startRun({workflow:graph('speed-control'),input:'Save future speed settings.'}).id);
 assert.equal(first.status,'completed',first.error);assert.equal(first.nodes.agent.controlSchemaVersion,4);assert.equal(first.workflow.nodes[1].serviceTier,undefined);
 f.app.engine.runs.get(first.id).nodes.agent.controlSchemaVersion=3;
 const second=await f.settled(f.app.engine.continueRun(first.id,{nodeId:'agent',message:'Use the saved v3 native catalog.'}).id);assert.equal(second.status,'failed');assert.equal(second.nodes.agent.controlSchemaVersion,3);
 const retried=await f.settled(f.app.engine.retryRun(second.id).id);assert.equal(retried.status,'completed',retried.error);assert.equal(retried.nodes.agent.controlSchemaVersion,3);
 assert.equal(f.calls[2].threadId,'native-speed-control');assert.equal(f.app.runtimeSettings.get().defaultServiceTier,'fast');
});
test('old native control catalogs keep truthful schemas through continuation and retry',async t=>{
 const f=await fixture(t,async(options,index)=>{
  await recordFixturePlan(options,{title:'Inspect the retained control catalog',doneWhen:'Describe matches the actual attached control schema through continuation and retry.'});
  const definition=options.dynamicTools.find(tool=>tool.name==='relay_control'),description=await call(options,{action:'describe'});
  assert.deepEqual(description.tool,definition);
  if(index===1){assert.ok(definition.inputSchema.properties.runtime.properties.defaultEffort);assert.ok(definition.inputSchema.properties.deployment.properties.limits);assert.ok(definition.inputSchema.properties.runtime.properties.subagentsEnabled);}
  else{assert.deepEqual(definition,LEGACY_CONTROL_TOOL);assert.equal(description.deployment.limits,undefined);assert.doesNotMatch(options.prompt,/Use deployment\.limits/);}
  options.onEvent({type:'thread',threadId:'native-control-catalog'});
  if(index===2)throw Error('Fixture interruption.');return{output:'Catalog verified.',threadId:'native-control-catalog'};
 });
 await f.app.engine.runtimeSettings.update({codexHistory:'codex'});
 const first=await f.settled(f.app.engine.startRun({workflow:graph(),input:'Read configuration.'}).id);assert.equal(first.nodes.agent.controlSchemaVersion,CONTROL_SCHEMA_VERSION);assert.equal(first.status,'completed',first.error);
 delete f.app.engine.runs.get(first.id).nodes.agent.controlSchemaVersion;
 const second=await f.settled(f.app.engine.continueRun(first.id,{nodeId:'agent',message:'Read retained schema.'}).id);assert.equal(second.nodes.agent.controlSchemaVersion,1);assert.equal(second.status,'failed');
 const retry=await f.settled(f.app.engine.retryRun(second.id).id);assert.equal(retry.nodes.agent.controlSchemaVersion,1);assert.equal(retry.status,'completed');assert.equal(retry.nodes.agent.threadId,'native-control-catalog');assert.equal(f.calls[2].threadId,'native-control-catalog');
});
class Desktop extends EventEmitter{status(){return{available:false,enabled:false};}async setEnabled(){return this.status();}}
async function fixture(t,execute){
  const directory=await mkdtemp(path.join(tmpdir(),'relay-control-tools-')),dataDir=path.join(directory,'data'),cwd=path.join(directory,'workspace'),calls=[];
  class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[{model:'control-fixture-model'}],defaultModel:'control-fixture-model'};}async start(){return this.status();}async close(){}async runAgent(options){calls.push(options);return execute?execute(options,calls.length):{output:'Control fixture completed.',threadId:'control-thread'};}}
  const app=await createHarnessServer({port:0,dataDir,defaultCwd:cwd,runtime:new Runtime(),desktop:new Desktop()});await app.learning.updateSettings({mode:'manual'});
  t.after(async()=>{await app.close();assert.match(path.basename(directory),/^relay-control-tools-/);await rm(directory,{recursive:true,force:true});});
  const settled=id=>until(()=>{const run=app.engine.getRun(id);return run.settled&&run;},'controlled foreground task');
  return{app,cwd,calls,dataDir,settled};
}

test('the actual engine attaches the configuration gateway; saved revisions and step edits affect future runs only',async t=>{
  let firstSnapshot,updatedRevision,originalRevision;
  const context=await fixture(t,async(options,index)=>{
    await recordFixturePlan(options);
    assert.ok(options.dynamicTools.some(tool=>tool.name===CONTROL_TOOL.name));assert.match(options.prompt,/AGENT CONFIGURATION/);
    if(index===1){
      const description=await call(options,{action:'describe'});assert.ok(description.tool.inputSchema.properties.action.enum.includes('step_update'));
      const catalog=await call(options,{action:'catalog'});assert.equal(catalog.defaultModel,'control-fixture-model');assert.equal(catalog.cwd,context.cwd);assert.ok(catalog.workflows.some(item=>item.id==='controlled-workflow'));
      const original=await call(options,{action:'workflow_get',id:'controlled-workflow'});originalRevision=original.revision;assert.match(originalRevision,/^[a-f0-9]{24}$/);
      const invalid=structuredClone(original.workflow);invalid.edges.push({source:'agent',target:'input'});await call(options,{action:'workflow_save',workflow:invalid,expectedRevision:originalRevision},false);
      const saved=await call(options,{action:'workflow_save',workflow:{...original.workflow,description:'A real revision-aware save requested through chat.'},expectedRevision:originalRevision});assert.equal(saved.workflow.description,'A real revision-aware save requested through chat.');assert.notEqual(saved.revision,originalRevision);
      const created=await call(options,{action:'workflow_save',workflow:graph('new-from-agent')});assert.equal(created.workflow.id,'new-from-agent');assert.match(created.revision,/^[a-f0-9]{24}$/);
      const changed=await call(options,{action:'step_update',id:original.workflow.id,nodeId:'agent',step:{prompt:'Read the actual result before reporting success.',name:'Verifier'},expectedRevision:saved.revision});updatedRevision=changed.revision;assert.notEqual(updatedRevision,saved.revision);assert.equal(changed.applies,'future runs');assert.deepEqual(changed.workflow.nodes[1].context,original.workflow.nodes[1].context);assert.deepEqual(changed.workflow.settings.context,original.workflow.settings.context);
      await call(options,{action:'step_update',id:original.workflow.id,nodeId:'agent',step:{model:'stale-overwrite'},expectedRevision:originalRevision},false);
      await call(options,{action:'step_update',id:original.workflow.id,nodeId:'agent',step:{id:'replacement'},expectedRevision:updatedRevision},false);
      firstSnapshot=context.app.engine.getRun(catalog.currentRunId);assert.equal(firstSnapshot.workflow.nodes[1].name,'Worker');assert.equal(firstSnapshot.workflow.nodes[1].prompt,'Verify the original requested result.');assert.match(options.prompt,/Verify the original requested result/);
    }else assert.match(options.prompt,/Read the actual result before reporting success/);
    return{output:'Configured and checked the real saved workflow.',threadId:`control-${index}`};
  });
  const configured=graph();configured.nodes[1].context={preset:'custom',windowTokens:64000,autoCompact:false,outputReserveTokens:2048,headroomTokens:1024,keepRecentTokens:4096};configured.settings.context={preset:'900k',autoCompact:true};await context.app.engine.saveWorkflow(validateWorkflow(configured));const started=context.app.engine.startRun({workflow:context.app.engine.listWorkflows().find(item=>item.id==='controlled-workflow'),input:'Change the saved worker to verify outputs.'});const first=await context.settled(started.id);assert.equal(first.status,'completed',first.error);
  const saved=context.app.engine.listWorkflows().find(item=>item.id==='controlled-workflow');assert.equal(saved.nodes[1].name,'Verifier');assert.equal(saved.nodes[1].model,'control-fixture-model');assert.equal(first.workflow.nodes[1].name,'Worker');assert.equal(firstSnapshot.workflow.nodes[1].name,'Worker');
  const next=context.app.engine.startRun({workflow:saved,input:'Use the configured workflow.'});assert.equal((await context.settled(next.id)).status,'completed');assert.equal(context.calls.length,2);
  const disk=JSON.parse(await readFile(path.join(context.dataDir,'workflows.json'),'utf8'));assert.equal(disk.find(item=>item.id===saved.id).nodes[1].name,'Verifier');
});

test('the actual agent schema previews a calendar schedule before persisting its real trigger and receipt',async t=>{
  let saved;
  const context=await fixture(t,async options=>{
    await recordFixturePlan(options);
    const tool=options.dynamicTools.find(item=>item.name===CONTROL_TOOL.name);assert.ok(tool.inputSchema.properties.action.enum.includes('schedule_preview'));assert.ok(tool.inputSchema.properties.deployment.properties.trigger.properties.type.enum.includes('cron'));assert.match(options.prompt,/explicit IANA timezone/);
    const trigger={type:'cron',expression:'0 9 * * MON-FRI',timezone:'America/New_York'},before=context.app.operations.snapshot();
    const preview=await call(options,{action:'schedule_preview',trigger,count:2});assert.ok(preview.nextAt>Date.now());assert.equal(preview.occurrences.length,2);assert.deepEqual(context.app.operations.snapshot(),before,'preview is read-only');
    await call(options,{action:'schedule_preview',trigger:{...trigger,expression:'* * * * * *'}},false);
    saved=await call(options,{action:'deployment_save',deployment:{name:'Weekday fixture',input:'Run the independently configured weekday task.',cwd:context.cwd,workflow:graph('weekday-fixture'),enabled:true,trigger}});assert.deepEqual(saved.trigger,trigger);assert.ok(saved.nextAt>Date.now());assert.equal(saved.overlap,'parallel');
    const status=await call(options,{action:'operations_list'});assert.equal(status.deployments.length,1);assert.equal(status.jobs.length,0);return{output:'Saved the weekday task with its returned next occurrence.',threadId:'calendar-configuration-thread'};
  });
  const run=context.app.engine.startRun({workflow:graph('calendar-configuring-chat'),input:'Schedule an independent weekday task at 9 AM New York time.'});assert.equal((await context.settled(run.id)).status,'completed');assert.equal(context.calls.length,1);assert.ok(saved?.id);const disk=JSON.parse(await readFile(path.join(context.dataDir,'operations.json'),'utf8'));assert.equal(disk.deployments[0].nextAt,saved.nextAt);assert.deepEqual(disk.deployments[0].trigger,saved.trigger);
});

test('agents configure optional operation lifetimes and receive explicit reached-limit errors through the real control gateway',async t=>{
  let saved,receipt;const context=await fixture(t,async options=>{
    await recordFixturePlan(options);
    const description=await call(options,{action:'describe'}),schema=description.tool.inputSchema.properties.deployment.properties.limits;assert.deepEqual(schema.type,['object','null']);assert.equal(schema.properties.maxIterations.maximum,Number.MAX_SAFE_INTEGER);assert.match(description.notes.join('\n'),/retries and repeated idempotency keys do not count/);assert.match(options.prompt,/deployment.limits/);
    saved=await call(options,{action:'deployment_save',deployment:{name:'Agent finite operation',input:'Repeat the authorized fixture task.',cwd:context.cwd,workflow:graph('finite-tool-worker'),trigger:{type:'manual'},limits:{maxIterations:1,runForSeconds:3600,endAt:'2030-01-05T17:30:00-05:00'}}});assert.equal(saved.admittedJobs,0);assert.equal(saved.activatedAt,null);
    receipt=await call(options,{action:'deployment_run',id:saved.id,idempotencyKey:'one-finite-request'});const duplicate=await call(options,{action:'deployment_run',id:saved.id,idempotencyKey:'one-finite-request'});assert.equal(duplicate.id,receipt.id);const blocked=await call(options,{action:'deployment_run',id:saved.id,idempotencyKey:'second-finite-request'},false);assert.match(blocked.error,/Stopped after 1 admitted job/);
    const listed=await call(options,{action:'operations_list'}),current=listed.deployments.find(item=>item.id===saved.id);assert.equal(current.admittedJobs,1);assert.equal(current.limitStatus.reached,true);assert.ok(current.activatedAt);assert.equal(listed.jobs.length,1);
    const cleared=await call(options,{action:'deployment_update',id:saved.id,deployment:{expectedRevision:current.revision,limits:null}});assert.equal(cleared.admittedJobs,1);assert.equal(cleared.limitStatus.reached,false);assert.equal(cleared.activatedAt,current.activatedAt);return{output:'Saved and inspected the finite operation receipts.',threadId:'finite-agent-configuration'};
  });await context.app.operations.pause('Keep agent-created finite receipts queued for inspection.');const started=context.app.engine.startRun({workflow:graph('finite-configuring-chat'),input:'Set up one finite operation and inspect its receipts.'}),done=await context.settled(started.id);assert.equal(done.status,'completed',done.error);assert.ok(saved?.id);assert.ok(receipt?.id);assert.equal(context.calls.length,1);const disk=JSON.parse(await readFile(path.join(context.dataDir,'operations.json'),'utf8'));assert.equal(disk.deployments[0].admittedJobs,1);assert.equal(disk.jobs.length,1);
});

test('independent agent handlers cannot overwrite a newer saved workflow with the same stale revision',async t=>{
  const {app,cwd}=await fixture(t);await app.engine.saveWorkflow(graph());
  const run={id:'parallel-control-fixture',cwd,workflowId:'controlled-workflow'},make=()=>createControlToolHandler({engine:app.engine,getOperations:()=>app.operations,getJournal:()=>app.liveEdits,validateWorkflow,validatePresentation:validateObservePresentation,run,nodeId:'agent',signal:new AbortController().signal});
  const first=make(),second=make(),read=unpack(await first({name:'relay_control',arguments:{action:'workflow_get',id:'controlled-workflow'}}));
  const changes=await Promise.all([first({name:'relay_control',arguments:{action:'step_update',id:'controlled-workflow',nodeId:'agent',expectedRevision:read.revision,step:{name:'First writer'}}}),second({name:'relay_control',arguments:{action:'step_update',id:'controlled-workflow',nodeId:'agent',expectedRevision:read.revision,step:{prompt:'Second writer instructions.'}}})]);
  assert.equal(changes.filter(result=>result.success).length,1);assert.match(unpack(changes.find(result=>!result.success)).error,/Workflow changed/);
  const saved=app.engine.listWorkflows().find(item=>item.id==='controlled-workflow');assert.equal(saved.nodes[1].name,'First writer');assert.equal(saved.nodes[1].prompt,'Verify the original requested result.');
});

test('an agent creates and triggers an actual durable operation, receives its job receipt, and runs the side effect once',async t=>{
  let receipt,deployment;
  const context=await fixture(t,async(options,index)=>{
    await recordFixturePlan(options);
    if(index===1){
      deployment=await call(options,{action:'deployment_save',deployment:{name:'Configured operation',input:'Write and independently read the fixture proof.',cwd:context.cwd,workflow:graph('deployed-control-worker'),enabled:false,trigger:{type:'manual'},retry:{maxAttempts:0,backoffSeconds:1}}});
      receipt=await call(options,{action:'deployment_run',id:deployment.id,idempotencyKey:'one-agent-request',input:'fixture payload'});assert.equal(receipt.status,'queued');assert.equal(receipt.definition.workflow.id,'deployed-control-worker');
      const duplicate=await call(options,{action:'deployment_run',id:deployment.id,idempotencyKey:'one-agent-request',input:'fixture payload'});assert.equal(duplicate.id,receipt.id);assert.equal((await call(options,{action:'job_get',id:receipt.id})).id,receipt.id);await until(()=>context.calls.length===2,'operation starts independently of its configuring chat');
      return{output:'Created the configured operation and captured its real receipt.',threadId:'control-configurator'};
    }
    const result=await options.onToolCall({name:'relay_workspace',arguments:{action:'write',path:'control-operation.txt',text:'One verified side effect.\n'}});assert.equal(result.success,true);const read=await options.onToolCall({name:'relay_workspace',arguments:{action:'read',path:'control-operation.txt'}});assert.equal(read.success,true);return{output:'Verified one operation side effect.',threadId:'control-worker'};
  });
  const first=context.app.engine.startRun({workflow:graph('configure-operation'),input:'Create and run a durable operation.'});const done=await context.settled(first.id);assert.equal(done.status,'completed',done.error);assert.ok(receipt?.id,'gateway returned an actual durable job ID');await until(()=>context.app.operations.getJob(receipt.id).status==='completed','agent-created operation');
  assert.equal(context.calls.length,2);assert.equal(await readFile(path.join(context.cwd,'control-operation.txt'),'utf8'),'One verified side effect.\n');const job=context.app.operations.getJob(receipt.id);assert.equal(job.attempts.length,1);assert.ok(job.attempts[0].runId);assert.equal(context.app.operations.getDeployment(deployment.id).enabled,false,'manual authorization does not enable periodic execution');
});

test('Observe accepts presentation only; an agent cannot inject file evidence or alter its execution snapshot',async t=>{
  const emitted=[];
  const context=await fixture(t,async options=>{
    await recordFixturePlan(options);
    const initial=await call(options,{action:'observe_get'});assert.equal(initial.watching,false);const allowed={version:1,title:'Current file changes',focus:'edits',file:'fixture.txt',stepIds:['agent'],showAgents:false};const configured=await call(options,{action:'observe_set',presentation:allowed});assert.deepEqual(configured.presentation,allowed);
    for(const presentation of [{...allowed,events:[{path:'invented.txt',diff:'fabricated'}]},{...allowed,evidence:'made up'},{...allowed,status:'completed'},{...allowed,file:'../private.txt'},{...allowed,title:'control\u0000text'}])await call(options,{action:'observe_set',presentation},false);
    const current=await call(options,{action:'observe_get'});assert.deepEqual(current.presentation,allowed);assert.equal(current.watching,false);return{output:'Configured actual presentation without fabricated evidence.',threadId:'observe-control-thread'};
  });
  context.app.engine.on('event',event=>emitted.push(event));const started=context.app.engine.startRun({workflow:graph(),input:'Focus Observe on actual file changes.'}),run=await context.settled(started.id);assert.equal(run.status,'completed',run.error);assert.equal(context.app.liveEdits.runs.size,0);assert.equal(run.observePresentation.title,'Current file changes');assert.equal(run.events.filter(event=>event.type==='run.edit'||event.data?.type==='run.edit').length,0);assert.equal(emitted.filter(event=>event.type==='observe.presentation').length,1);assert.equal(run.workflow.nodes[1].prompt,'Verify the original requested result.');
});

test('the configuration gateway rejects nonexistent folders and attachments before saving or updating an operation',async t=>{
  let deployment;
  const context=await fixture(t,async options=>{
    await recordFixturePlan(options);
    const definition={name:'Validated deployment',input:'Use this valid isolated folder.',cwd:context.cwd,workflow:graph('validated-deployment'),attachmentIds:[],enabled:false,trigger:{type:'manual'}};
    for(const invalid of [{cwd:path.join(context.cwd,'missing-folder')},{cwd:path.join(context.cwd,'ordinary-file.txt')},{attachmentIds:['file_missing']}])await call(options,{action:'deployment_save',deployment:{...definition,...invalid}},false);
    assert.equal((await call(options,{action:'operations_list'})).deployments.length,0);deployment=await call(options,{action:'deployment_save',deployment:definition});
    for(const invalid of [{cwd:path.join(context.cwd,'missing-folder')},{cwd:path.join(context.cwd,'ordinary-file.txt')},{attachmentIds:['file_missing']}])await call(options,{action:'deployment_update',id:deployment.id,deployment:{...invalid,expectedRevision:deployment.revision}},false);
    const current=(await call(options,{action:'operations_list'})).deployments[0];assert.equal(current.revision,deployment.revision);assert.equal(current.cwd,context.cwd);assert.deepEqual(current.attachmentIds,[]);return{output:'Rejected invalid operation setup before committing.',threadId:'validation-thread'};
  });
  await writeFile(path.join(context.cwd,'ordinary-file.txt'),'This is a regular file, not a working folder.');const started=context.app.engine.startRun({workflow:graph(),input:'Check operation configuration validation.'}),run=await context.settled(started.id);assert.equal(run.status,'completed',run.error);assert.ok(deployment?.id);assert.equal(context.app.operations.snapshot().jobs.length,0);assert.equal(context.calls.length,1);
});

test('the actual agent gateway pauses operations and explicitly resumes both operations and the stopped inbox',async t=>{
  const context=await fixture(t,async options=>{
    await recordFixturePlan(options);
    const registered=options.dynamicTools.find(tool=>tool.name==='relay_control');for(const action of ['operations_pause','operations_resume','job_retry'])assert.ok(registered.inputSchema.properties.action.enum.includes(action));assert.equal(registered.inputSchema.properties.resumeInbox.type,'boolean');
    const described=await call(options,{action:'describe'});assert.ok(described.tool.inputSchema.properties.action.enum.includes('job_retry'));
    const paused=await call(options,{action:'operations_pause',reason:'Pause these configured tasks through chat.'});assert.equal(paused.paused,true);assert.equal(paused.pauseReason,'Pause these configured tasks through chat.');assert.equal((await call(options,{action:'operations_list'})).status.paused,true);assert.equal(context.app.operations.status().paused,true);
    const resumedOnlyOperations=await call(options,{action:'operations_resume',resumeInbox:false});assert.equal(resumedOnlyOperations.paused,false);assert.equal(context.app.inbox.status().paused,true,'resuming operations alone preserves the independent inbox stop');assert.ok(resumedOnlyOperations.blockedReason);
    await call(options,{action:'operations_pause'});const resumed=await call(options,{action:'operations_resume',resumeInbox:true});assert.equal(resumed.paused,false);assert.equal(resumed.blockedReason,null);assert.equal(context.app.inbox.status().paused,false);assert.equal((await call(options,{action:'operations_list'})).status.paused,false);return{output:'Paused and resumed the actual schedulers through chat.',threadId:'scheduler-control-thread'};
  });
  await context.app.inbox.pause('Explicit fixture Stop before resuming through chat.');const started=context.app.engine.startRun({workflow:graph(),input:'Pause operations, then resume operations and the task inbox.'}),run=await context.settled(started.id);assert.equal(run.status,'completed',run.error);assert.equal(context.calls.length,1);assert.equal(context.app.operations.status().paused,false);assert.equal(context.app.inbox.status().paused,false);const stored=JSON.parse(await readFile(path.join(context.dataDir,'operations.json'),'utf8'));assert.equal(stored.settings.paused,false);
});

 test('agent-facing execution settings preserve user choices and reject invalid or interrupted writes',async t=>{const{app,cwd}=await fixture(t),handler=createControlToolHandler({engine:app.engine,getOperations:()=>app.operations,validateWorkflow,run:{id:'execution-control',cwd},nodeId:'agent',signal:new AbortController().signal}),invoke=async args=>handler({name:'relay_control',arguments:args});assert.equal(unpack(await invoke({action:'execution_get'})).maxConcurrentRuns,null);const limited=await invoke({action:'execution_set',execution:{maxConcurrentRuns:64}});assert.equal(limited.success,true);assert.equal(unpack(limited).maxConcurrentRuns,64);assert.equal(app.engine.executionStatus().capacity,64);assert.equal((await invoke({action:'execution_set',execution:{maxConcurrentRuns:0}})).success,false);assert.equal(app.engine.executionStatus().capacity,64);const unlimited=await invoke({action:'execution_set',execution:{maxConcurrentRuns:null}});assert.equal(unlimited.success,true);assert.equal(app.engine.executionStatus().unlimited,true);const stopped=new AbortController();stopped.abort();const cancelHandler=createControlToolHandler({engine:app.engine,validateWorkflow,run:{id:'cancelled-control',cwd},nodeId:'agent',signal:stopped.signal}),receipt=await cancelHandler({name:'relay_control',arguments:{action:'execution_set',execution:{maxConcurrentRuns:1}}});assert.equal(receipt.success,false);assert.equal(app.engine.executionSettings().maxConcurrentRuns,null);});

test('agents read and change the same durable history preference without changing active admission',async t=>{
  let chosen;
  const context=await fixture(t,async options=>{
    await recordFixturePlan(options);
    assert.equal(options.codexHistory,'relay');
    assert.equal((await call(options,{action:'catalog'})).runtimeSettings.codexHistory,'relay');
    assert.deepEqual(await call(options,{action:'runtime_get'}),{codexHistory:'relay',runTimeoutMs:null,providerIdleTimeoutMs:300000,defaultEffort:'default',defaultServiceTier:'default',defaultContext:{preset:'model',windowTokens:null,autoCompact:true},verbosity:'balanced',subagentsEnabled:false,maxSubagents:3});
    await call(options,{action:'runtime_set',runtime:{codexHistory:'invalid'}},false);
    chosen=await call(options,{action:'runtime_set',runtime:{codexHistory:'codex'}});
    assert.equal(chosen.codexHistory,'codex');
    assert.equal(options.codexHistory,'relay','the admitted turn retains its selected visibility');
    return{output:'Preference saved for future turns.',threadId:'runtime-settings-agent'};
  });
  const saved=await context.app.engine.saveWorkflow(graph('runtime-preference'));
  const run=context.app.engine.startRun({workflow:context.app.engine.listWorkflows().find(item=>item.id==='runtime-preference'),input:{task:'Set future Codex visibility.',cwd:context.cwd}});
  await context.settled(run.id);
  assert.equal(context.app.engine.getRun(run.id).runtimeSettings.codexHistory,'relay');
  assert.equal(JSON.parse(await readFile(path.join(context.dataDir,'runtime-settings.json'),'utf8')).codexHistory,'codex');
  assert.match(chosen.applies,/future agent responses/);
});

test('agents patch user-selected durations through the real tool without changing active budgets or unrelated settings',async t=>{
  const context=await fixture(t,async options=>{
    await recordFixturePlan(options);
    assert.equal(options.timeoutMs,null);assert.equal(options.providerIdleTimeoutMs,300000);
    const tool=options.dynamicTools.find(item=>item.name==='relay_control'),schema=tool.inputSchema.properties.runtime;
    assert.equal(schema.minProperties,1);assert.equal(schema.required,undefined);assert.deepEqual(schema.properties.runTimeoutMs.type,['integer','null']);
    const saved=await call(options,{action:'runtime_set',runtime:{runTimeoutMs:30*86400000,providerIdleTimeoutMs:null}});
    assert.equal(saved.runTimeoutMs,30*86400000);assert.equal(saved.providerIdleTimeoutMs,null);assert.equal(saved.codexHistory,'relay');assert.match(saved.applies,/active work keeps/);
    assert.equal(options.timeoutMs,null,'the admitted turn retains its own budget');assert.equal(options.providerIdleTimeoutMs,300000);
    await call(options,{action:'runtime_set',runtime:{providerIdleTimeoutMs:0}},false);
    await call(options,{action:'runtime_set',runtime:{notASetting:true}},false);
    assert.equal((await call(options,{action:'runtime_get'})).runTimeoutMs,30*86400000);
    return{output:'Saved time limits for the next responses.',threadId:'time-limit-control'};
  });
  const started=context.app.engine.startRun({workflow:graph('time-limit-chat'),input:{task:'Save future response limits.',cwd:context.cwd}}),done=await context.settled(started.id);
  assert.equal(done.status,'completed',done.error);assert.equal(done.runtimeSettings.runTimeoutMs,null);
  const disk=JSON.parse(await readFile(path.join(context.dataDir,'runtime-settings.json'),'utf8'));assert.equal(disk.runTimeoutMs,30*86400000);assert.equal(disk.providerIdleTimeoutMs,null);
});

test('parallel agent runtime patches merge independently and cancellation cannot change the saved preferences',async t=>{
  const {app,cwd}=await fixture(t),make=signal=>createControlToolHandler({engine:app.engine,validateWorkflow,run:{id:'duration-control',cwd},nodeId:'agent',signal}),a=make(new AbortController().signal),b=make(new AbortController().signal);
  const results=await Promise.all([a({name:'relay_control',arguments:{action:'runtime_set',runtime:{runTimeoutMs:60000}}}),b({name:'relay_control',arguments:{action:'runtime_set',runtime:{codexHistory:'codex'}}})]);assert.ok(results.every(item=>item.success));assert.deepEqual(app.runtimeSettings.get(),{codexHistory:'codex',runTimeoutMs:60000,providerIdleTimeoutMs:300000,defaultEffort:'default',defaultServiceTier:'default',defaultContext:{preset:'model',windowTokens:null,autoCompact:true},verbosity:'balanced',subagentsEnabled:false,maxSubagents:3});
  const cancelled=new AbortController();cancelled.abort();assert.equal((await make(cancelled.signal)({name:'relay_control',arguments:{action:'runtime_set',runtime:{runTimeoutMs:null}}})).success,false);assert.equal(app.runtimeSettings.get().runTimeoutMs,60000);
});

test('agents can save future reasoning and 900k defaults without changing the active chat choices',async t=>{
  const context=await fixture(t,async options=>{
    await recordFixturePlan(options);
    assert.equal(options.effort,'default');assert.equal(options.context.windowTokens,null);
    const schema=CONTROL_TOOL.inputSchema.properties.runtime.properties;assert.ok(schema.defaultEffort.enum.includes('max'));assert.ok(schema.defaultEffort.enum.includes('ultra'));assert.ok(schema.defaultContext.properties.preset.enum.includes('900k'));
    const saved=await call(options,{action:'runtime_set',runtime:{defaultEffort:'ultra',defaultContext:{preset:'900k',autoCompact:true}}});
    assert.equal(saved.defaultEffort,'ultra');assert.equal(saved.defaultContext.windowTokens,900000);assert.equal(saved.defaultContext.autoCompact,true);assert.equal(options.effort,'default');assert.equal(options.context.windowTokens,null);return{output:'Saved future conversation defaults.',threadId:'default-control'};
  });
  const started=context.app.engine.startRun({workflow:graph('default-control-chat'),input:{task:'Set future default reasoning and context.',cwd:context.cwd}}),done=await context.settled(started.id);assert.equal(done.status,'completed',done.error);assert.equal(done.runtimeSettings.defaultEffort,'default');assert.equal(context.app.runtimeSettings.get().defaultEffort,'ultra');assert.equal(context.app.runtimeSettings.get().defaultContext.windowTokens,900000);
});

test('agents can configure and inspect optional delegation and verbosity without changing the admitted turn',async t=>{
 const context=await fixture(t,async options=>{
  await recordFixturePlan(options);
  const schema=options.dynamicTools.find(tool=>tool.name==='relay_control').inputSchema.properties.runtime.properties;
  assert.deepEqual(schema.verbosity.enum,['concise','balanced','detailed']);
  assert.equal(schema.maxSubagents.maximum,8);
  assert.equal(options.dynamicTools.some(tool=>tool.name==='relay_delegate'),false);
  const saved=await call(options,{action:'runtime_set',runtime:{subagentsEnabled:true,maxSubagents:4,verbosity:'detailed'}});
  assert.equal(saved.subagentsEnabled,true);assert.equal(saved.maxSubagents,4);assert.equal(saved.verbosity,'detailed');
  assert.equal(options.dynamicTools.some(tool=>tool.name==='relay_delegate'),false,'tools for active turns are immutable');
  return{output:'Preferences saved',threadId:'delegation-settings'};
 });
 const started=context.app.engine.startRun({workflow:graph('delegation-control'),input:'Enable parallel agents.'}),done=await context.settled(started.id);
 assert.equal(done.status,'completed',done.error);
 assert.equal(done.runtimeSettings.subagentsEnabled,false);
 const settings=context.app.runtimeSettings.get();
 assert.equal(settings.subagentsEnabled,true);assert.equal(settings.maxSubagents,4);assert.equal(settings.verbosity,'detailed');
});
