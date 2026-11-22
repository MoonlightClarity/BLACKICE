import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {HarnessEngine} from '../lib/engine.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {BENCHMARK_AGENT_TOOLS_PROFILE,benchmarkHash} from '../lib/benchmark-profile.mjs';
import {benchmarkFixture,fixtureWorkflow,validSource,toolJSON,readHashes} from './helpers/minicpm-benchmark-fixture.mjs';

const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const workspace=(id,args)=>tool(id,'relay_workspace',args);
const directory=(id,args)=>tool(id,'relay_directory_action',args);
const code=(id,args)=>tool(id,'relay_code',{language:'javascript',path:'src/index.cjs',...args});
const receipt=result=>{
 const found=result?.contentItems?.map(item=>item.text||'').join('\n').match(/DIRECTORY HOST RECEIPT (receipt-\d+)/);
 assert.ok(found,'The observation must cite a real delivered Directory host receipt.');
 return found[1];
};
class NoExternalModel extends EventEmitter {
 status(){return{connected:false,authenticated:false,models:[]};}
 async close(){}
 async runAgent(){throw Error('External/native model execution is forbidden in this fixture.');}
}

// The server supplies deterministic answers; real adapters still validate and execute tools.
async function setup(t,{profile=BENCHMARK_AGENT_TOOLS_PROFILE,steps,ownerMethod=false,ordinary=false,noOutline=false}={}){
 const cleanup=[],f=benchmarkFixture({after:fn=>cleanup.push(fn)});
 const requests=[],executed=new Map(),delivered=new Map(),openings=[],denied=[],deadlineSnapshots=[],reviews=[];
 const immutableBefore=readHashes(f),canaryBefore=fs.readFileSync(f.canary);
 const names=profile===BENCHMARK_AGENT_TOOLS_PROFILE
  ?['relay_directory_action','relay_workspace','relay_code','relay_skills']
  :['relay_directory_action','relay_workspace'];
 let engine,runtime,catalog,stage=0,protocolError=null,runId,method,skillFileBefore;
 // The next HTTP request carries the result; its accepted-delivery callback follows the response.
 const get=id=>{assert.ok(executed.has(id),'Missing actual executed result: '+id);return executed.get(id);};
 const value=id=>toolJSON(get(id));
 const script=steps({f,get,value});
 const server=http.createServer(async(req,res)=>{
  try{
   res.setHeader('Content-Type','application/json');
   if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
   let raw='';for await(const chunk of req)raw+=chunk;
   const body=JSON.parse(raw),allText=JSON.stringify(body.messages);
   const preparation=allText.includes('This is one bounded planning phase');
   const summary=allText.includes('Create a concise continuity checkpoint');
   const row={kind:preparation?'planning':summary?'summary':'main',body};requests.push(row);
   if(runId)deadlineSnapshots.push({kind:row.kind,value:structuredClone(engine.getRun(runId).benchmarkDeadline)});
   const respond=message=>res.end(JSON.stringify({choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message}],
    usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}}));
   if(preparation){
    assert.equal(profile,BENCHMARK_AGENT_TOOLS_PROFILE);assert.ok(!body.tools?.length);
    if(noOutline){respond({role:'assistant',content:'Synthetic preparation returned no structured outline.'});return;}
    respond({role:'assistant',content:JSON.stringify({artifact:{status:'proposed',focus:'implement',reason:'Verify the requested saved code with the fixed public check.',
     actions:[{id:'implement',objective:'Save the implementation under src, read back the saved bytes, and pass both fixed public cases.',dependsOn:[]}]}})});return;
   }
   if(summary){
    assert.ok(!body.tools?.length);
    respond({role:'assistant',content:'The admitted task is to implement directorySmoke in src/index.cjs and verify both fixed public cases. Keep the task scope and tests unchanged. Use the current Directory ledger and current source files for authoritative state; do not replay a prior write or check merely because history was summarized.'});return;
   }
   if(ordinary)for(const required of ['relay_directory_action','relay_workspace','relay_code'])assert.ok(body.tools.some(item=>item.function.name===required));
   else assert.deepEqual(body.tools.map(item=>item.function.name),names);
   assert.ok(stage<script.length,'Unexpected extra main-provider request at step '+stage);
   const next=script[stage++]();
   respond(typeof next==='string'?{role:'assistant',content:next}:{role:'assistant',content:null,tool_calls:[next]});
  }catch(error){
   protocolError||=error;res.statusCode=400;res.end(JSON.stringify({error:{message:error.message}}));
  }
 });
 t.after(async()=>{
  await engine?.close();await runtime?.close();await catalog?.close();
  server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));
  for(const finish of cleanup)await finish();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 runtime=new ProviderRuntime({codex:new NoExternalModel(),dataDir:path.join(f.root,'provider'),
  modelLimitResolver:{enrich:async(_config,models)=>models}});
 await runtime.store.init();
 await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',
  maxSteps:null,models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096,supportsTools:true}]},{preserveDefault:true});
 // Synthetic provider capabilities remain its own defaults throughout Planning and tools.
 const providerBudget=()=>{
  const p=runtime.listProviders().find(item=>item.id==='fixture');
  return {context:p.context,maxTokens:p.maxTokens,models:p.models.map(({id,contextWindowTokens,maxOutputTokens})=>({id,contextWindowTokens,maxOutputTokens}))};
 };
 const budgetBefore=structuredClone(providerBudget());
 const executeTool=runtime.executeTool.bind(runtime);
 runtime.executeTool=async(state,call)=>{
  assert.ok(!executed.has(call.id),'One dispatch per synthetic call');
  const result=await executeTool(state,call);executed.set(call.id,structuredClone(result));return result;
 };
 const runAgent=runtime.runAgent.bind(runtime);
 runtime.runAgent=async options=>{
  openings.push({responseOnly:options.responseOnly===true,prompt:options.prompt,tools:structuredClone(options.dynamicTools),
   hostOnlyTools:options.hostOnlyTools,context:structuredClone(options.context)});
  if(!ordinary&&options.responseOnly!==true&&profile===BENCHMARK_AGENT_TOOLS_PROFILE){
   for(const call of [
    {name:'relay_skills',arguments:{action:'save',id:'library-modular-development',content:'forged'},callId:'route-skill-mutation'},
    {name:'relay_workspace',namespace:'external',arguments:{action:'write',path:f.canary,text:'forged'},callId:'route-external-workspace'},
    {name:'relay_control',arguments:{action:'run',command:'forged'},callId:'route-control'},
   ]){
    const result=await options.onToolCall(call);
    assert.equal(result.success,false);assert.equal(result.actionDispatched,false);
    denied.push({call,result:structuredClone(result)});
   }
  }
  return runAgent({...options,onToolResultDelivered:event=>{
   delivered.set(event.call.callId,structuredClone(event.result));return options.onToolResultDelivered?.(event);
  },...(options.onBeforeFinal?{onBeforeFinal:async candidate=>{
   const result=await options.onBeforeFinal(candidate);
   const snapshot=(await engine.actionDirectories.get(runId,'Fixture')).read();
   reviews.push({threadId:candidate.threadId,output:candidate.output,result:structuredClone(result),
    focus:snapshot.focus,actions:snapshot.actions.map(({id,state})=>({id,state}))});
   return result;
  }}:{})});
 };
 engine=await new HarnessEngine({runtime,dataDir:path.join(f.root,'engine'),defaultCwd:f.workspace}).init();
 if(ownerMethod){
  catalog=createSkillsCatalog({dataDir:engine.dataDir});
  const initial=await catalog.detail({id:'library-modular-development'});
  method=await catalog.save({id:initial.id,value:{expectedRevision:initial.revision,
   content:'# Modular Development\nOWNER_MODULAR_DEVELOPMENT_FIXTURE\nKeep the public contract fixed. Save, read back, check, and repair the current source.\n'}});
  skillFileBefore=fs.readFileSync(path.join(engine.dataDir,'skill-edits','skills.json'));
 }
 const workflow=structuredClone(fixtureWorkflow);
 workflow.id='code-block-composed-'+randomUUID();
 workflow.settings={...workflow.settings,planningMode:'off'};
 const agent=workflow.nodes.find(item=>item.type==='agent');agent.model='fixture::fixture';
 const started=engine.startRun({workflow,requestId:'code-block-'+randomUUID(),input:{
  task:ordinary?'Implement JavaScript in src/index.cjs and verify syntax only. Use Modular Development and record exactly that limited check.':'Implement directorySmoke in src/index.cjs. Read METHOD.md and TASK.md, use Modular Development, save the source, and pass node test-public.cjs.',
  cwd:f.workspace,planningMode:'off',directoryMode:'off',directoryActions:'on',chatPlanning:profile===BENCHMARK_AGENT_TOOLS_PROFILE?'on':'off',
  pastChats:'off',directoryDiagnostics:'maximal',...(ordinary?{}:{benchmark:{...f.request,profile},benchmarkBudget:{wallMs:30000}}),
 }});
 runId=started.id;
 const admittedDeadline=structuredClone(engine.getRun(runId).benchmarkDeadline);
 await engine.executions.get(runId);
 assert.equal(protocolError,null,protocolError?.stack);
 const run=engine.getRun(runId);
 assert.equal(run.status,'completed',run.error);assert.equal(run.settled,true);
 if(!ordinary)assert.equal(run.nodes.agent.benchmarkEvidenceMode,'compatible-provider-trace');
 assert.deepEqual(providerBudget(),budgetBefore,'The harness must not mutate provider context or token settings');
 assert.equal(stage,script.length);
 assert.equal(delivered.size,executed.size,'Every executed call must reach accepted provider delivery');
 for(const [id,raw] of executed){
  const accepted=delivered.get(id);assert.ok(accepted,'Missing accepted provider result: '+id);
  // Compatible wire delivery carries content, while success remains host outcome metadata.
  const deliveredText=accepted.contentItems.filter(item=>item.type==='inputText').map(item=>item.text).join('\n');
  const wires=requests.filter(row=>row.kind==='main').flatMap(row=>row.body.messages)
   .filter(message=>message.role==='tool'&&message.tool_call_id===id);
  assert.ok(wires.length,'Actual HTTP request lacks tool result '+id);
  for(const item of raw.contentItems.filter(item=>item.type==='inputText')){
   assert.ok(deliveredText.includes(item.text),'Accepted delivery changed host result '+id);
   assert.ok(wires.some(message=>typeof message.content==='string'&&message.content.includes(item.text)),
    'Actual HTTP request changed host result '+id);
  }
 }
 for(const row of requests.filter(item=>item.kind==='main')){
  const calls=new Set();
  for(const message of row.body.messages){
   for(const call of message.tool_calls||[])calls.add(call.id);
   if(message.role==='tool')assert.ok(calls.has(message.tool_call_id),'An HTTP tool result must retain its preceding assistant call');
  }
 }
 assert.deepEqual(readHashes(f),immutableBefore);
 assert.deepEqual(fs.readFileSync(f.canary),canaryBefore);
 assert.deepEqual(run.benchmarkDeadline,admittedDeadline);
 if(!ordinary)assert.equal(Date.parse(admittedDeadline.deadlineAt)-Date.parse(run.createdAt),30000);
 for(const row of deadlineSnapshots)assert.deepEqual(row.value,admittedDeadline,'Planning or execution must not restart the admitted wall clock');
 if(skillFileBefore)assert.deepEqual(fs.readFileSync(path.join(engine.dataDir,'skill-edits','skills.json')),skillFileBefore);
 const ledger=(await engine.actionDirectories.get(runId,'Fixture')).read();
 return{f,run,runtime,engine,requests,executed,delivered,openings,denied,deadlineSnapshots,reviews,ledger,method,get,value,names};
}

