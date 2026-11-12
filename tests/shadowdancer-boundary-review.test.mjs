import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ShadowdancerDirectory,runShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
import {planShadowdancerRebuild} from '../lib/shadowdancer-rebuild.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';
import {createOperationalEffectGuard} from '../lib/operational-effect-guard.mjs';
import {createWorkspaceToolHandler} from '../lib/workspace-tools.mjs';
import {runPreparedDirectoryAgent} from '../lib/shadowdancer-engine.mjs';
import {aggregateTokenUsage,tokenUsageMeasurement,TOKEN_USAGE_FIELDS} from '../public/token-usage.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'blackice-directory-boundary-'));
  const cwd=path.join(root,'workspace');
  await mkdir(cwd);
  const stores=[];
  t.after(async()=>{for(const store of stores)await store.close();await rm(root,{recursive:true,force:true});});
  return {root,cwd,async store(){const store=await new TaskStateStore({dataDir:path.join(root,'data')}).init();stores.push(store);return store;}};
}
const receipt=value=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
const call=(action,callId='provider-call-1',extra={})=>({name:'relay_workspace',callId,arguments:{action,...extra}});
async function repoRunner(f,runtime){
  const runner=new ShadowdancerDirectory({cwd:f.cwd,conversationId:'family-one',runId:'run-one',model:'mock-boundary',runtime});
  await runner.open();runner.repoRoot=f.cwd;return runner;
}

test('Directory read-only phases deny commands and mutations before repository dispatcher',async t=>{
  const f=await fixture(t),denials=[],reads=[],originals=[];let passive=0;
  const runtime={async runAgent(options){
    if(options.responseOnly){passive++;assert.equal(options.onToolCall,undefined);assert.equal(options.dynamicTools,undefined);assert.equal(options.sandbox,'read-only');return {output:'{"summary":"observed","refs":[]}'};}
    assert.equal(typeof options.onToolCall,'function');
    for(const action of ['run','write','patch','undo_patch']){
      const input=call(action,'phase-'+action,{command:'must-not-run',path:'source.txt',text:'must-not-write'});
      originals.push(structuredClone(input));
      denials.push(await options.onToolCall(input));
      assert.deepEqual(input,originals.at(-1),'provider correlation object must remain unchanged');
    }
    reads.push(await options.onToolCall(call('read','phase-read',{path:'source.txt'})));
    return {output:'{"atomic":true,"summary":"observed"}'};
  }};
  const runner=await repoRunner(f,runtime);let dispatched=0;
  runner.repoToolHandler=async input=>{dispatched++;assert.equal(input.arguments.action,'read');return receipt({observed:true});};
  for(const phase of ['decompose','context-page','page-extract'])
    await runner.infer(phase,'review/'+phase,{instructions:'Read only.'});
  assert.equal(dispatched,1);assert.equal(passive,2);
  assert.equal(denials.length,4);
  assert.ok(denials.every(x=>x.success===false&&x.code==='DIRECTORY_PHASE_READ_ONLY'));
  assert.ok(reads.every(x=>x.success===true));
});

