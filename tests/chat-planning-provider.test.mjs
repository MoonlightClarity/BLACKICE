import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createSkillsCatalog } from '../lib/skills-catalog.mjs';
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
  const invoke=make(value=>{options=value;return {output:JSON.stringify({artifact:output})};});
  const response=await invoke({module,...scope,snapshot});
  assert.equal(response.transport,'completed'); assert.deepEqual(response.output,output);
  assert.equal(response.providerDiagnostics.parseOutcome,'parsed');
  assert.equal(response.usage.samples,0); assert.equal(response.usage.totalTokens,null);
  assert.equal(strictProviderSchema(options.outputSchema),true);
  assert.ok(compatibleWireOutputSchema(options.outputSchema));
  assert.equal(options.model,'api1::model1');
  assert.equal(options.effort,'low');
  assert.ok(options.prompt.startsWith(module.brief + '\n'), 'an absent non-intent decision adds no invented request');
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
    return {output:JSON.stringify({artifact:output})};
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


test('closed artifact alternatives retain discriminators and cardinality after immutable wire projection',()=>{
  const current={...snapshot,actions:[{id:'pending_a',state:'pending'},{id:'pending_b',state:'pending'},{id:'finished',state:'observed'}],
    receipts:[{id:'own',state:'returned'},{id:'foreign',state:'returned',taskId:'other'},{id:'unresolved',state:'unknown'}]};
  const before=structuredClone(current);
  for(const module of CHAT_PLANNING_MODULES) {
    const schema=chatPlanningArtifactSchema(module,current),original=structuredClone(schema);
    assert.equal(strictProviderSchema(schema),true,module.id);
    const wire=compatibleWireOutputSchema(schema);
    assert.ok(wire,module.id);assert.deepEqual(schema,original);
    assert.equal(wire.additionalProperties,false);assert.deepEqual(wire.required,['artifact']);
    assert.deepEqual(Object.keys(wire.properties),['artifact']);assert.equal(wire.anyOf,undefined);
    if(module.artifact==='intent-advice') {
      const advice=wire.properties.artifact;
      assert.deepEqual(Object.keys(advice.properties),['status','interpretation','reason']);
      assert.equal(advice.properties.status.const,'proposed');
    } else {
      const [proposed,missing]=wire.properties.artifact.anyOf;
      assert.equal(proposed.properties.status.const,'proposed');
      assert.equal(missing.properties.status.const,'needs-evidence');
      for(const branch of [proposed,missing]) {
        assert.equal(branch.additionalProperties,false);assert.deepEqual(branch.required,Object.keys(branch.properties));
        assert.deepEqual(branch.properties.sourceRefs.items.enum,['own']);
      }
      assert.deepEqual(missing.properties.focus,{type:'null'});
      assert.equal(proposed.properties.focus.type,'string');
      if(module.artifact==='pending-actions') {
        assert.equal(proposed.properties.actions.minItems,1);assert.equal(proposed.properties.actions.maxItems,undefined);
        assert.equal(missing.properties.actions.maxItems,0);
        assert.deepEqual(proposed.properties.actions.items.required,['id','objective','dependsOn']);
        assert.equal(proposed.properties.actions.items.additionalProperties,false);
      } else {
        assert.deepEqual(proposed.properties.focus.enum,['pending_a','pending_b']);
        assert.equal(Object.hasOwn(proposed.properties,'actions'),false);
        if(module.artifact==='revised-choice') {
          assert.equal(proposed.properties.alternatives.minItems,2);assert.equal(proposed.properties.alternatives.maxItems,2);
          assert.equal(missing.properties.alternatives.maxItems,0);
          assert.deepEqual(proposed.properties.alternatives.items.enum,['pending_a','pending_b']);
        }
      }
    }
    const empty=compatibleWireOutputSchema(chatPlanningArtifactSchema(module,snapshot));
    assert.ok(empty,module.id+' empty projection remains a usable schema');
    assert.doesNotMatch(JSON.stringify(empty),/"enum":\[\]/);
    if(module.artifact!=='intent-advice')
      for(const branch of empty.properties.artifact.anyOf)assert.equal(branch.properties.sourceRefs.maxItems,0);
  }
  assert.deepEqual(current,before);
});