test('v2 Planning and effective skills compose with exact code save, honest checks, guarded repair and Directory receipts',{timeout:40000},async t=>{
 const unicode='caf\u00e9 e\u0301 \u03bb \u{1f680} \u{1f469}\u200d\u{1f4bb}';
 const wrong='// '+unicode+'\nmodule.exports = { directorySmoke: value => "wrong:" + value };\n';
 const correct='// '+unicode+'\nmodule.exports = { directorySmoke: value => "ok:" + value };\n';
 const f=await setup(t,{ownerMethod:true,steps:({f,get,value})=>[
  ()=>workspace('method',{action:'read',path:'METHOD.md'}),
  ()=>workspace('task',{action:'read',path:'TASK.md'}),
  ()=>workspace('initial',{action:'read',path:'src/index.cjs'}),
  ()=>directory('directory-state',{action:'read'}),
  ()=>directory('focus',{action:'focus',id:'implement'}),
  ()=>tool('skill-search','relay_skills',{action:'search',query:'modular development'}),
  ()=>tool('skill-read','relay_skills',{action:'read',id:'library-modular-development'}),
  ()=>tool('skill-mutation','relay_skills',{action:'save',id:'library-modular-development',content:'forged'}),
  ()=>code('fixture-write',{action:'save',path:'test-public.cjs',code:wrong,expectedHash:value('initial').sha256}),
  ()=>code('outside-write',{action:'save',path:'../outside.cjs',code:wrong,expectedHash:value('initial').sha256}),
  ()=>code('absolute-write',{action:'save',path:f.canary,code:wrong,expectedHash:value('initial').sha256}),
  ()=>code('save-wrong',{action:'save',code:wrong,expectedHash:value('initial').sha256}),
  ()=>workspace('read-wrong',{action:'read',path:'src/index.cjs'}),
  ()=>code('syntax-unavailable',{action:'check',check:'syntax',expectedHash:value('read-wrong').sha256}),
  ()=>code('public-failed',{action:'check',check:'public',expectedHash:value('read-wrong').sha256}),
  ()=>code('stale-repair',{action:'save',code:correct,expectedHash:'0'.repeat(64)}),
  ()=>{
   assert.deepEqual(fs.readFileSync(path.join(f.workspace,'src','index.cjs')),Buffer.from(wrong));
   return workspace('read-after-stale',{action:'read',path:'src/index.cjs'});
  },
  ()=>code('save-correct',{action:'save',code:correct,expectedHash:value('read-after-stale').sha256}),
  ()=>workspace('read-correct',{action:'read',path:'src/index.cjs'}),
  ()=>code('public-passed',{action:'check',check:'public',expectedHash:value('read-correct').sha256}),
  ()=>directory('observe',{action:'observe',id:'implement',outcome:'objective-met',
   claim:'Saved source was read back and the final fixed public check passed both cases.',
   receipts:[receipt(get('read-correct')),receipt(get('public-passed'))]}),
  ()=>'Saved src/index.cjs. Both fixed public cases passed on the final source.',
 ]});
 assert.equal(f.run.chatPlanning,'on');assert.equal(f.run.directoryActions,'on');
 assert.equal(f.run.planningMode,'off');assert.equal(f.run.executionModes.directoryMode,'off');
 assert.deepEqual(f.run.nodes.agent.toolNames,f.names);
 const prep=f.requests.filter(row=>row.kind==='planning');assert.equal(prep.length,1);
 assert.ok(!prep[0].body.tools?.length);
 assert.deepEqual(f.run.planningModuleReceipts.map(row=>[row.moduleId,row.phase]),[['builtin-decomposition','started'],['builtin-decomposition','completed']]);
 const main=f.requests.filter(row=>row.kind==='main');
 assert.ok(main[0].body.messages.some(message=>typeof message.content==='string'&&message.content.includes(f.method.content)));
 const submitted=f.run.skillLoadReceipts.filter(row=>row.type==='skill_context_submitted'&&row.skillId===f.method.id);
 assert.equal(submitted.length,1);assert.equal(submitted[0].source,'user');assert.equal(submitted[0].sourceRevision,f.method.revision);
 assert.ok(f.run.skillLoadReceipts.some(row=>row.type==='skill_loaded'&&row.skillId===f.method.id));
 assert.equal(f.value('skill-read').entry.content,f.method.content);
 assert.ok(f.value('skill-search').entries.some(row=>row.id===f.method.id));
 const skillTool=f.openings.find(row=>!row.responseOnly).tools.find(row=>row.name==='relay_skills');
 assert.deepEqual(skillTool.inputSchema.properties.action.enum,['search','read']);
 for(const id of ['skill-mutation','fixture-write','outside-write','absolute-write','stale-repair'])assert.equal(f.get(id).success,false,id+' must be rejected');
 assert.equal(f.denied.length,3);
 for(const [id,source] of [['save-wrong',wrong],['save-correct',correct]]){
  const value=f.value(id);assert.equal(f.get(id).success,true);
  assert.equal(value.saved,true);assert.equal(value.sourceSha256,benchmarkHash(source));
  assert.equal(value.sourceBytes,Buffer.byteLength(source));assert.equal(value.readback.verified,true);
  assert.equal(value.readback.sha256,benchmarkHash(source));assert.equal(value.checks.performed,false);
 }
 for(const [id,source]of [['read-wrong',wrong],['read-after-stale',wrong],['read-correct',correct]]){
  assert.equal(f.value(id).sha256,benchmarkHash(source));assert.ok(f.value(id).content.includes(unicode));
 }
 assert.deepEqual(fs.readFileSync(path.join(f.f.workspace,'src','index.cjs')),Buffer.from(correct));
 const syntax=f.value('syntax-unavailable');assert.equal(f.get('syntax-unavailable').success,false);
 assert.equal(syntax.check.performed,false);assert.equal(syntax.check.passed,false);assert.equal(syntax.exitCode,undefined);
 for(const [id,passed,exit] of [['public-failed',false,2],['public-passed',true,0]]){
  const value=f.value(id);assert.equal(f.get(id).success,passed);assert.equal(value.exitCode,exit);
  assert.equal(value.check.kind,'public');assert.equal(value.check.performed,true);assert.equal(value.check.passed,passed);
  assert.equal(value.source.unchanged,true);
  const report=JSON.parse(value.stdout);assert.equal(report.caseCount,2);assert.equal(report.executedCases,2);
  assert.equal(report.passedCases,passed?2:0);assert.equal(report.semanticPass,passed);
 }
 assert.equal(f.ledger.actions.length,1);assert.equal(f.ledger.actions[0].authority,'planning');
 assert.equal(f.ledger.actions[0].state,'observed');assert.equal(f.ledger.focus,null);
 assert.ok(f.ledger.receipts.some(row=>row.success===false));
 assert.ok(f.ledger.receipts.every(row=>row.state==='returned'));
 for(const opening of f.openings){
  const c=opening.context??{};
  assert.equal(c.preset??'model','model');assert.equal(c.windowTokens??null,null);
  for(const key of ['outputReserveTokens','headroomTokens','compactAtTokens','keepRecentTokens'])assert.equal(c[key],undefined);
 }
 const thread=await f.runtime.readThread(f.run.nodes.agent.threadId);
 assert.equal(thread.contextOptions.preset,'model');assert.equal(thread.contextOptions.windowTokens,null);
 assert.equal(thread.contextStatus.effectiveWindowTokens,65536);
 assert.ok(f.deadlineSnapshots.some(row=>row.kind==='planning'));
 assert.ok(f.deadlineSnapshots.some(row=>row.kind==='main'));
});

