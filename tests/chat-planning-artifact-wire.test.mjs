import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CodexRuntime} from '../lib/codex.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {PLANNING_RESPONSE_DISABLED_FEATURES} from '../lib/response-profile.mjs';
import {compatibleWireOutputSchema} from '../lib/provider-output-schema.mjs';
import {chatPlanningArtifactSchema,createChatPlanningProviderInvoker} from '../lib/chat-planning-provider.mjs';
import {CHAT_PLANNING_MODULES} from '../lib/chat-planning-pass.mjs';

const [module]=CHAT_PLANNING_MODULES;
const scope={taskId:'wire-task',runId:'wire-run',nodeId:'wire-node'};
const snapshot={taskId:scope.taskId,revision:0,actions:[],receipts:[]};
const proposed={status:'proposed',reason:'Inspect the supplied source',sourceRefs:[],focus:'inspect',
  actions:[{id:'inspect',objective:'Inspect the current source',dependsOn:[]}]};
const needsEvidence={status:'needs-evidence',reason:'Need a current observation',sourceRefs:[],focus:null,actions:[]};

// Independent JSON Schema instance checks for this fixture's finite wire vocabulary.
// Unknown keywords fail the test rather than silently claiming grammar coverage.
const vocabulary=new Set(['type','properties','required','additionalProperties','items','anyOf','const','enum',
  'minLength','maxLength','pattern','minItems','maxItems']);
