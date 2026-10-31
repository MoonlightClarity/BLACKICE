import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CodexRuntime} from '../lib/codex.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {PLANNING_RESPONSE_DISABLED_FEATURES,planningResponseFeatureConfig,verifyPlanningResponseBoundary,normalizeOutputSchema} from '../lib/response-profile.mjs';

const schema={type:'object',additionalProperties:false,properties:{answer:{type:'string'}},required:['answer']};
const answer='{"answer":"Actual public synthetic result"}';
const features=()=>PLANNING_RESPONSE_DISABLED_FEATURES.map(name=>({name,stage:'stable',enabled:true,defaultEnabled:true}));
function nativeFixture(t,{ignoredFeature,missingFeature,sandbox,approvalPolicy,featureReadFails=false,connectedGmail=true}={}){
  const cwd=process.cwd(),requests=[],events=[];
  const client=new CodexRuntime({command:process.execPath,cwd,runTimeoutMs:2000,getConnectedGmail:()=>connectedGmail,
    spawnImpl(){throw Error('Synthetic boundary tests cannot start a native process.');}});
  client.child={};Object.assign(client.info,{connected:true,authenticated:true,defaultModel:'native-exact',models:[{
    id:'native-exact',model:'native-exact',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}]});
  let opened,nextThread=0;
  client._request=async(method,params={})=>{
    requests.push({method,params:structuredClone(params)});
    if(method==='config/read')return {config:{skills:{config:[]},plugins:{ambient:{enabled:true}},mcp_servers:{ambient:{command:'never-executed'}},apps:{mail:{enabled:true}}}};
    if(method==='skills/list')return {data:[{cwd,skills:[{path:path.join(cwd,'ambient-skill.md')}],errors:[]}]};
    if(method==='experimentalFeature/list'){
      if(featureReadFails)throw Object.assign(new Error('Method unavailable'),{code:-32601});
      return {data:features().filter(x=>x.name!==missingFeature).map(x=>({...x,enabled:params.threadId?x.name===ignoredFeature:true})),nextCursor:null};
    }
    if(method==='thread/start'){
      opened=params;return {thread:{id:'synthetic-thread-'+(++nextThread),ephemeral:params.ephemeral===true},model:params.model,
        sandbox:sandbox||{type:params.sandbox==='read-only'?'readOnly':'dangerFullAccess',networkAccess:false},approvalPolicy:approvalPolicy||params.approvalPolicy};
    }
    if(method==='turn/start'){
      const id='synthetic-turn-'+nextThread;
      setImmediate(()=>client._notification('turn/completed',{threadId:params.threadId,turn:{id,status:'completed',items:[{type:'agentMessage',id:'public-item',phase:'final_answer',text:answer}]}}));
      return {turn:{id,status:'inProgress'}};
    }
    if(['thread/unsubscribe','turn/interrupt'].includes(method))return {};
    throw Error('Unexpected native fixture request: '+method);
  };
  t.after(()=>{client.closing=true;client._connectionFailed(Object.assign(new Error('Fixture closed'),{code:'CODEX_CLOSED'}),client.child);});
  return {client,requests,events,cwd,run:overrides=>client.runAgent({cwd,prompt:'Return one public structured response.',model:'native-exact',effort:'high',serviceTier:'default',responseOnly:true,outputSchema:schema,dynamicTools:[],onEvent:event=>events.push(event),...overrides}),opened:()=>opened};
}