test('no pending choices and a single alternative preserve only satisfiable artifact branches',()=>{
  for(const count of [0,1,2]) {
    const current={...snapshot,actions:Array.from({length:count},(_,i)=>({id:'pending_'+i,state:'pending'}))};
    for(const module of CHAT_PLANNING_MODULES.filter(item=>['grounded-choice','revised-choice'].includes(item.artifact))) {
      const wire=compatibleWireOutputSchema(chatPlanningArtifactSchema(module,current)),branches=wire.properties.artifact.anyOf;
      const expected=module.artifact==='revised-choice'?count>=2:count>=1;
      assert.equal(branches.some(branch=>branch.properties.status.const==='proposed'),expected);
      assert.equal(branches.at(-1).properties.status.const,'needs-evidence');
    }
  }
});

test('only an exact artifact envelope reaches the unchanged host validator',async()=>{
  const invalid=[output,{artifact:output,extra:true},{artifact:null},{artifact:[]},{artifact:'text'},{other:output},null,[]];
  for(const value of invalid) {
    const response=await make(()=>({output:JSON.stringify(value)}))({module,...scope,snapshot});
    assert.equal(response.providerDiagnostics.parseOutcome,'parsed');
    assert.equal(Object.hasOwn(response,'output'),false);
  }
  for(const selected of CHAT_PLANNING_MODULES) {
    const artifact=selected.artifact==='intent-advice'
      ?{status:'proposed',interpretation:'Inspect the supplied request.',reason:'The user supplied it.'}
      :{status:'needs-evidence',reason:'Need a current observation',sourceRefs:[],focus:null,
        ...(selected.artifact==='pending-actions'?{actions:[]}:selected.artifact==='revised-choice'?{alternatives:[]}:{})};
    const events=[],invoke=make(()=>({output:JSON.stringify({artifact}),usage:{inputTokens:7,outputTokens:5,totalTokens:12}}));
    const pass=createChatPlanningPass({mode:'on',...scope,read:()=>snapshot,invoke,assertAdmission:()=>{},
      commit:()=>assert.fail('No operational proposal'),emit:event=>events.push(event)});
    assert.equal((await pass.run(selected.id)).status,selected.artifact==='intent-advice'?'completed':'needs-evidence');
    assert.equal(events.at(-1).usage.totalTokens,12);
  }
});

test('a parsed proposed envelope with empty actions still fails host validation without repair or CAS',async()=>{
  const events=[],invoke=make(()=>({output:JSON.stringify({artifact:{...output,actions:[]}}),
    usage:{inputTokens:2143,outputTokens:43,totalTokens:2186}}));
  const pass=createChatPlanningPass({mode:'on',...scope,read:()=>snapshot,invoke,assertAdmission:()=>{},
    commit:()=>assert.fail('No invalid plan commit'),emit:event=>events.push(event)});
  assert.equal((await pass.run(module.id)).status,'failed');
  assert.equal(events.at(-1).validationField,'actions');assert.equal(events.at(-1).providerDiagnostics.parseOutcome,'parsed');
  assert.equal(events.at(-1).usage.totalTokens,2186);assert.equal(events.filter(event=>event.usage).length,1);
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
  const invoke=make(()=>{controller.abort(reason);return {output:JSON.stringify({artifact:output}),usage:{inputTokens:8,outputTokens:3,totalTokens:11},threadId:'prep'};});
  const pass=createChatPlanningPass({mode:'on',...scope,signal:controller.signal,read:()=>snapshot,invoke,
    assertAdmission:()=>{},commit:()=>assert.fail('cancelled phase cannot commit'),emit:event=>events.push(event)});
  assert.equal((await pass.run(module.id)).status,'cancelled');
  assert.deepEqual(events.map(row=>row.phase),['started','cancelled']);
  assert.equal(events.at(-1).usage.totalTokens,11);
  assert.equal(events.at(-1).usage.samples,1);
  assert.equal(events.at(-1).providerDiagnostics.parseOutcome,'parsed');
  assert.equal(reason.planningMetadata,undefined);
});

