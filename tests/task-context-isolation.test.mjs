import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {HarnessEngine} from '../lib/engine.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';

const SHARED='CI1_SHARED_OWNER_POLICY_73619';
const A={user:'CI1_A_USER_41957',assistant:'CI1_A_ASSISTANT_78531',tool:'CI1_A_TOOL_ONLY_26384'};
const B={user:'CI1_B_USER_57246',assistant:'CI1_B_ASSISTANT_83165',tool:'CI1_B_TOOL_ONLY_94827'};
const FOLLOW={user:'CI1_A_FOLLOW_USER_68432',assistant:'CI1_A_FOLLOW_ASSISTANT_19753'};
const tokens=object=>Object.values(object);
const receipt=result=>{
 const id=result.contentItems.map(item=>item.text||'').join('\n').match(/DIRECTORY HOST RECEIPT (receipt-\d+)/)?.[1];
 assert.ok(id,'The Directory observation needs a real returned host receipt');return id;
};
const flow=model=>({id:'ci1-shared-profile',name:'Task context isolation',nodes:[
 {id:'input',type:'input'},{id:'agent',type:'agent',name:'Verifier',model,prompt:'Inspect the evidence requested in this task and report verified facts.'},
 {id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],
 settings:{maxParallel:1,planningMode:'off'}});

async function fixture(t,transport){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'blackice-task-isolation-'));
 const profile=path.join(root,'profile'),workspace=path.join(root,'workspace');
 fs.mkdirSync(profile);fs.mkdirSync(workspace);
 const marker=randomUUID(),markerPath=path.join(profile,'profile-marker.txt');
 fs.writeFileSync(markerPath,marker,{flag:'wx'});
 for(const [name,content]of [
  ['prior-task.txt','Observed detail. '.repeat(170)+A.tool+'\nSupporting detail. '.repeat(140)],
  ['current-task.txt','Current task evidence: '+B.tool+'\n'],
  ['third-task.txt','Third task evidence: CI1_C_TOOL_ONLY_32586\n'],
 ])fs.writeFileSync(path.join(workspace,name),content,{flag:'wx'});
 const requests=[],toolResults=new Map(),runs=[],nativeCalls=[],nativeScopes=new Set();
 let runtime,engine,scenario,stage=0,protocolError=null,nativeCounter=0;
 const profilePaths={engine:path.join(profile,'engine'),provider:path.join(profile,'provider')};
 const projection=options=>({prompt:options.prompt,developerInstructions:options.developerInstructions,
  context:options.context,continuity:options.continuity,threadId:options.threadId,codexHistory:options.codexHistory,
  model:options.model,responseOnly:options.responseOnly===true,dynamicTools:options.dynamicTools});
 const capture=(kind,payload)=>{
  assert.ok(scenario,'A fixture scenario must be selected before a provider request');
  const row={scenario:scenario.id,kind,payload:structuredClone(payload)};requests.push(row);
  const text=JSON.stringify(payload);
  for(const forbidden of scenario.forbidden)assert.ok(!text.includes(forbidden),
   scenario.id+' leaked prior-task canary '+forbidden+' into '+transport+' '+kind);
  assert.ok(text.includes(SHARED),'Shared owner instructions must survive every fresh task and continuation');
  return text;
 };
 const plan=text=>text.includes('Shape: {"status":"proposed","interpretation":')
  ?{status:'proposed',interpretation:'Continue this same task using its retained observations and requested evidence.',reason:'The current user explicitly continues the selected task.'}
  :{status:'proposed',focus:'inspect_'+scenario.id,reason:'Read the evidence requested for this admitted task.',
    actions:[{id:'inspect_'+scenario.id,objective:'Read the requested evidence and record the verified observation.',dependsOn:[]}]};
 const next=()=>{
  const id=scenario.id;
  switch(stage++){
   case 0:return{name:'relay_directory_action',callId:id+'-directory',arguments:{action:'read'}};
   case 1:return{name:'relay_directory_action',callId:id+'-focus',arguments:{action:'focus',id:'inspect_'+id}};
   case 2:return{name:'relay_workspace',callId:id+'-source',arguments:{action:'read',path:scenario.file}};
   case 3:return{name:'relay_directory_action',callId:id+'-observe',arguments:{action:'observe',id:'inspect_'+id,outcome:'objective-met',
    claim:'The requested evidence was read from the current workspace.',receipts:[receipt(toolResults.get(id+'-source'))]}};
   case 4:return scenario.assistant;
   default:throw Error('Unexpected extra execution step for '+id);
  }
 };
 const inspectCatalog=tools=>{
  const history=tools.find(item=>item.name==='relay_history');
  assert.ok(history,'Past Chats Off retains only the explicit previous-turn diagnostic tool');
  assert.deepEqual(history.inputSchema.properties.action.enum,['previous_turn_diagnostics']);
 };
 class NativeFixture extends EventEmitter{
  status(){return{connected:true,authenticated:true,isolatedHistory:true,defaultModel:'native-fixture',
   models:[{id:'native-fixture',model:'native-fixture',contextWindowTokens:262144,maxOutputTokens:16384,supportsTools:true}]};}
  async start(){return this.status();}
  async close(){}
  supportsHostOnlyToolDispatch({model,cwd}={}){return nativeScopes.has(model+'\0'+cwd);}
  async ensureHostOnlyToolDispatch({model,cwd}){
   assert.equal(model,'native-fixture');assert.equal(cwd,workspace);nativeScopes.add(model+'\0'+cwd);return true;
  }
  async runAgent(options){
   assert.equal(transport,'native','The compatible case must not delegate to a native backend');
   const input=projection(options);nativeCalls.push({scenario:scenario.id,...input});
   assert.equal(options.threadId,undefined,'Private native sessions use explicit saved same-task handoff, never another native thread');
   capture(options.responseOnly?'planning':'main',input);
   const threadId='ci1-native-'+(++nativeCounter),turnId='ci1-turn-'+nativeCounter;
   options.onPromptAccepted?.(options.prompt);
   options.onEvent?.({type:'thread',model:options.model,threadId,turnId,codexHistory:options.codexHistory,resumed:false});
   if(options.responseOnly){
    assert.equal(options.dynamicTools?.length??0,0);
    return{output:JSON.stringify({artifact:plan(options.prompt)}),threadId,turnId,codexHistory:options.codexHistory};
   }
   assert.equal(options.hostOnlyTools,true);inspectCatalog(options.dynamicTools);
   const context=options.context??{};
   assert.equal(context.preset??'model','model');assert.equal(context.windowTokens??null,null);
   for(const field of ['outputReserveTokens','headroomTokens','compactAtTokens','keepRecentTokens'])assert.equal(context[field],undefined);
   let item;
   while(typeof(item=next())!=='string'){
    const result=await options.onToolCall(item,{signal:options.signal});
    assert.equal(result.success,true,item.callId+': '+JSON.stringify(result.contentItems));
    toolResults.set(item.callId,structuredClone(result));
    options.onToolResultDelivered?.({call:item,result:structuredClone(result)});
   }
   assert.ok(!await options.onBeforeFinal?.({output:item,signal:options.signal}));
   options.onEvent?.({type:'message',threadId,turnId,text:item,phase:'final_answer'});
   return{output:item,threadId,turnId,codexHistory:options.codexHistory};
  }
 }
 const native=new NativeFixture();
 const server=http.createServer(async(req,res)=>{
  try{
   res.setHeader('Content-Type','application/json');
   if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture',context_length:262144,max_output_tokens:16384}]}));return;}
   assert.equal(transport,'compatible','Native delegation must not send an HTTP model request');
   let raw='';for await(const part of req)raw+=part;
   const body=JSON.parse(raw),text=JSON.stringify(body.messages);
   const preparation=text.includes('This is one bounded planning phase');
   capture(preparation?'planning':'main',body);
   let message;
   if(preparation){assert.equal(body.tools?.length??0,0);message={role:'assistant',content:JSON.stringify({artifact:plan(body.messages.map(message=>typeof message.content==='string'?message.content:'').join('\n'))})};}
   else{
    inspectCatalog(body.tools.map(item=>({name:item.function.name,inputSchema:item.function.parameters})));
    const item=next();
    message=typeof item==='string'?{role:'assistant',content:item}:{role:'assistant',content:null,tool_calls:[
     {id:item.callId,type:'function',function:{name:item.name,arguments:JSON.stringify(item.arguments)}}]};
   }
   res.end(JSON.stringify({choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message}]}));
  }catch(error){protocolError||=error;res.statusCode=400;res.end(JSON.stringify({error:{message:error.message}}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const close=async()=>{await engine?.close();engine=null;await runtime?.close();runtime=null;};
 const open=async()=>{
  assert.equal(fs.readFileSync(markerPath,'utf8'),marker,'The persistent profile must never be reset between tasks');
  runtime=await new ProviderRuntime({codex:native,dataDir:profilePaths.provider,
   modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
  if(transport==='compatible'&&!runtime.store.get('fixture'))await runtime.saveProvider({
   id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',maxSteps:null,
   models:[{id:'fixture',contextWindowTokens:262144,maxOutputTokens:16384,supportsTools:true}],
  },{preserveDefault:true});
  const execute=runtime.executeTool.bind(runtime);
  runtime.executeTool=async(state,call)=>{
   assert.ok(!toolResults.has(call.id),'A fixture tool call must not execute twice');
   const result=await execute(state,call);toolResults.set(call.id,structuredClone(result));return result;
  };
  engine=await new HarnessEngine({runtime,dataDir:profilePaths.engine,defaultCwd:workspace}).init();
 };
 t.after(async()=>{
  const evidence=process.env.BLACKICE_CI1_EVIDENCE_DIR;
  if(evidence){
   assert.ok(path.isAbsolute(evidence)&&fs.statSync(evidence).isDirectory());
   fs.writeFileSync(path.join(evidence,transport+'-requests.json'),JSON.stringify({
    schema:'blackice.task-context-isolation.fixture-evidence.v1',transport,profile,profileMarker:marker,
    requests,nativeCalls,runs,toolResults:[...toolResults].map(([callId,result])=>({callId,result})),
    protocolError:protocolError?{message:protocolError.message,stack:protocolError.stack}:null,
   },null,2)+'\n',{flag:'wx'});
  }
  await close();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));
  fs.rmSync(root,{recursive:true,force:true});
 });
 await open();
 const current=await engine.instructionSettings.read();
 await engine.instructionSettings.update({content:SHARED+': Ground reports in observed evidence and obey the current request.\n',
  expectedRevision:current.revision,expectedHash:current.hash});
 const model=transport==='compatible'?'fixture::fixture':'native-fixture';
 const perform=async(s,previous)=>{
  scenario=s;stage=0;
  const fields={pastChats:'off',directoryActions:'on',chatPlanning:'on',directoryDiagnostics:'maximal'};
  const started=previous?engine.continueRun(previous.id,{nodeId:'agent',message:s.request,...fields}):
   engine.startRun({requestId:'ci1-'+randomUUID(),workflow:flow(model),input:{
    task:s.request,cwd:workspace,planningMode:'off',directoryMode:'off',...fields}});
  await engine.executions.get(started.id);
  const run=engine.getRun(started.id);
  runs.push({scenario:s.id,id:run.id,taskId:run.taskId,parentRunId:run.parentRunId,threadId:run.nodes.agent.threadId,
   pastChats:run.pastChats,directoryActions:run.directoryActions,chatPlanning:run.chatPlanning,status:run.status,error:run.error,
   handoff:run.modelHandoff?{reason:run.modelHandoff.reason,sourceRunId:run.modelHandoff.sourceRunId}:null});
  assert.equal(protocolError,null,protocolError?.stack);
  assert.equal(run.status,'completed',run.error);assert.equal(run.settled,true);assert.equal(stage,5);
  assert.equal(run.pastChats,'off');assert.equal(run.directoryActions,'on');assert.equal(run.chatPlanning,'on');
  assert.ok(run.planningModuleReceipts?.some(row=>row.phase==='completed'));
  assert.ok(!run.planningModuleReceipts.some(row=>row.phase==='failed'),'The synthetic Planning responses must satisfy the real contract');
  const payloads=requests.filter(row=>row.scenario===s.id);
  assert.ok(payloads.some(row=>row.kind==='planning'));assert.ok(payloads.some(row=>row.kind==='main'));
  for(const row of payloads)for(const forbidden of s.forbidden)assert.ok(!JSON.stringify(row.payload).includes(forbidden));
  if(!previous){
   assert.equal(run.taskId,run.id);assert.equal(run.parentRunId,undefined);assert.equal(run.modelHandoff,undefined);
   assert.equal(run.nodes.agent.resumeThreadId,undefined);
  }
  return run;
 };
 return{profile,workspace,marker,markerPath,requests,nativeCalls,runs,toolResults,perform,
  async reopen(knownRuns){await close();await open();for(const run of knownRuns)assert.equal(engine.getRun(run.id).id,run.id);},
  engine:()=>engine};
}

for(const transport of ['compatible','native'])test(transport+': fresh tasks exclude prior-task canaries in one retained profile while same-task continuation preserves them',{timeout:45000},async t=>{
 const h=await fixture(t,transport);
 const a=await h.perform({id:'a',file:'prior-task.txt',request:A.user+': Read prior-task.txt and report verified evidence.',
  assistant:A.assistant,forbidden:[]});
 assert.ok(JSON.stringify(h.toolResults.get('a-source')).includes(A.tool),'The actual task-A tool read must contain the tool-only canary');
 assert.ok(!a.output.includes(A.tool),'Final prose must not supply the tool-only continuity fact');
 const b=await h.perform({id:'b',file:'current-task.txt',request:B.user+': This is a separate fresh task. Read current-task.txt.',
  assistant:B.assistant,forbidden:tokens(A)});
 assert.notEqual(b.taskId,a.taskId);assert.notEqual(b.nodes.agent.threadId,a.nodes.agent.threadId);
 const follow=await h.perform({id:'follow_a',file:'prior-task.txt',request:FOLLOW.user+': Continue this same task using its saved observations and recheck prior-task.txt.',
  assistant:FOLLOW.assistant,forbidden:tokens(B)},a);
 assert.equal(follow.taskId,a.taskId);assert.equal(follow.parentRunId,a.id);
 const firstFollow=h.requests.find(row=>row.scenario==='follow_a'&&row.kind==='main');
 for(const required of tokens(A))assert.ok(JSON.stringify(firstFollow.payload).includes(required),
  'Intentional same-task continuation lost '+required+' before any new file read');
 assert.ok(!JSON.stringify(firstFollow.payload).includes(B.tool));
 if(transport==='native'){
  assert.equal(follow.modelHandoff.reason,'relay-history');
  assert.equal(follow.modelHandoff.sourceRunId,a.id);
  assert.notEqual(follow.nodes.agent.threadId,a.nodes.agent.threadId);
 }else assert.equal(follow.nodes.agent.threadId,a.nodes.agent.threadId,'The compatible positive control retains its own provider session');
 await h.reopen([a,b,follow]);
 const c=await h.perform({id:'c',file:'third-task.txt',request:'CI1_C_USER_62518: Start a third fresh task and read third-task.txt.',
  assistant:'CI1_C_ASSISTANT_38617',forbidden:[...tokens(A),...tokens(B),...tokens(FOLLOW)]});
 for(const prior of [a,b,follow]){
  assert.notEqual(c.taskId,prior.taskId);assert.notEqual(c.nodes.agent.threadId,prior.nodes.agent.threadId);
  assert.equal(h.engine().getRun(prior.id).id,prior.id,'Prior tasks must remain stored in the same profile');
 }
 assert.equal(fs.readFileSync(h.markerPath,'utf8'),h.marker);
 assert.ok(h.requests.filter(row=>row.scenario==='c').every(row=>JSON.stringify(row.payload).includes(SHARED)));
});