test('native analytical worker verifies actual disabled features and sandbox before its schema-bound turn',async t=>{
  const f=nativeFixture(t);const result=await f.run();assert.equal(result.output,answer);
  const opening=f.requests.find(x=>x.method==='thread/start').params,turn=f.requests.find(x=>x.method==='turn/start').params;
  assert.equal(opening.model,'native-exact');assert.equal(opening.allowProviderModelFallback,false);assert.equal(opening.sandbox,'read-only');assert.equal(opening.ephemeral,true);
  assert.deepEqual(opening.environments,[]);assert.deepEqual(opening.selectedCapabilityRoots,[]);assert.equal(opening.dynamicTools,undefined);
  for(const name of PLANNING_RESPONSE_DISABLED_FEATURES)assert.equal(opening.config['features.'+name],false);
  assert.equal(opening.config.web_search,'disabled');assert.equal(opening.config.plugins.ambient.enabled,false);assert.equal(opening.config.mcp_servers.ambient.enabled,false);
  assert.equal(opening.config['skills.config'].at(-1).enabled,false);assert.equal(f.requests.some(x=>x.method==='app/installed'||x.method==='app/read'),false);
  assert.deepEqual(turn.outputSchema,schema);assert.equal(turn.model,'native-exact');assert.equal(turn.effort,'high');assert.deepEqual(turn.sandboxPolicy,{type:'readOnly',networkAccess:false});
  assert.ok(f.requests.findIndex(x=>x.method==='experimentalFeature/list'&&x.params.threadId)<f.requests.findIndex(x=>x.method==='turn/start'));
  const capabilities=f.events.find(x=>x.type==='capabilities');assert.equal(capabilities.profile,'planning-response');assert.equal(capabilities.ambientGmail,false);assert.match(capabilities.limitation,/not a universal zero-tool/);
});

test('ignored browser restriction fails before inference and releases the opened synthetic thread',async t=>{
  const f=nativeFixture(t,{ignoredFeature:'browser_use_external'}),known={state:'accepted',lastSuccessAt:'2026-01-01T00:00:00.000Z'};
  f.client.modelAccess.set('native-exact',known);await assert.rejects(f.run(),{code:'PLANNING_RESPONSE_PROFILE_UNSUPPORTED'});
  assert.equal(f.requests.some(x=>x.method==='turn/start'),false);assert.equal(f.requests.filter(x=>x.method==='thread/unsubscribe').length,1);assert.equal(f.client.threads.size,0);
  assert.deepEqual(f.client.modelAccess.get('native-exact'),known,'a local restriction failure is not failed model inference');
});

test('missing essential native controls fail explicitly without changing the selected model',async t=>{
  const f=nativeFixture(t,{missingFeature:'shell_tool'});await assert.rejects(f.run(),{code:'PLANNING_RESPONSE_PROFILE_UNSUPPORTED'});
  assert.equal(f.requests.some(x=>x.method==='thread/start'||x.method==='turn/start'),false);assert.equal(f.client.info.defaultModel,'native-exact');
});

test('a native server without feature introspection returns an explicit capability limit without inference',async t=>{
  const f=nativeFixture(t,{featureReadFails:true});await assert.rejects(f.run(),{code:'PLANNING_RESPONSE_PROFILE_UNSUPPORTED'});
  assert.equal(f.requests.some(x=>x.method==='thread/start'||x.method==='turn/start'),false);
});

for(const [label,options]of [['writable sandbox',{sandbox:{type:'workspaceWrite',networkAccess:false}}],['network-enabled sandbox',{sandbox:{type:'readOnly',networkAccess:true}}],['approval escalation',{approvalPolicy:'on-request'}]])
  test('native '+label+' is rejected before a module turn',async t=>{const f=nativeFixture(t,options);await assert.rejects(f.run(),{code:'PLANNING_RESPONSE_PROFILE_UNSUPPORTED'});assert.equal(f.requests.some(x=>x.method==='turn/start'),false);});

test('analytical options reject resumed history, attached action tools and writable escalation before native startup',async t=>{
  const f=nativeFixture(t);
  for(const overrides of [{threadId:'old-thread'},{continuity:{text:'old history'}},{dynamicTools:[{name:'relay_browser'}]},{sandbox:'danger-full-access'},{onBeforeFinal:()=>({continue:true,prompt:'retry'})}])
    await assert.rejects(f.run(overrides),{code:'INVALID_RESPONSE_PROFILE'});
  assert.equal(f.requests.length,0);
});

test('ordinary native execution retains its existing writable default and makes no new feature-scope calls',async t=>{
  const f=nativeFixture(t,{connectedGmail:false});const result=await f.run({responseOnly:false,outputSchema:undefined});assert.equal(result.output,answer);
  assert.equal(f.requests.find(x=>x.method==='thread/start').params.sandbox,'danger-full-access');assert.equal(f.requests.some(x=>x.method==='experimentalFeature/list'),false);
  assert.equal(f.requests.find(x=>x.method==='turn/start').params.outputSchema,undefined);
});