function accepts(schema,value) {
  for(const key of Object.keys(schema))assert.ok(vocabulary.has(key),'Unreviewed wire keyword: '+key);
  const object=value!==null&&typeof value==='object'&&!Array.isArray(value);
  if(schema.type!==undefined) {
    const type=Array.isArray(value)?'array':value===null?'null':typeof value;
    if(schema.type!==type)return false;
  }
  if(Object.hasOwn(schema,'const')&&value!==schema.const)return false;
  if(schema.enum&&!schema.enum.includes(value))return false;
  if(schema.anyOf&&!schema.anyOf.some(branch=>accepts(branch,value)))return false;
  if(typeof value==='string'&&(schema.minLength!==undefined&&value.length<schema.minLength
    ||schema.maxLength!==undefined&&value.length>schema.maxLength
    ||schema.pattern!==undefined&&!new RegExp(schema.pattern).test(value)))return false;
  if(Array.isArray(value)) {
    if(schema.minItems!==undefined&&value.length<schema.minItems||schema.maxItems!==undefined&&value.length>schema.maxItems)return false;
    if(schema.items&&!value.every(item=>accepts(schema.items,item)))return false;
  }
  if(object) {
    if(schema.required?.some(key=>!Object.hasOwn(value,key)))return false;
    if(schema.additionalProperties===false&&Object.keys(value).some(key=>!Object.hasOwn(schema.properties||{},key)))return false;
    if(Object.entries(value).some(([key,item])=>schema.properties?.[key]&&!accepts(schema.properties[key],item)))return false;
  }
  return true;
}
function assertPlanningWire(wire) {
  assert.ok(wire);assert.equal(wire.type,'object');assert.equal(wire.anyOf,undefined);
  assert.deepEqual(wire.required,['artifact']);assert.equal(wire.properties.artifact.anyOf.length,2);
  assert.equal(accepts(wire,{artifact:proposed}),true);
  assert.equal(accepts(wire,{artifact:needsEvidence}),true);
  assert.equal(accepts(wire,{artifact:{...proposed,actions:[]}}),false,'A proposed empty plan is not in the wire language');
  const {actions,...missingActions}=proposed;
  assert.equal(accepts(wire,{artifact:missingActions}),false,'Proposed actions are required');
  assert.equal(accepts(wire,{artifact:{...proposed,focus:null}}),false);
  assert.equal(accepts(wire,{artifact:{...needsEvidence,actions:proposed.actions}}),false);
  assert.equal(accepts(wire,{artifact:{...needsEvidence,focus:'inspect'}}),false);
  assert.equal(accepts(wire,proposed),false,'Flat host artifacts are not wire envelopes');
  assert.equal(accepts(wire,{artifact:proposed,extra:true}),false);
}
test('projected planning grammar excludes the observed empty-plan failure while retaining both legitimate branches',()=>{
  const full=chatPlanningArtifactSchema(module,snapshot),before=structuredClone(full);
  assertPlanningWire(compatibleWireOutputSchema(full));
  assert.deepEqual(full,before);
});
test('projected choice grammars preserve legal pending IDs and avoid impossible proposed alternatives',()=>{
  for(const count of [0,1,2]) {
    const current={...snapshot,actions:Array.from({length:count},(_,i)=>({id:'p'+i,state:'pending'}))};
    for(const selected of CHAT_PLANNING_MODULES.filter(item=>['grounded-choice','revised-choice'].includes(item.artifact))) {
      const wire=compatibleWireOutputSchema(chatPlanningArtifactSchema(selected,current));
      const extra=selected.artifact==='revised-choice'?{alternatives:[]}:{};
      assert.equal(accepts(wire,{artifact:{status:'needs-evidence',reason:'Need an observation',sourceRefs:[],focus:null,...extra}}),true);
      const candidate={status:'proposed',reason:'Use the pending step',sourceRefs:[],focus:'p0',
        ...(selected.artifact==='revised-choice'?{alternatives:['p0','p1']}:{})};
      assert.equal(accepts(wire,{artifact:candidate}),selected.artifact==='revised-choice'?count>=2:count>=1);
      assert.equal(accepts(wire,{artifact:{...candidate,focus:'foreign'}}),false);
    }
  }
});
function nativeFixture(t,dir,artifact) {
  const requests=[],client=new CodexRuntime({command:process.execPath,cwd:dir,runTimeoutMs:2000,getConnectedGmail:()=>false,
    spawnImpl(){throw Error('Wire fixtures cannot start a native process.');}});
  client.child={};Object.assign(client.info,{connected:true,authenticated:true,defaultModel:'native-exact',models:[{
    id:'native-exact',model:'native-exact',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]});
  client._request=async(method,params={})=>{
    requests.push({method,params:structuredClone(params)});
    if(method==='config/read')return {config:{skills:{config:[]},plugins:{},mcp_servers:{},apps:{}}};
    if(method==='skills/list')return {data:[{cwd:dir,skills:[],errors:[]}]};
    if(method==='experimentalFeature/list')return {data:PLANNING_RESPONSE_DISABLED_FEATURES.map(name=>({
      name,stage:'stable',enabled:!params.threadId,defaultEnabled:true})),nextCursor:null};
    if(method==='thread/start')return {thread:{id:'wire-native-thread',ephemeral:params.ephemeral===true},model:params.model,
      sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:params.approvalPolicy};
    if(method==='turn/start') {
      setImmediate(()=>client._notification('turn/completed',{threadId:params.threadId,turn:{id:'wire-native-turn',
        status:'completed',items:[{type:'agentMessage',id:'wire-answer',phase:'final_answer',text:JSON.stringify({artifact})}]}}));
      return {turn:{id:'wire-native-turn',status:'inProgress'}};
    }
    if(['thread/unsubscribe','turn/interrupt'].includes(method))return {};
    throw Error('Unexpected native fixture request: '+method);
  };
  t.after(()=>{client.closing=true;client._connectionFailed(Object.assign(new Error('Fixture closed'),{code:'CODEX_CLOSED'}),client.child);});
  return {client,requests};
}
class Native extends EventEmitter {
  status(){return {connected:true,authenticated:true,defaultModel:'native',models:[{model:'native'}]};}
  async close(){}
  async runAgent(){throw Error('Compatible wire fixtures cannot start native inference.');}
}
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
for(const artifact of [proposed,needsEvidence]) {
  test('native planning '+artifact.status+' carries the complete branch schema and decodes the envelope',async t=>{
    const dir=await mkdtemp(path.join(tmpdir(),'planning-native-wire-'));t.after(()=>rm(dir,{recursive:true,force:true}));
    const f=nativeFixture(t,dir,artifact),invoke=createChatPlanningProviderInvoker({runtime:f.client,model:'native-exact',
      cwd:dir,dataDir:dir,effort:'medium',...scope,assertAdmission:()=>{}});
    const result=await invoke({module,...scope,snapshot});
    assert.deepEqual(result.output,artifact);
    const turn=f.requests.find(item=>item.method==='turn/start').params;
    assertPlanningWire(turn.outputSchema);
    assert.deepEqual(turn.outputSchema,compatibleWireOutputSchema(chatPlanningArtifactSchema(module,snapshot)));
    assert.equal(turn.model,'native-exact');assert.deepEqual(turn.sandboxPolicy,{type:'readOnly',networkAccess:false});
    assert.equal(f.requests.filter(item=>item.method==='turn/start').length,1);
  });
  test('compatible planning '+artifact.status+' carries the same branches in response_format without retry',async t=>{
    const dir=await mkdtemp(path.join(tmpdir(),'planning-compatible-wire-')),requests=[];
    const fetchImpl=async(url,options)=>{
      const body=options.body?JSON.parse(options.body):null;requests.push({url,method:options.method,body});
      if(options.method==='GET')return response({data:[{id:'exact-model',supported_parameters:['structured_outputs','response_format']}]});
      assert.equal(options.method,'POST');
      return response({id:'fixture-response',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({artifact})}}],
        usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
    };
    const runtime=await new ProviderRuntime({codex:new Native(),dataDir:dir,fetchImpl,
      modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
    t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
    await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'https://synthetic-api.example/v1',
      models:[{id:'exact-model',contextWindowTokens:65536,maxOutputTokens:8192}]},{preserveDefault:true});
    const invoke=createChatPlanningProviderInvoker({runtime,model:'fixture::exact-model',cwd:dir,dataDir:dir,...scope,assertAdmission:()=>{}});
    const result=await invoke({module,...scope,snapshot});
    assert.deepEqual(result.output,artifact);assert.equal(result.providerDiagnostics.structuredOutput,'provider-json-schema');
    assert.deepEqual(requests.map(item=>item.method),['GET','POST']);
    const body=requests[1].body,wire=body.response_format.json_schema.schema;
    assertPlanningWire(wire);assert.deepEqual(wire,compatibleWireOutputSchema(chatPlanningArtifactSchema(module,snapshot)));
    assert.equal(body.response_format.type,'json_schema');assert.equal(body.response_format.json_schema.strict,true);
    assert.equal(body.model,'exact-model');assert.ok(!body.tools?.length);
  });
}
