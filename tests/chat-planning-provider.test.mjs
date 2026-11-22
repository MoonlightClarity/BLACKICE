import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { strictProviderSchema, compatibleWireOutputSchema, compatibleOutputSchemaProfile } from '../lib/provider-output-schema.mjs';
import { createChatPlanningProviderInvoker, chatPlanningArtifactSchema } from '../lib/chat-planning-provider.mjs';
import { CHAT_PLANNING_MODULES, createChatPlanningPass } from '../lib/chat-planning-pass.mjs';

const scope={taskId:'t1',runId:'r1',nodeId:'n1'};
const [module]=CHAT_PLANNING_MODULES;
const snapshot={taskId:'t1',revision:3,actions:[],receipts:[]};
const output={status:'proposed',focus:'scan',reason:'Inspect the first failing route',sourceRefs:[],actions:[{id:'scan',objective:'Inspect a route',dependsOn:[]}]};
const make=(runAgent,assertAdmission=()=>{})=>createChatPlanningProviderInvoker({ runtime:{runAgent},...scope,cwd:'test-workspace',model:'api1::model1',effort:'low',assertAdmission });
test('selected model gets one bounded isolated response-only phase with no tools',async()=>{
  let options;
  const invoke=make(value=>{options=value;return {output:JSON.stringify(output)};});
  const response=await invoke({module,...scope,snapshot});
  assert.equal(response.transport,'completed'); assert.deepEqual(response.output,output);
  assert.equal(response.providerDiagnostics.parseOutcome,'parsed');
  assert.equal(response.usage.samples,0); assert.equal(response.usage.totalTokens,null);
  assert.equal(strictProviderSchema(options.outputSchema),true);
  assert.ok(compatibleWireOutputSchema(options.outputSchema));
  assert.equal(options.model,'api1::model1');
  assert.equal(options.effort,'low');
  assert.equal(options.hostOnlyTools,true);
  assert.equal(options.responseOnly,true);
  assert.equal(options.codexHistory,'relay');
  assert.equal(options.sandbox,'read-only');
  assert.deepEqual(options.dynamicTools,[]);
  assert.ok(!('threadId' in options) && !('continuity' in options));
  assert.equal(typeof options.onEvent,'function');
  for(const key of ['max_tokens','max_completion_tokens','maxOutputTokens','contextWindowTokens','context','temperature','topP','minP','outputTokenPolicy'])
    assert.equal(Object.hasOwn(options,key),false,key+' is not overridden');
  await assert.rejects(invoke({module,...scope,snapshot}),{code:'PLANNING_PROVIDER_LIMIT'});
});
test('wrong scope and expired admission never call the provider',async()=>{
  let calls=0;
  const invoke=make(()=>{calls++;},()=>{throw Object.assign(Error('expired'),{code:'GOAL_DEADLINE_REACHED'});});
  await assert.rejects(invoke({module,...scope,runId:'old',snapshot}),{code:'PLANNING_SCOPE_CHANGED'});
  await assert.rejects(invoke({module,...scope,snapshot}),{code:'GOAL_DEADLINE_REACHED'});
  assert.equal(calls,0);
});
test('a tool attempt aborts even if transport catches its error and returns valid JSON',async()=>{
  const invoke=make(options=>{
    assert.throws(()=>options.onToolCall({name:'relay_browser'}),{code:'PLANNING_PROVIDER_TOOL_DENIED'});
    assert.equal(options.signal.aborted,true);
    return {output:JSON.stringify(output)};
  });
  await assert.rejects(invoke({module,...scope,snapshot}),{code:'PLANNING_PROVIDER_TOOL_DENIED'});
});
test('a successful plain-text final records a failed phase, never CAS or execution',async()=>{
  const events=[];
  const invoke=make(()=>({output:'I finished planning.'}));
  const pass=createChatPlanningPass({mode:'on',...scope,read:()=>snapshot,invoke,
    commit:()=>assert.fail('no validated artifact'),assertAdmission:()=>{},emit:event=>events.push(event)});
  assert.equal((await pass.run(module.id)).status,'failed');
  assert.deepEqual(events.map(row=>row.phase),['started','failed']);
});