test('Fresh Directory provider sessions namespace repeated call IDs, while same-turn retries remain idempotent',async t=>{
  const f=await fixture(t),store=await f.store(),seen=[],results=[];
  const guard=createOperationalEffectGuard({store,cwd:f.cwd,taskId:'family-one',runId:'run-one',nodeId:'agent'});
  const raw=createWorkspaceToolHandler({cwd:f.cwd,runId:'run-one',nodeId:'agent'});
  let dispatches=0;
  const counted=async(input,context)=>{dispatches++;return raw(input,context);};
  counted.describeOperation=raw.describeOperation.bind(raw);
  counted.normalizeOperationResult=raw.normalizeOperationResult.bind(raw);
  const guarded=guard.wrap(counted);
  let session=0;
  const runtime={async runAgent(options){
    const n=++session,input=call('write','reused-provider-id',{path:'source-'+n+'.txt',text:'value-'+n});
    const original=structuredClone(input);
    results.push(await options.onToolCall(input));
    results.push(await options.onToolCall(input));
    await assert.rejects(options.onToolCall({...input,arguments:{...input.arguments,text:'changed'}}),{code:'OPERATIONAL_CALL_ID_REUSED'});
    assert.deepEqual(input,original,'host namespace must not mutate provider-owned correlation');
    return {output:'{"finding":"written"}'};
  }};
  const runner=await repoRunner(f,runtime);
  runner.repoToolHandler=(input,context)=>{seen.push(input.callId);return guarded(input,context);};
  await runner.infer('work','modules/1',{instructions:'First authorized write.'});
  await runner.infer('work','modules/2',{instructions:'Second authorized write.'});
  assert.ok(results.every(x=>x.success===true));
  assert.equal(dispatches,2,'same-turn duplicates must not re-dispatch');
  assert.equal(await readFile(path.join(f.cwd,'source-1.txt'),'utf8'),'value-1');
  assert.equal(await readFile(path.join(f.cwd,'source-2.txt'),'utf8'),'value-2');
  assert.equal(seen[0],seen[1]);assert.equal(seen[3],seen[4]);assert.notEqual(seen[0],seen[3]);
  const records=await guard.records();
  assert.equal(records.length,2);
  assert.equal(new Set(records.map(x=>x.operationId)).size,2);
  assert.ok(records.every(x=>x.state==='confirmed'));
});

test('Directory synthesis has no repository dispatcher even for a writable repository',async t=>{
  const f=await fixture(t);
  const runner=await repoRunner(f,{async runAgent(options){
    assert.equal(options.onToolCall,undefined);
    assert.ok(!options.dynamicTools?.length);
    assert.equal(options.sandbox,'read-only');
    return {output:'{"answer":"bounded synthesis","used_refs":[]}'};}});
  runner.repoToolHandler=()=>{throw Error('Synthesis must not dispatch tools');};
  await runner.infer('integration','integration/one',{instructions:'Synthesize recorded evidence only.'});
});

test('Directory persistence refuses a pre-existing linked context root before provider work or outside writes',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside');
  await mkdir(outside);await writeFile(path.join(outside,'sentinel.txt'),'keep');
  try{await symlink(outside,path.join(f.cwd,'.shadowdancer'),process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip('This host cannot create the disposable link fixture.');return;}throw error;}
  let turns=0;
  await assert.rejects(runShadowdancerDirectory({cwd:f.cwd,conversationId:'family-one',runId:'run-one',model:'mock',
    runtime:{async runAgent(){turns++;return {output:'{"atomic":true}'};}},input:'/directory Inspect this bounded request.'}),
    error=>/symbolic|junction|saved location|unsafe.*path|path.*unsafe/i.test(error.message));
  assert.equal(turns,0);
  assert.deepEqual(await readdir(outside),['sentinel.txt']);
  assert.equal(await readFile(path.join(outside,'sentinel.txt'),'utf8'),'keep');
});

async function preparedUsageRun(t,usageForPhase){
  const f=await fixture(t),events=[],phases=[];
  const runtime={async runAgent(options){
    const tail=options.prompt.split('CURRENT_DIRECTORY:\n').at(-1);
    const phase=JSON.parse(tail.split('\nREPOSITORY ')[0]);phases.push(phase.label);
    const usage=usageForPhase(phase,options);
    const value=phase.label==='decompose'?{atomic:true}:phase.label==='integration'?{answer:'Usage fixture final.',used_refs:phase.payload.required_refs}:{finding:'A bounded finding.',candidate_answer:'A bounded answer.',uncertainty:''};
    return {output:JSON.stringify(value),...(usage?{usage}:{})};
  }};
  const result=await runPreparedDirectoryAgent({runtime,
    options:{cwd:f.cwd,sandbox:'read-only',prompt:'Check a bounded claim.',dynamicTools:[],developerInstructions:'Preserve the normal harness.',onEvent:event=>events.push(structuredClone(event))},
    input:'/directory Check a bounded claim.',conversationId:'usage-family',runId:'usage-run',model:'mock-usage',
    agentInstructions:'Maintain the current goal.',getAcceptedDirections:()=>({currentUserRequest:{text:'Check a bounded claim.'},priorUserRequests:[],acceptedDirections:[]})});
  assert.deepEqual(phases,['decompose','work','integration']);
  assert.deepEqual(events.filter(x=>x.type==='usage').at(-1)?.usage,result.usage);
  return result.usage;
}