test('v1 retains its exact two-tool catalog and Planning-off execution',{timeout:40000},async t=>{
 const f=await setup(t,{profile:'minicpm-code-v1',steps:({get})=>[
  ()=>workspace('v1-method',{action:'read',path:'METHOD.md'}),
  ()=>workspace('v1-source',{action:'read',path:'src/index.cjs'}),
  ()=>directory('v1-plan',{action:'plan',actions:[{id:'implement',objective:'Verify the fixed source against both public cases.',dependsOn:[]}]}),
  ()=>directory('v1-focus',{action:'focus',id:'implement'}),
  ()=>workspace('v1-public',{action:'run',command:'node test-public.cjs',timeoutMs:10000}),
  ()=>directory('v1-observe',{action:'observe',id:'implement',outcome:'objective-met',
   claim:'The saved fixture source passed both fixed public cases.',receipts:[receipt(get('v1-public'))]}),
  ()=>'The saved source passed both fixed public cases.',
 ]});
 assert.equal(f.run.chatPlanning,'off');assert.equal(f.requests.filter(row=>row.kind==='planning').length,0);
 assert.deepEqual(f.run.nodes.agent.toolNames,['relay_directory_action','relay_workspace']);
 for(const row of f.requests.filter(item=>item.kind==='main'))assert.deepEqual(row.body.tools.map(tool=>tool.function.name),['relay_directory_action','relay_workspace']);
 assert.equal(f.run.benchmark.profile,'minicpm-code-v1');
 assert.equal(f.get('v1-public').success,true);
 assert.equal(JSON.parse(f.value('v1-public').stdout).passedCases,2);
 assert.deepEqual(fs.readFileSync(path.join(f.f.workspace,'src','index.cjs')),Buffer.from(validSource));
});