test('PF2 planning puts the current request first once and preserves every artifact support and boundary', async () => {
  const decision = 'PF2_PREREQUISITE: Read design/requirements.txt before choosing implementation work. Preserve λ and 雪.';
  const soul = { content: 'PF2_SOUL: use observed evidence; do not assume project setup.', revision: 9,
    hash: createHash('sha256').update('PF2_SOUL: use observed evidence; do not assume project setup.').digest('hex'), truncated: false };
  const current = { ...snapshot, objective: 'Full current Directory data remains available.',
    actions: [{ id: 'inspect', objective: 'Inspect the supplied requirements.', state: 'pending', dependsOn: [] }] };
  const hostReference = { goal: null, authority: 'Current request only.', preserved: 'PF2_HOST_REFERENCE' };
  const catalog = createSkillsCatalog();
  try {
    for (const selected of CHAT_PLANNING_MODULES) {
      const method = await catalog.detail({ id: selected.skillId || selected.id });
      const artifact = selected.artifact === 'intent-advice'
        ? { status: 'proposed', interpretation: 'Inspect the named prerequisites first.', reason: 'The current request names them.' }
        : { status: 'needs-evidence', reason: 'The prerequisites have not been inspected.', sourceRefs: [], focus: null,
          ...(selected.artifact === 'pending-actions' ? { actions: [] } : selected.artifact === 'revised-choice' ? { alternatives: [] } : {}) };
      const audits = [];
      let options, admissions = 0;
      const invoke = createChatPlanningProviderInvoker({
        runtime: { runAgent: async value => {
          options = value; value.onPromptAccepted(value.prompt);
          return { output: JSON.stringify({ artifact }) };
        } },
        ...scope, cwd: 'test-workspace', model: 'api1::model1', effort: 'low', serviceTier: 'priority', timeoutMs: 45000,
        assertAdmission: () => { admissions++; }, identity: { documents: { soul } },
        onInstructionAudit: value => audits.push(value),
      });
      const before = structuredClone(current);
      const response = await invoke({ module: selected, ...scope, snapshot: current, decision, intentContext: hostReference });
      const prefix = 'CURRENT REQUEST (data): ' + JSON.stringify(decision) + '\n\n';
      assert.ok(options.prompt.startsWith(prefix + selected.brief + '\n'), selected.id);
      assert.equal([...options.prompt.matchAll(/^CURRENT REQUEST \(data\): /gm)].length, 1);
      assert.equal(options.prompt.split(JSON.stringify(decision)).length - 1, 1);
      assert.doesNotMatch(options.prompt, /Host decision scope:/);
      assert.match(options.prompt, /Shape examples are format placeholders, not task content or evidence/);
      assert.match(options.prompt, /When proposing new actions, propose inspecting explicitly requested prerequisite sources/);
      assert.match(options.prompt, /this response-only phase does not perform reads/);
      const soulWire = 'SOUL_DOCUMENT=' + JSON.stringify(soul);
      assert.equal(options.prompt.split(soulWire).length - 1, 1);
      assert.equal(options.prompt.split('\n\nSELECTED PLANNING METHOD\n' + method.content).length - 1, 1);
      assert.ok(options.prompt.indexOf(prefix) < options.prompt.indexOf(soulWire));
      assert.ok(options.prompt.indexOf(soulWire) < options.prompt.indexOf('SELECTED PLANNING METHOD\n'));
      if (selected.artifact === 'intent-advice') {
        assert.ok(options.prompt.endsWith('\nHOST REFERENCE FOR THE CURRENT REQUEST (data): ' + JSON.stringify(hostReference)));
        assert.doesNotMatch(options.prompt, /CURRENT DIRECTORY PROJECTION/);
      } else assert.ok(options.prompt.endsWith('\nCURRENT DIRECTORY PROJECTION (data):\n' + JSON.stringify(current)));
      assert.deepEqual(current, before);
      assert.deepEqual(response.output, artifact, 'framing does not manufacture execution or success');
      assert.equal(admissions, 1);
      assert.equal(options.model, 'api1::model1'); assert.equal(options.effort, 'low');
      assert.equal(options.serviceTier, 'priority'); assert.equal(options.timeoutMs, 45000);
      assert.equal(options.responseOnly, true); assert.equal(options.hostOnlyTools, true);
      assert.equal(options.sandbox, 'read-only'); assert.equal(options.codexHistory, 'relay');
      assert.deepEqual(options.dynamicTools, []);
      assert.deepEqual(options.outputSchema, chatPlanningArtifactSchema(selected, current));
      for (const key of ['max_tokens', 'max_completion_tokens', 'maxOutputTokens', 'contextWindowTokens', 'context', 'temperature', 'topP', 'minP', 'outputTokenPolicy'])
        assert.equal(Object.hasOwn(options, key), false, key + ' is not overridden');
      const audit = audits.at(-1).audit;
      assert.equal(audit.delivery, 'accepted');
      const protocol = audit.sections.find(row => row.id === 'planning-artifact').text;
      assert.ok(options.prompt.startsWith(prefix + protocol));
      assert.equal(audit.sections.find(row => row.id === 'soul').text, soul.content);
      assert.equal(audit.sections.find(row => row.id === 'skill-' + method.id).text, method.content);
      assert.doesNotMatch(JSON.stringify(audit), /PF2_PREREQUISITE/);
    }
  } finally { await catalog.close(); }
});