test('schemas retain every host artifact variant, current receipt scope, and immutable wire projection',()=>{
  const current={...snapshot,actions:[{id:'pending_a',state:'pending'},{id:'pending_b',state:'pending'},{id:'finished',state:'observed'}],
    receipts:[{id:'own',state:'returned'},{id:'foreign',state:'returned',taskId:'other'},{id:'unresolved',state:'unknown'}]};
  const before=structuredClone(current);
  for(const module of CHAT_PLANNING_MODULES) {
    const schema=chatPlanningArtifactSchema(module,current),original=structuredClone(schema);
    assert.equal(strictProviderSchema(schema),true,module.id);
    const wire=compatibleWireOutputSchema(schema);
    assert.ok(wire,module.id);assert.deepEqual(schema,original);
    assert.equal(wire.additionalProperties,false);assert.deepEqual(wire.required,Object.keys(wire.properties));
    assert.equal(wire.if,undefined);
    if(module.artifact==='intent-advice') {
      assert.deepEqual(Object.keys(schema.properties),['status','interpretation','reason']);
      assert.equal(schema.properties.status.const,'proposed');
    } else {
      assert.deepEqual(schema.properties.status.enum,['proposed','needs-evidence']);
      assert.deepEqual(schema.properties.sourceRefs.items.enum,['own']);
      assert.deepEqual(schema.else.properties.focus,{type:'null'});
      if(module.artifact==='pending-actions') {
        assert.equal(schema.then.properties.actions.minItems,1);
        assert.equal(schema.else.properties.actions.maxItems,0);
        assert.deepEqual(schema.properties.actions.items.required,['id','objective','dependsOn']);
        assert.equal(schema.properties.actions.items.additionalProperties,false);
      } else {
        assert.deepEqual(schema.properties.focus.anyOf[0].enum,['pending_a','pending_b']);
        assert.equal(Object.hasOwn(schema.properties,'actions'),false);
        if(module.artifact==='revised-choice') {
          assert.equal(schema.then.properties.alternatives.minItems,2);
          assert.equal(schema.else.properties.alternatives.maxItems,0);
          assert.deepEqual(schema.properties.alternatives.items.enum,['pending_a','pending_b']);
        }
      }
    }
    const empty=chatPlanningArtifactSchema(module,snapshot);
    assert.ok(compatibleWireOutputSchema(empty),module.id+' empty projection remains a usable schema');
    assert.doesNotMatch(JSON.stringify(empty),/"enum":\[\]/);
    if(module.artifact!=='intent-advice') assert.equal(empty.properties.sourceRefs.maxItems,0);
  }
  assert.deepEqual(current,before);
});

test('the observed malformed artifact retains actual usage, identity and bounded diagnostics without committing',async()=>{
  const text='{"status":"proposed","focus":"pending_id","reason":"Identify one primary pending action to address user\'s request. Prioritize based on direct dependency on current state. Create initial plan with one focus and up to seven actions."}}';
  assert.equal(text.length,233);
  assert.equal(createHash('sha256').update(text).digest('hex'),'29cf359f29c7f27935e2898db3b18d3f22481f3f6bff3e8924d1f1d8ab8fdf1d');
  const events=[];
  const invoke=make(options=>{
    options.onEvent({type:'delta',delta:'PRIVATE_PROVIDER_TEXT'});
    options.onEvent({type:'capabilities',profile:'host-only-task-tools',structuredOutput:'provider-json-schema'});
    options.onEvent({type:'capabilities',profile:'planning-response',structuredOutput:'prompt-and-host-validation',
      structuredOutputReason:'structured_output_support_unknown',hostValidationRequired:true,raw:'PRIVATE_PROVIDER_TEXT'});
    return {output:text,threadId:'provider_preparation',turnId:'preparation-turn',usage:{
      inputTokens:2136,outputTokens:49,totalTokens:2185,cachedInputTokens:0,reasoningOutputTokens:null,samples:1}};
  });
  const pass=createChatPlanningPass({mode:'on',...scope,read:()=>snapshot,invoke,commit:()=>assert.fail('invalid JSON cannot commit'),
    assertAdmission:()=>{},emit:event=>events.push(event)});
  assert.equal((await pass.run(module.id)).status,'failed');
  assert.deepEqual(events.map(row=>row.phase),['started','failed']);
  assert.equal(events[0].usage,undefined);
  const terminal=events[1];
  assert.equal(terminal.validationField,'providerOutput');
  assert.equal(terminal.usage.inputTokens,2136);assert.equal(terminal.usage.outputTokens,49);
  assert.equal(terminal.usage.totalTokens,2185);assert.equal(terminal.usage.samples,1);
  assert.equal(terminal.usage.reasoningOutputTokens,null);
  assert.equal(terminal.usage.availability.reasoningOutputTokens,'unavailable');
  assert.deepEqual(terminal.providerDiagnostics,{
    parseOutcome:'invalid-json',outputChars:233,outputSha256:'29cf359f29c7f27935e2898db3b18d3f22481f3f6bff3e8924d1f1d8ab8fdf1d',
    threadId:'provider_preparation',turnId:'preparation-turn',structuredOutput:'prompt-and-host-validation',
    structuredOutputReason:'structured_output_support_unknown',hostValidationRequired:true});
  assert.doesNotMatch(JSON.stringify(events),/PRIVATE_PROVIDER_TEXT|primary pending action|SyntaxError/);
});