test('Prepared Directory aggregates latest per-phase nested usage without duplicate receipts or fabricated zero counts',async t=>{
  const first=tokenUsageMeasurement({inputTokens:10,outputTokens:2,totalTokens:12});
  const second=tokenUsageMeasurement({inputTokens:3,outputTokens:1,totalTokens:4});
  const cumulative=aggregateTokenUsage([first,second]);
  const final=tokenUsageMeasurement({inputTokens:4,outputTokens:1,totalTokens:5});
  const usage=await preparedUsageRun(t,(phase,options)=>{
    if(phase.label==='decompose'){
      options.onEvent({type:'usage',usage:{...first,total:first,last:first,modelContextWindow:32000}});
      const snapshot={...cumulative,total:cumulative,last:second,modelContextWindow:32000};
      options.onEvent({type:'usage',usage:snapshot});
      return snapshot; // Same final receipt must replace, not add a third sample.
    }
    if(phase.label==='work'){
      const unknown=tokenUsageMeasurement({});
      options.onEvent({type:'usage',usage:{...unknown,total:unknown,last:unknown,modelContextWindow:null}});
      return {...unknown,total:unknown,last:unknown,modelContextWindow:null};
    }
    return {total:final,last:final,modelContextWindow:64000}; // Nested-only legacy envelope.
  });
  assert.equal(usage.samples,4);
  assert.equal(usage.inputTokens,17);assert.equal(usage.outputTokens,4);assert.equal(usage.totalTokens,21);
  for(const field of ['inputTokens','outputTokens','totalTokens'])assert.equal(usage.availability[field],'partial');
  for(const field of ['cachedInputTokens','reasoningOutputTokens']){
    assert.equal(usage[field],null);assert.equal(usage.availability[field],'unavailable');
  }
  assert.deepEqual(usage.total,aggregateTokenUsage([cumulative,tokenUsageMeasurement({}),final]));
  assert.deepEqual(usage.last,final);
  assert.equal(usage.modelContextWindow,null,'separate fresh contexts have no shared context window');
});

test('Prepared Directory keeps absent usage for completed phases unknown rather than reporting zero',async t=>{
  const usage=await preparedUsageRun(t,()=>undefined);
  assert.equal(usage.samples,3);
  for(const field of TOKEN_USAGE_FIELDS){assert.equal(usage[field],null);assert.equal(usage.availability[field],'unavailable');}
  assert.deepEqual(usage.total,aggregateTokenUsage([tokenUsageMeasurement({}),tokenUsageMeasurement({}),tokenUsageMeasurement({})]));
});

test('Directory rebuild refuses linked source families before reading another family evidence',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside-family');
  await mkdir(path.join(outside,'runs','source-run','integration'),{recursive:true});
  await writeFile(path.join(outside,'runs','source-run','integration','final.json'),'{"answer":"private"}');
  await mkdir(path.join(f.cwd,'.shadowdancer'),{recursive:true});
  try{await symlink(outside,path.join(f.cwd,'.shadowdancer','family-one'),process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip('This host cannot create the disposable link fixture.');return;}throw error;}
  await assert.rejects(planShadowdancerRebuild({cwd:f.cwd,conversationId:'family-one',sourceRunId:'source-run'}),
    error=>/symbolic|junction|saved location|unsafe.*path|path.*unsafe/i.test(error.message));
});