class FakeCodex extends EventEmitter{
  status(){return {connected:true,authenticated:true,defaultModel:'native',models:[{model:'native'}]};}
  async close(){}
  async runAgent(){throw Error('API fixture must preserve its selected API model.');}
}
async function apiFixture(t,{toolCall=false,type='openai'}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'planning-profile-api-')),requests=[];
  const runtime=await new ProviderRuntime({codex:new FakeCodex(),dataDir:directory,fetchImpl:async(url,options)=>{
    if(options.method==='GET'){requests.push({url:String(url),body:null});return new Response(JSON.stringify({data:[{id:'exact-model'}]}),{status:200,headers:{'content-type':'application/json'}});}
    const body=JSON.parse(options.body);requests.push({url:String(url),body});
    const output=toolCall?[{id:'call',type:'function_call',name:'relay_browser',call_id:'call-1',arguments:'{}'}]:[{id:'message',type:'message',role:'assistant',content:[{type:'output_text',text:answer}]}];
    return new Response(JSON.stringify(type==='openai'?{id:'synthetic-response',status:'completed',output,usage:{input_tokens:2,output_tokens:3}}:{choices:[{message:{role:'assistant',content:answer,...(toolCall?{tool_calls:[{id:'call-1',type:'function',function:{name:'relay_browser',arguments:'{}'}}]}:{})},finish_reason:toolCall?'tool_calls':'stop'}],usage:{prompt_tokens:2,completion_tokens:3}}),{status:200,headers:{'content-type':'application/json'}});
  }}).init();
  await runtime.saveProvider({id:'fixture',type,baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic-provider-key',models:['exact-model']});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  return {runtime,requests,options:{cwd:directory,prompt:'Return the synthetic public answer.',model:'fixture::exact-model',effort:'default',responseOnly:true,outputSchema:schema,dynamicTools:[]}};
}

test('Responses API receives the exact structured schema and no operational tools',async t=>{
  const f=await apiFixture(t);const result=await f.runtime.runAgent(f.options);assert.equal(result.output,answer);assert.equal(f.requests.filter(request => request.body).length,1);
  const body=f.requests.find(request => request.body).body;assert.equal(body.model,'exact-model');assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');assert.deepEqual(body.text.format.schema,schema);assert.equal(body.text.format.strict,true);
});

test('invented API tool calls are rejected before callbacks, without a fallback or another provider step',async t=>{
  const f=await apiFixture(t,{toolCall:true});let calls=0;
  await assert.rejects(f.runtime.runAgent({...f.options,onToolCall:()=>{calls++;}}),{code:'PLANNING_RESPONSE_ONLY_VIOLATION'});
  assert.equal(calls,0);assert.equal(f.requests.filter(request => request.body).length,1);
});

test('compatible API without advertised schema support exposes its fallback and still attaches no action tools',async t=>{
  const f=await apiFixture(t,{type:'compatible'}),events=[];assert.equal((await f.runtime.runAgent({...f.options,onEvent:e=>events.push(e)})).output,answer);
  const body=f.requests.find(request=>request.body)?.body,capability=events.find(e=>e.type==='capabilities');
  assert.equal(body.tools,undefined);assert.equal(body.response_format,undefined);assert.equal(capability.structuredOutput,'prompt-and-host-validation');assert.equal(capability.structuredOutputReason,'structured_output_support_unknown');
});

test('schema validation rejects remote refs and non-JSON values while preserving valid self-contained schemas',()=>{
  assert.deepEqual(normalizeOutputSchema(schema),schema);
  assert.throws(()=>normalizeOutputSchema({type:'object',properties:{answer:{$ref:'https://example.com/schema'}}}),{code:'INVALID_OUTPUT_SCHEMA'});
  assert.throws(()=>normalizeOutputSchema({type:'object',properties:{answer:()=>{}}}),{code:'INVALID_OUTPUT_SCHEMA'});
  assert.throws(()=>planningResponseFeatureConfig([]),{code:'PLANNING_RESPONSE_PROFILE_UNSUPPORTED'});
  assert.throws(()=>verifyPlanningResponseBoundary({sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never'},[],['shell_tool']),{code:'PLANNING_RESPONSE_PROFILE_UNSUPPORTED'});
});