test('missing, non-text, empty, and oversized output keep distinct bounded evidence and unavailable counts',async()=>{
  const cases=[[undefined,'missing-output'],[{private:'private output'},'non-text-output'],[' \n','empty-output'],['x'.repeat(12001),'output-too-large']];
  for(const [value,outcome]of cases) {
    const response=await make(()=>({output:value}))({module,...scope,snapshot});
    assert.equal(Object.hasOwn(response,'output'),false);
    assert.equal(response.providerDiagnostics.parseOutcome,outcome);
    assert.equal(response.usage.totalTokens,null);assert.equal(response.usage.samples,0);
    if(typeof value==='string') {
      assert.equal(response.providerDiagnostics.outputChars,value.length);
      assert.equal(response.providerDiagnostics.outputSha256,createHash('sha256').update(value).digest('hex'));
    } else assert.equal(response.providerDiagnostics.outputSha256,undefined);
    assert.doesNotMatch(JSON.stringify(response),/private output/);
  }
});

test('unknown catalog remains prompt fallback; explicit declared support follows the existing gate',()=>{
  const schema=chatPlanningArtifactSchema(module,snapshot),catalog={expiresAt:Date.now()+60000,models:[{id:'fixture'}]};
  assert.equal(compatibleOutputSchemaProfile({schema,model:'fixture',catalog}).structuredOutput,'prompt-and-host-validation');
  assert.equal(compatibleOutputSchemaProfile({schema,model:'fixture',catalog}).structuredOutputReason,'structured_output_support_unknown');
  const declared={...catalog,models:[{id:'fixture',supportedParameters:['structured_outputs']}]};
  assert.equal(compatibleOutputSchemaProfile({schema,model:'fixture',catalog:declared}).structuredOutput,'provider-json-schema');
  assert.equal(catalog.models[0].supportedParameters,undefined);
});

test('reported inference survives cancellation after return without mutating the cancellation reason',async()=>{
  const controller=new AbortController(),reason=Object.freeze(Object.assign(new Error('Stopped by owner'),{code:'OWNER_STOP'}));
  const events=[];
  const invoke=make(()=>{controller.abort(reason);return {output:JSON.stringify(output),usage:{inputTokens:8,outputTokens:3,totalTokens:11},threadId:'prep'};});
  const pass=createChatPlanningPass({mode:'on',...scope,signal:controller.signal,read:()=>snapshot,invoke,
    assertAdmission:()=>{},commit:()=>assert.fail('cancelled phase cannot commit'),emit:event=>events.push(event)});
  assert.equal((await pass.run(module.id)).status,'cancelled');
  assert.deepEqual(events.map(row=>row.phase),['started','cancelled']);
  assert.equal(events.at(-1).usage.totalTokens,11);
  assert.equal(events.at(-1).usage.samples,1);
  assert.equal(events.at(-1).providerDiagnostics.parseOutcome,'parsed');
  assert.equal(reason.planningMetadata,undefined);
});