// This exercises the native adapter boundary with a fake backend, not cloud inference.
async function nativeFixture(t,profile,{deliveryEvidence=false}={}){
 const cleanup=[],f=benchmarkFixture({after:fn=>cleanup.push(fn)}),immutable=readHashes(f);
 const canary=fs.readFileSync(f.canary),calls=[],delegations=[],preflights=[],verified=new Set(),events=[];
 const unicodeSource=deliveryEvidence?'// caf\u00e9 e\u0301 \u{1f680} '+ 'x'.repeat(13000)+'\n'+validSource:validSource;
 const capabilities={model:'native-fixture',contextWindowTokens:131072,maxOutputTokens:16384};
 let engine,runtime;
 const key=({model,cwd}={})=>typeof model==='string'&&typeof cwd==='string'?model+'\0'+path.resolve(cwd):null;
 class NativeFixture extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'native-fixture',models:[structuredClone(capabilities)]};}
  supportsHostOnlyToolDispatch(scope){return verified.has(key(scope));}
  async ensureHostOnlyToolDispatch(scope){
   assert.equal(scope.model,'native-fixture');assert.equal(path.resolve(scope.cwd),path.resolve(f.workspace));
   preflights.push({model:scope.model,cwd:scope.cwd});verified.add(key(scope));return true;
  }
  async close(){}
  async runAgent(options){
   delegations.push(options);
   assert.equal(profile,BENCHMARK_AGENT_TOOLS_PROFILE,'v1 trace must be rejected before native delegation');
   assert.equal(Object.hasOwn(options,'benchmarkTrace'),false);
   assert.equal(options.model,'native-fixture');
   options.onPromptAccepted?.(options.prompt);
   if(options.responseOnly){
    assert.equal(options.dynamicTools?.length??0,0);
    return {threadId:'native-preparation-fixture',output:JSON.stringify({artifact:{
     status:'proposed',focus:'verify',reason:'Verify the existing implementation through the fixed public check.',
     actions:[{id:'verify',objective:'Read the source and verify both fixed public cases.',dependsOn:[]}],
    }})};
   }
   assert.equal(options.hostOnlyTools,true);
   assert.equal(this.supportsHostOnlyToolDispatch({model:options.model,cwd:options.cwd}),true);
   assert.deepEqual(options.dynamicTools.map(item=>item.name),['relay_directory_action','relay_workspace','relay_code','relay_skills']);
   const context=options.context??{};
   assert.equal(context.preset??'model','model');assert.equal(context.windowTokens??null,null);
   for(const field of ['outputReserveTokens','headroomTokens','compactAtTokens','keepRecentTokens'])assert.equal(context[field],undefined);
   for(const field of ['maxTokens','maxOutputTokens','max_output_tokens','max_completion_tokens'])assert.equal(options[field],undefined);
   const denied=await options.onToolCall({name:'relay_control',callId:'native-denied',arguments:{action:'run',command:'forged'}},{signal:options.signal});
   assert.equal(denied.success,false);assert.equal(denied.actionDispatched,false);
   const invoke=async(name,id,args)=>{
    const call={name,callId:id,arguments:args};
    const result=await options.onToolCall(call,{signal:options.signal});
    assert.equal(result.success,true,id+': '+JSON.stringify(result.contentItems));
    calls.push({call,result:structuredClone(result)});
    assert.ok(!events.some(event=>event.data?.type==='tool.result.delivered'&&event.data.callId===id),'No witness before actual local delivery');
    options.onToolResultDelivered?.({call,result:structuredClone(result)});
    return result;
   };
   await invoke('relay_workspace','native-method',{action:'read',path:'METHOD.md'});
   await invoke('relay_workspace','native-task',{action:'read',path:'TASK.md'});
   const source=await invoke('relay_workspace','native-source',{action:'read',path:'src/index.cjs'});
   await invoke('relay_directory_action','native-directory',{action:'read'});
   await invoke('relay_directory_action','native-focus',{action:'focus',id:'verify'});
   await invoke('relay_skills','native-skill',{action:'read',id:'library-modular-development'});
   let checkedHash=toolJSON(source).sha256;
   if(deliveryEvidence){
    const saved=await invoke('relay_code','native-unicode-save',{action:'save',language:'javascript',path:'src/index.cjs',code:unicodeSource,expectedHash:checkedHash});
    checkedHash=toolJSON(saved).sourceSha256;
    await invoke('relay_workspace','native-unicode-read',{action:'read',path:'src/index.cjs'});
   }
   const check=await invoke('relay_code','native-public',{action:'check',language:'javascript',path:'src/index.cjs',
    check:'public',expectedHash:checkedHash});
   const result=toolJSON(check);
   assert.equal(result.check.performed,true);assert.equal(result.check.passed,true);assert.equal(result.exitCode,0);
   assert.equal(JSON.parse(result.stdout).passedCases,2);
   if(deliveryEvidence){
    const missingCall={name:'relay_workspace',callId:'native-undelivered',arguments:{action:'read',path:'METHOD.md'}};
    const missing=await options.onToolCall(missingCall,{signal:options.signal});
    assert.equal(missing.success,true);
    calls.push({call:missingCall,result:structuredClone(missing),undelivered:true});
    for(const call of [
     {name:'relay_skills',callId:'native-failed-delivery',arguments:{action:'save',id:'library-modular-development',content:'forbidden'}},
     {name:'relay_password_fixture',callId:'native-sensitive-delivery',arguments:{action:'read'}},
    ]){
     const failure=await options.onToolCall(call,{signal:options.signal});
     assert.equal(failure.success,false);
     calls.push({call,result:structuredClone(failure)});
     options.onToolResultDelivered?.({call,result:structuredClone(failure)});
    }
    // Exercise the real bounded retention contract, not model progress or extra checks.
    for(let i=0;i<27;i++)await invoke('relay_workspace','native-retention-'+i,{action:'read',path:'METHOD.md'});
   }
   await invoke('relay_directory_action','native-observe',{action:'observe',id:'verify',outcome:'objective-met',
    claim:'The current source was read and passed both fixed public cases.',receipts:[receipt(source),receipt(check)]});
   const output='The saved source passed both fixed public cases.';
   assert.ok(!await options.onBeforeFinal?.({output,signal:options.signal}),'A completed Directory must admit the final answer');
   return {threadId:'native-execution-fixture',output};
  }
 }
 const native=new NativeFixture(),budgetBefore=structuredClone(native.status().models);
 t.after(async()=>{await engine?.close();await runtime?.close();for(const finish of cleanup)await finish();});
 runtime=await new ProviderRuntime({codex:native,dataDir:path.join(f.root,'native-provider'),
  fetchImpl:async()=>{throw Error('No HTTP request is permitted in this native fixture.');},
  modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
 engine=await new HarnessEngine({runtime,dataDir:path.join(f.root,'native-engine'),defaultCwd:f.workspace}).init();
 engine.on('event',event=>events.push(structuredClone(event)));
 const workflow=structuredClone(fixtureWorkflow);workflow.id='native-code-block-'+randomUUID();
 workflow.nodes.find(item=>item.type==='agent').model='native-fixture';
 const started=engine.startRun({workflow,requestId:'native-code-block-'+randomUUID(),input:{
  task:'Use Modular Development to review directorySmoke in src/index.cjs. Read METHOD.md, TASK.md and the source, then verify node test-public.cjs.',
  cwd:f.workspace,planningMode:'off',directoryMode:'off',directoryActions:'on',
  chatPlanning:profile===BENCHMARK_AGENT_TOOLS_PROFILE?'on':'off',pastChats:'off',directoryDiagnostics:'maximal',
  benchmark:{...f.request,profile},benchmarkBudget:{wallMs:30000},
 }});
 const deadline=structuredClone(engine.getRun(started.id).benchmarkDeadline);
 await engine.executions.get(started.id);
 const run=engine.getRun(started.id);
 assert.equal(run.settled,true);
 assert.deepEqual(run.benchmarkDeadline,deadline);
 assert.deepEqual(native.status().models,budgetBefore,'Native model capabilities must remain unchanged');
 assert.deepEqual(readHashes(f),immutable);assert.deepEqual(fs.readFileSync(f.canary),canary);
 assert.deepEqual(fs.readFileSync(path.join(f.workspace,'src','index.cjs')),Buffer.from(unicodeSource));
 assert.equal(fs.existsSync(path.join(f.root,'provider-traces')),false,'Native receipts must not masquerade as compatible transport traces');
 return{f,run,engine,delegations,preflights,calls,events};
}

test('v2 native Codex delegates through real ProviderRuntime with native defaults and scoped receipt evidence',{timeout:40000},async t=>{
 const f=await nativeFixture(t,BENCHMARK_AGENT_TOOLS_PROFILE);
 assert.equal(f.run.status,'completed',f.run.error);
 assert.equal(f.run.nodes.agent.benchmarkEvidenceMode,'native-codex-receipts');
 assert.equal(f.preflights.length,1,'Fresh model/workspace scope needs one host-only preflight');
 assert.equal(f.delegations.filter(options=>options.responseOnly).length,1);
 assert.equal(f.delegations.filter(options=>!options.responseOnly).length,1);
 assert.ok(f.run.skillLoadReceipts.some(row=>row.type==='skill_context_submitted'&&row.skillId==='library-modular-development'));
 assert.ok(f.run.skillLoadReceipts.some(row=>row.type==='skill_loaded'&&row.skillId==='library-modular-development'));
 const ledger=(await f.engine.actionDirectories.get(f.run.id,'Fixture')).read();
 assert.equal(ledger.actions[0].authority,'planning');assert.equal(ledger.actions[0].state,'observed');
 assert.equal(ledger.focus,null);assert.ok(ledger.receipts.every(row=>row.state==='returned'));
 assert.deepEqual(new Set(f.calls.map(row=>row.call.name)),new Set(['relay_workspace','relay_directory_action','relay_skills','relay_code']));
});

test('v1 native Codex still rejects compatible benchmark tracing before backend execution',{timeout:40000},async t=>{
 const f=await nativeFixture(t,'minicpm-code-v1');
 assert.equal(f.run.status,'failed');
 assert.match(f.run.error,/Native providers do not support benchmark transport tracing/);
 assert.equal(f.run.nodes.agent.benchmarkEvidenceMode,'compatible-provider-trace');
 assert.equal(f.delegations.length,0);assert.equal(f.calls.length,0);
});


test('real compatible public verification repairs the second final after a no-actions correction without host completion',{timeout:40000},async t=>{
 const saved='// verified-source progression\n'+validSource;
 const f=await setup(t,{noOutline:true,steps:({get,value})=>[
  ()=>workspace('repair-initial',{action:'read',path:'src/index.cjs'}),
  ()=>'The implementation remains to be saved and checked.',
  ()=>directory('repair-plan',{action:'plan',actions:[{id:'implement',objective:'Save the implementation and verify the fixed public cases.',dependsOn:[]}]}),
  ()=>directory('repair-focus',{action:'focus',id:'implement'}),
  ()=>code('repair-save',{action:'save',code:saved,expectedHash:value('repair-initial').sha256}),
  ()=>code('repair-check',{action:'check',check:'public',expectedHash:value('repair-save').sourceSha256}),
  ()=>'The source was saved and the public check passed.',
  ()=>directory('repair-observe',{action:'observe',id:'implement',outcome:'objective-met',
   claim:'The saved source passed both fixed public cases; this observation is limited to that public contract.',
   receipts:[receipt(get('repair-check'))]}),
  ()=>'Saved the source and verified both fixed public cases.',
 ]});
 assert.equal(f.reviews.length,3);
 assert.match(f.reviews[0].result.prompt,/Directory has no actions/);
 assert.match(f.reviews[1].result.prompt,/source-bound public test check returned successfully/);
 assert.match(f.reviews[1].result.prompt,/not hidden-test success or full-objective completion/);
 assert.match(f.reviews[1].result.prompt,/Do not repeat the save or check merely to create a new receipt/);
 assert.equal(f.reviews[1].focus,'implement');assert.deepEqual(f.reviews[1].actions,[{id:'implement',state:'active'}]);
 assert.ok(!f.reviews[2].result);
 assert.equal(f.ledger.actions[0].state,'observed');
 assert.equal(f.openings.filter(row=>!row.responseOnly).length,1,'The correction stays in the existing provider execution');
 const ids=f.reviews.map(row=>row.threadId).filter(Boolean);
 assert.equal(new Set(ids).size,1);assert.equal(ids[0],f.run.nodes.agent.threadId);
 assert.equal(f.run.events.filter(event=>event.data?.phase==='continue-after-source-check').length,1);
 assert.ok(!f.run.events.some(event=>event.data?.type==='tool.result.delivered'),'Compatible delivery does not emit a native witness');
});

test('ordinary coding syntax verification receives scoped reconciliation through real tools and provider',{timeout:40000},async t=>{
 const saved='throw new Error("SYNTAX_ONLY_NOT_EXECUTED");\nmodule.exports = { value: 1 };\n';
 const f=await setup(t,{ordinary:true,noOutline:true,steps:({get,value})=>[
  ()=>'The JavaScript still needs to be saved and checked.',
  ()=>directory('syntax-plan',{action:'plan',actions:[{id:'implement',objective:'Save the JavaScript and check syntax only.',dependsOn:[]}]}),
  ()=>directory('syntax-focus',{action:'focus',id:'implement'}),
  ()=>code('syntax-save',{action:'save',code:saved}),
  ()=>code('syntax-check',{action:'check',check:'syntax',expectedHash:value('syntax-save').sourceSha256}),
  ()=>'The file was saved and its syntax check passed.',
  ()=>directory('syntax-observe',{action:'observe',id:'implement',outcome:'objective-met',
   claim:'The file was saved and Node syntax checking succeeded. Runtime behavior and semantic correctness were not checked.',
   receipts:[receipt(get('syntax-check'))]}),
  ()=>'Saved the JavaScript and verified syntax only.',
 ]});
 assert.ok(!f.run.benchmark);
 assert.equal(f.value('syntax-check').check.passed,true);
 assert.equal(f.value('syntax-check').exitCode,0);
 assert.equal(f.value('syntax-check').source.unchanged,true);
 assert.equal(f.value('syntax-check').check.receipt.sourceAtomic,false);
 assert.equal(f.reviews.length,3);
 assert.match(f.reviews[1].result.prompt,/source-bound syntax\/JSON parsing check returned successfully/);
 assert.match(f.reviews[1].result.prompt,/syntax\/parsing only, not semantic correctness or task completion/);
 assert.deepEqual(f.reviews[1].actions,[{id:'implement',state:'active'}]);
 assert.equal(f.ledger.actions[0].state,'observed');
 assert.equal(f.openings.filter(row=>!row.responseOnly).length,1);
 assert.deepEqual(fs.readFileSync(path.join(f.f.workspace,'src/index.cjs')),Buffer.from(saved));
 assert.ok(!f.run.events.some(event=>event.data?.type==='tool.result.delivered'));
});

test('native post-write witnesses retain exact text identity after bounded continuity eviction',{timeout:40000},async t=>{
 const f=await nativeFixture(t,BENCHMARK_AGENT_TOOLS_PROFILE,{deliveryEvidence:true});
 assert.equal(f.run.status,'completed',f.run.error);
 const proofs=f.events.filter(event=>event.data?.type==='tool.result.delivered');
 assert.ok(proofs.length>24);
 const allowed=['type','schema','runId','taskId','nodeId','callId','tool','resultTextSha256','sourceChars',
  'delivery','textProjection','sensitiveContentOmitted','binaryItemsOmitted'].sort();
 for(const event of proofs){
  assert.deepEqual(Object.keys(event.data).sort(),allowed);
  const value=event.data;
  assert.equal(value.schema,'blackice.native-tool-delivery.v1');
  assert.equal(event.runId,f.run.id);assert.equal(value.runId,f.run.id);
  assert.equal(value.taskId,f.run.taskId||f.run.id);assert.equal(value.nodeId,'agent');
  assert.equal(value.delivery,'local-stream-write-not-provider-consumption');
  assert.equal(value.textProjection,'inputText-joined-with-newline');
  const row=f.calls.find(row=>row.call.callId===value.callId);assert.ok(row);
  assert.equal(value.tool,row.call.name);
  if(value.sensitiveContentOmitted){
   assert.equal(value.resultTextSha256,null);assert.equal(value.sourceChars,null);
  }else{
   const text=row.result.contentItems.filter(item=>item?.type==='inputText'&&typeof item.text==='string').map(item=>item.text).join('\n');
   assert.equal(value.resultTextSha256,createHash('sha256').update(text).digest('hex'));
   assert.equal(value.sourceChars,text.length);
  }
  assert.equal(value.binaryItemsOmitted,0);
 }
 const unicode=proofs.find(event=>event.data.callId==='native-unicode-read');
 assert.ok(unicode.data.sourceChars>12000,'Hash must cover text beyond the retained excerpt');
 const raw=f.calls.find(row=>row.call.callId==='native-unicode-read').result.contentItems.map(item=>item.text).join('\n');
 assert.ok(Buffer.byteLength(raw)>raw.length,'Fixture must distinguish UTF-8 bytes from JS sourceChars');
 assert.ok(!proofs.some(event=>event.data.callId==='native-undelivered'));
 assert.ok(proofs.some(event=>event.data.callId==='native-failed-delivery'),'Failed tool outcomes can still be locally delivered');
 assert.ok(proofs.some(event=>event.data.callId==='native-sensitive-delivery'&&event.data.sensitiveContentOmitted===true));
 assert.ok(!f.run.toolContinuity.records.some(row=>row.callId==='native-public'),'The original public delivery was evicted');
 const publicProof=proofs.find(event=>event.data.callId==='native-public');assert.ok(publicProof);
 const returned=f.events.findIndex(event=>event.data?.type==='directory.effect'&&event.data.phase==='returned'&&event.data.callId==='native-public');
 const written=f.events.indexOf(publicProof);
 assert.ok(returned>=0&&written>returned,'Proof follows the actual protected Directory return');
 assert.equal(f.run.toolContinuity.records.length,24);
});
