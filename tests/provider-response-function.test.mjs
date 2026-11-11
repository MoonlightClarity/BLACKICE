import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProviderRuntime } from '../lib/providers.mjs';
import { compatibleOutputSchemaProfile, compatibleWireOutputSchema } from '../lib/provider-output-schema.mjs';
import { RESPONSE_FUNCTION_NAME } from '../lib/provider-response-function.mjs';

const schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string', minLength: 1 } } };
const answer = ' {\n "answer" : "synthetic response" \n} ';
const parameters = ['tools', 'tool_choice'];
const call = (args = answer, name = RESPONSE_FUNCTION_NAME) => ({ id: 'reply_1', type: 'function', function: { name, arguments: args } });
const message = (args = answer) => ({ role: 'assistant', content: null, tool_calls: [call(args)] });
const wire = (msg = message(), finish = 'tool_calls') => ({ choices: [{ index: 0, message: msg, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 12 } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const sse = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
class Native extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'native', models: [{ model: 'native' }] }; }
  async close() {}
  async runAgent() { throw Error('No native inference allowed in offline transport tests.'); }
}
async function responseFunctionFixture(t, { advertised = parameters, openrouter = false, reply = () => json(wire()), catalogError = false, catalogModels, outputSchema = schema } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'response-function-')), requests = [], events = [], actionCalls = [], deliveries = [];
  const fetchImpl = async (url, options) => {
    const request = { url, method: options.method, body: options.body ? JSON.parse(options.body) : null };
    requests.push(request);
    if (options.method === 'GET') return catalogError ? json({ error: { message: 'Synthetic catalog missing' } }, 404)
      : json({ data: catalogModels || [{ id: 'exact-model', ...(advertised === null ? {} : { supported_parameters: advertised }) }] });
    return reply(request, options, requests.filter(item => item.method === 'POST').length);
  };
  const runtime = await new ProviderRuntime({ codex: new Native(), dataDir: dir, fetchImpl,
    modelLimitResolver: { enrich: async (_config, models) => models } }).init();
  await runtime.saveProvider({ id: 'fixture', type: 'compatible', baseUrl: openrouter ? 'https://openrouter.ai/api/v1' : 'https://synthetic-api.example/v1',
    ...(openrouter ? { apiKey: 'synthetic-fixture-key' } : {}), models: [{ id: 'exact-model', contextWindowTokens: 131072, maxOutputTokens: 8192 }] }, { preserveDefault: true });
  t.after(async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); });
  const options = { model: 'fixture::exact-model', cwd: dir, prompt: 'Return synthetic response data.', responseOnly: true, dynamicTools: [], outputSchema,
    onToolCall: value => { actionCalls.push(value); throw Error('Response data must never execute.'); },
    onToolResultDelivered: value => deliveries.push(value), onEvent: event => events.push(event) };
  return { runtime, dir, requests, events, actionCalls, deliveries, options };
}
const posts = f => f.requests.filter(item => item.method === 'POST');
function noEffects(f) {
  assert.deepEqual(f.actionCalls, []); assert.deepEqual(f.deliveries, []);
  assert.equal(f.events.some(event => event.type === 'tool.result' || event.type === 'item' && event.item?.type === 'dynamicToolCall'), false);
  assert.ok(posts(f).every(request => request.body.messages.every(item => item.role !== 'tool')));
}

test('response-only function sends exact schema and forced choice without action attachment', async t => {
  const f = await responseFunctionFixture(t, { openrouter: true });
  const result = await f.runtime.runAgent(f.options), body = posts(f)[0].body;
  assert.equal(result.output, answer, 'Keep exact argument bytes, whitespace included.');
  assert.equal(body.model, 'exact-model'); assert.equal(body.max_tokens, 8192);
  assert.equal(body.response_format, undefined); assert.deepEqual(body.provider, { require_parameters: true });
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: RESPONSE_FUNCTION_NAME } });
  assert.equal(body.tools.length, 1); assert.deepEqual(body.tools[0].function.parameters, schema);
  assert.equal(body.tools[0].function.strict, undefined, 'Tools support does not promise strict decoding.');
  assert.ok(body.messages[0].content.includes(JSON.stringify(schema)));
  assert.match(body.messages[0].content, /Serialize the final JSON response only as the arguments of blackice_response/);
  assert.match(body.messages[0].content, /not an operational tool/);
  assert.doesNotMatch(body.messages[0].content, /Return a single JSON object/);
  const capability = f.events.find(event => event.type === 'capabilities');
  assert.equal(capability.structuredOutput, 'provider-response-function');
  assert.equal(capability.structuredOutputTransport, 'chat-completions-forced-function');
  assert.equal(capability.attachedTools, 0); assert.equal(capability.responseFunctions, 1);
  assert.equal(capability.hostValidationRequired, true); assert.equal(capability.wireSchemaEnforced, false);
  const saved = await f.runtime.readThread(result.threadId);
  assert.equal(saved.responseOutput.message.tool_calls[0].function.arguments, answer);
  assert.equal(saved.lastResponseTermination.providerFinishReason, 'tool_calls');
  assert.equal(saved.messages.at(-1).content, answer);
  assert.ok(saved.messages.every(item => !item.tool_calls && item.role !== 'tool'));
  noEffects(f);
});

test('capability selection requires fresh exact catalog evidence for both parameters', async t => {
  const fresh = models => ({ expiresAt: 200, models });
  const chosen = supportedParameters => compatibleOutputSchemaProfile({ schema, model: 'm', now: 100, catalog: fresh([{ id: 'm', supportedParameters }]) });
  assert.equal(chosen(parameters).structuredOutput, 'provider-response-function');
  assert.equal(chosen([...parameters, 'structured_outputs']).structuredOutput, 'provider-json-schema');
  for (const p of [[], ['tools'], ['tool_choice'], ['response_format'], null]) assert.equal(chosen(p).structuredOutput, 'prompt-and-host-validation');
  for (const catalog of [null, { expiresAt: 100, models: [{ id: 'm', supportedParameters: parameters }] }, fresh([{ id: 'other', supportedParameters: parameters }])])
    assert.equal(compatibleOutputSchemaProfile({ schema, model: 'm', now: 100, catalog }).structuredOutput, 'prompt-and-host-validation');
  const f = await responseFunctionFixture(t);
  f.runtime.modelCatalogs.set('fixture', { expiresAt: 0, models: [{ id: 'exact-model', supportedParameters: ['structured_outputs'] }] });
  await f.runtime.runAgent(f.options);
  assert.deepEqual(f.requests.map(item => item.method), ['GET', 'POST']);
  assert.equal(posts(f)[0].body.tools.length, 1);
  assert.equal(posts(f)[0].body.provider, undefined);
  await f.runtime.runAgent(f.options);
  assert.deepEqual(f.requests.map(item => item.method), ['GET', 'POST', 'POST'], 'Fresh catalog is reused.');
});

test('missing or unavailable capability evidence never enables the data function', async t => {
  for (const setup of [{ advertised: ['tools'] }, { advertised: ['tool_choice'] }, { advertised: null }, { catalogError: true }]) {
    const f = await responseFunctionFixture(t, { ...setup, reply: () => json(wire({ role: 'assistant', content: answer }, 'stop')) });
    await f.runtime.runAgent(f.options);
    assert.equal(posts(f)[0].body.tools, undefined); assert.equal(posts(f)[0].body.tool_choice, undefined);
    assert.equal(f.events.find(event => event.type === 'capabilities').structuredOutput, 'prompt-and-host-validation');
    noEffects(f);
  }
});

test('streamed function arguments keep exact bytes and opaque metadata without dispatch', async t => {
  const f = await responseFunctionFixture(t, { reply: () => sse([
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'reply_1', type: 'function', function: { name: 'blackice_', arguments: answer.slice(0, 12) } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'response', arguments: answer.slice(12) }, extra_content: { vendor: { signature: 'synthetic-signature' } } }] } }] },
    { choices: [{ index: 0, delta: { extra_content: { vendor: { mode: 'synthetic' } } }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 12 } },
  ]) });
  const result = await f.runtime.runAgent(f.options);
  assert.equal(result.output, answer);
  assert.deepEqual(f.events.filter(event => event.type === 'delta').map(event => event.delta), [answer], 'No unvalidated fragments are published.');
  const saved = await f.runtime.readThread(result.threadId);
  assert.equal(saved.responseOutput.message.tool_calls[0].extra_content.vendor.signature, 'synthetic-signature');
  assert.equal(saved.responseOutput.message.extra_content.vendor.mode, 'synthetic');
  noEffects(f);
});

test('invalid complete envelopes never downgrade to text, repair JSON, or execute calls', async t => {
  const cases = [
    ['forged', { ...message(), tool_calls: [call(answer, 'run_command')] }],
    ['multiple', { ...message(), tool_calls: [call(), call()] }],
    ['empty calls', { ...message(), tool_calls: [] }],
    ['plain text fallback', { role: 'assistant', content: answer }],
    ['mixed text', { ...message(), content: 'Explanation' }],
    ['mixed content blocks', { ...message(), content: [{ type: 'text', text: '' }] }],
    ['refusal', { ...message(), refusal: 'Synthetic refusal' }],
    ['legacy', { ...message(), function_call: { name: RESPONSE_FUNCTION_NAME, arguments: answer } }],
    ['missing identity', { ...message(), tool_calls: [{ ...call(), id: '' }] }],
    ['wrong type', { ...message(), tool_calls: [{ ...call(), type: 'custom' }] }],
    ['empty arguments', message('')],
    ['missing outer brace', message('{"answer":"synthetic"')],
    ['extra text arguments', message(answer + ' trailing')],
    ['object arguments', message({ answer: 'synthetic' })],
    ['array arguments', message('[]')],
    ['null arguments', message('null')],
  ];
  for (const [label, msg] of cases) await t.test(label, async t => {
    const f = await responseFunctionFixture(t, { reply: () => json(wire(msg)) });
    await assert.rejects(f.runtime.runAgent(f.options), { code: ['missing outer brace', 'extra text arguments', 'array arguments', 'null arguments'].includes(label) ? 'PROVIDER_RESPONSE_FORMAT' : 'PROVIDER_RESPONSE_FUNCTION_INVALID' });
    assert.equal(posts(f).length, 1); noEffects(f);
    assert.equal(f.events.some(event => event.type === 'delta' || event.type === 'message'), false);
  });
});

test('ambiguous stream identities, fragments, choices and termination fail closed', async t => {
  const initial = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call('{"answer":') }] } }] };
  const terminal = { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
  for (const [label, events] of [
    ['changed ID', [initial, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'other', function: { arguments: '"synthetic"}' } }] } }] }, terminal]],
    ['multiple same ID', [{ choices: [{ delta: { tool_calls: [call(), call()] } }] }, terminal]],
    ['another index', [initial, { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"synthetic"}' } }] } }] }, terminal]],
    ['multiple choices', [{ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] }]],
    ['unexpected choice', [{ choices: [{ index: 1, delta: { tool_calls: [call()] } }] }]],
    ['text then call', [{ choices: [{ delta: { content: 'explanation' } }] }, initial, terminal]],
    ['object fragment', [{ choices: [{ delta: { tool_calls: [{ ...call(), function: { name: RESPONSE_FUNCTION_NAME, arguments: {} } }] } }] }, terminal]],
    ['missing explicit type', [{ choices: [{ delta: { tool_calls: [{ id: 'reply_1', function: call().function }] } }] }, terminal]],
    ['duplicate stop', [{ choices: [{ delta: { tool_calls: [call()] } }] }, terminal, terminal]],
  ]) await t.test(label, async t => {
    const f = await responseFunctionFixture(t, { reply: () => sse(events) });
    await assert.rejects(f.runtime.runAgent(f.options), { code: 'PROVIDER_RESPONSE_FUNCTION_INVALID' });
    assert.equal(posts(f).length, 1); noEffects(f);
  });
});

test('length and missing termination cannot yield accepted response-only data', async t => {
  for (const finish of ['length', 'stop', 'content_filter', 'private-untrusted-finish-value', null]) {
    const f = await responseFunctionFixture(t, { reply: () => json(wire(message(), finish)) });
    await assert.rejects(f.runtime.runAgent(f.options), cause => {
      assert.equal(cause.code, finish === 'length' ? 'PROVIDER_TRUNCATED' : finish === null ? 'PROVIDER_PROTOCOL' : 'PROVIDER_RESPONSE_FUNCTION_INVALID');
      if (finish !== null) assert.equal(cause.providerFinishReason, finish === 'private-untrusted-finish-value' ? 'unknown' : finish);
      assert.ok(!cause.message.includes('private-untrusted')); return true;
    });
    assert.equal(f.events.some(event => event.type === 'delta' || event.type === 'message'), false);
    noEffects(f);
  }
});

test('cancellation during function streaming publishes no partial data and invokes no callbacks', async t => {
  let started, aborted = false;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await responseFunctionFixture(t, { reply: (_request, options) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [call('{"answer":')] } }] }) + '\n\n'));
      started();
      options.signal.addEventListener('abort', () => { aborted = true; controller.error(options.signal.reason); }, { once: true });
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } }) });
  const controller = new AbortController(), pending = f.runtime.runAgent({ ...f.options, signal: controller.signal });
  await entered; controller.abort(); await assert.rejects(pending);
  assert.equal(aborted, true); assert.equal(f.runtime.active.size, 0); noEffects(f);
  assert.equal(f.events.some(event => event.type === 'delta' || event.type === 'message'), false);
});

test('schema wire rejection cannot retry without parameters or switch destination/model', async t => {
  for (const streaming of [false, true]) {
    const f = await responseFunctionFixture(t, { openrouter: true, reply: () => streaming
      ? sse([{ error: { message: 'Synthetic unsupported function choice' } }])
      : json({ error: { message: 'Synthetic unsupported function choice' } }, 400) });
    await assert.rejects(f.runtime.runAgent(f.options));
    assert.equal(posts(f).length, 1); assert.equal(posts(f)[0].body.tool_choice.function.name, RESPONSE_FUNCTION_NAME);
    assert.equal(posts(f)[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    noEffects(f);
  }
});

test('wire projection never mutates authoritative host constraints or declares semantic validity', async t => {
  const host = { type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { type: 'array', uniqueItems: true, items: { type: 'string' } } } };
  const before = structuredClone(host), raw = '{"ids":["same","same"]}';
  const f = await responseFunctionFixture(t, { outputSchema: host, reply: () => json(wire(message(raw))) });
  assert.equal((await f.runtime.runAgent(f.options)).output, raw, 'Full caller validators, not transport, determine schema/semantic acceptance.');
  assert.deepEqual(host, before); assert.deepEqual(posts(f)[0].body.tools[0].function.parameters, compatibleWireOutputSchema(host));
  assert.equal(posts(f)[0].body.tools[0].function.parameters.properties.ids.uniqueItems, undefined);
  assert.ok(posts(f)[0].body.messages[0].content.includes(JSON.stringify(host)));
  noEffects(f);
});

test('ordinary action-tool turns do not select or dispatch the response serialization function', async t => {
  const f = await responseFunctionFixture(t, { reply: (_request, _options, index) => index === 1
    ? json(wire({ role: 'assistant', content: null, tool_calls: [call('{"value":"synthetic"}', 'inspect')] }))
    : json(wire({ role: 'assistant', content: 'Finished.' }, 'stop')) });
  let executed = 0;
  const result = await f.runtime.runAgent({ ...f.options, responseOnly: false, outputSchema: undefined,
    dynamicTools: [{ name: 'inspect', description: 'Synthetic observation.', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }],
    onToolCall: async value => { executed++; assert.equal(value.name, 'inspect'); return { success: true, contentItems: [{ type: 'inputText', text: 'Observed synthetic fixture.' }] }; } });
  assert.equal(result.output, 'Finished.'); assert.equal(executed, 1);
  assert.ok(posts(f).every(request => request.body.tools.every(tool => tool.function.name === 'inspect')));
  assert.equal(posts(f)[0].body.tool_choice, undefined);
  assert.equal(posts(f)[1].body.messages.some(item => item.role === 'tool'), true);
});


import { createHash } from 'node:crypto';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { PlanningBrowserRuntime, validatePlanningModuleResponse, PLANNING_MAX_FORMAT_REPAIRS } from '../lib/planning-browser-runtime.mjs';
import { fixtureUserAgency } from './fixture-user-agency.mjs';
import { RESPONSE_FUNCTION_EVIDENCE_MAX_CHARS, createResponseFunctionEvidence } from '../lib/provider-response-function.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const accuracy = { mode: 'exact', tolerance: 'No deviation from the supplied seat counts.',
  decisionThreshold: 'Choose a room only if its supplied capacity is at least five.',
  evidenceNeeded: 'The two supplied fictional capacities.', consequence: 'The selected room must seat five.',
  unknownPolicy: 'block', stopWhen: 'The two supplied capacities have been compared.' };
function viabilityBody(input) {
  const sourceId = input.sources.find(source => source.kind === 'user_request')?.id || input.sources[0].id;
  return {
    userAgency: fixtureUserAgency(),
    values: Object.fromEntries(input.template.fields.map(field => [field.id, field.id === 'objective'
      ? 'Choose the fictional room that seats five from the supplied capacities.'
      : 'South has 6 seats and North has 4 seats, so South meets the five-seat constraint.'])),
    grounding: input.template.fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId })),
    openQuestions: [], challengeResponses: [],
    requirements: [{ id: 'capacity', label: 'Room capacity', importance: 'essential', basis: 'task',
      consequence: 'The selected room must seat five.', resolution: 'observed',
      value: 'North has 4 seats; South has 6 seats.', sourceIds: [sourceId],
      checkedSourceIds: input.sources.filter(source => source.kind !== 'response').map(source => source.id),
      rationale: 'These fictional capacities were supplied in the request.', inferable: false,
      omissionAllowed: false, question: '', dependentNodeIds: [], stopKind: null, commitPrerequisite: false,
      accuracy: structuredClone(accuracy) }],
  };
}

test('real Planning runner and ProviderRuntime repair only explicit model fields through two forced data envelopes', async t => {
  for (const malformed of [false, true]) await t.test(malformed ? 'malformed patch fails without third inference' : 'complete patch passes full host validation', async t => {
    const inputCaptures = [], rawReplies = [], runOptions = [];
    const f = await responseFunctionFixture(t, { reply: (request, _options, index) => {
      const prompt = request.body.messages.findLast(item => item.role === 'user').content;
      const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)); inputCaptures.push(input);
      let raw;
      if (index === 1) {
        const partial = viabilityBody(input);
        delete partial.requirements[0].accuracy.tolerance; delete partial.requirements[0].accuracy.decisionThreshold;
        raw = JSON.stringify(partial);
      } else {
        assert.equal(index, 2, 'No third inference is permitted.');
        assert.equal(input.protocol, 'accuracy-missing-fields-v1');
        raw = JSON.stringify({ repairs: { r0: { tolerance: accuracy.tolerance, decisionThreshold: accuracy.decisionThreshold } } });
        if (malformed) raw = raw.slice(0, -1);
      }
      rawReplies.push(raw); return json(wire(message(raw)));
    } });
    const actualRun = f.runtime.runAgent.bind(f.runtime), integrationEvents = [];
    f.runtime.runAgent = options => { runOptions.push(options); return actualRun({ ...options,
      onToolCall: value => { f.actionCalls.push(value); return options.onToolCall(value); },
      onToolResultDelivered: value => f.deliveries.push(value) }); };
    f.runtime.on('event', event => integrationEvents.push(event));
    const store = await new PlanningBrowserStore({ dataDir: f.dir }).init();
    const runner = new PlanningBrowserRuntime({ store, runtime: f.runtime, defaultCwd: f.dir, getSettings: () => ({ maxSubagents: 2 }) });
    t.after(async () => { await runner.close(); await store.close(); });
    const request = await store.create({ conversationId: 'synthetic-response-wire', title: 'Fictional room comparison',
      objective: 'North seats four and South seats six. Choose the room for five people.', cwd: f.dir });
    const withNode = await store.addNode(request.id, { kind: 'viability', title: 'Compare supplied capacities', prompt: request.objective });
    const node = withNode.nodes.at(-1), budget = { used: 0, max: 4 };
    const start = await runner.start({ requestId: request.id, nodeId: node.id, expectedNodeRevision: node.revision,
      clientRequestId: 'synthetic-response-wire', model: f.options.model, effort: 'default', serviceTier: 'default', providerBudget: budget });
    const finished = await runner.wait(request.id, start.attempt.id), saved = await store.get(request.id);
    assert.equal(PLANNING_MAX_FORMAT_REPAIRS, 1); assert.equal(posts(f).length, 2); assert.equal(budget.used, 2);
    assert.equal(saved.attempts.length, 2); assert.equal(inputCaptures.length, 2);
    assert.equal(saved.attempts[0].partialOutput, rawReplies[0]);
    assert.equal(saved.attempts[1].formatRepair.previousOutput, rawReplies[0]);
    assert.equal(saved.attempts[1].repairOf, saved.attempts[0].id);
    assert.deepEqual(new Set(posts(f)[1].body.tools[0].function.parameters.properties.repairs.properties.r0.required),
      new Set(['tolerance', 'decisionThreshold']));
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(posts(f)[i].body.tools[0].function.parameters, compatibleWireOutputSchema(runOptions[i].outputSchema));
      assert.equal(posts(f)[i].body.tool_choice.function.name, RESPONSE_FUNCTION_NAME);
      assert.match(posts(f)[i].body.messages[0].content, /cannot call operational tools/);
      assert.doesNotMatch(posts(f)[i].body.messages[0].content, /cannot call tools/);
      assert.equal(runOptions[i].responseOnly, true); assert.deepEqual(runOptions[i].dynamicTools, []);
    }
    noEffects(f);
    assert.equal(integrationEvents.some(event => event.type === 'item' && event.item?.type === 'dynamicToolCall' || event.type === 'tool.result'), false);
    const repairThread = await f.runtime.readThread(saved.attempts[1].metadata.threadId);
    assert.ok(repairThread.responseOutput.message, JSON.stringify({ finished: finished.attempt, evidence: repairThread.responseOutput }));
    assert.equal(repairThread.responseOutput.message.tool_calls[0].function.arguments, rawReplies[1]);
    assert.equal(repairThread.responseOutput.providerFinishReason, 'tool_calls');
    if (malformed) {
      assert.equal(finished.attempt.status, 'failed'); assert.equal(saved.responses.length, 0);
      assert.equal(saved.attempts[1].metadata.errorCode, 'PROVIDER_RESPONSE_FORMAT');
      assert.equal(saved.attempts[1].partialOutput, rawReplies[1]);
      assert.equal(saved.attempts[1].metadata.fieldRepair.rawPatch, rawReplies[1]);
      assert.equal(saved.attempts[1].repairAttemptId, undefined);
      assert.equal(repairThread.messages.some(item => item.role === 'assistant'), false);
    } else {
      assert.equal(finished.attempt.status, 'completed', finished.attempt.message); assert.equal(saved.responses.length, 1);
      const repaired = saved.attempts[1], expected = viabilityBody(inputCaptures[0]);
      assert.deepEqual(JSON.parse(repaired.output), expected, 'Every previously valid value remains unchanged.');
      assert.doesNotThrow(() => validatePlanningModuleResponse(repaired, repaired.output));
      assert.equal(repaired.metadata.fieldRepair.rawPatch, rawReplies[1]);
      assert.equal(repaired.metadata.fieldRepair.baseOutputHash, hash(rawReplies[0]));
      assert.equal(repaired.metadata.fieldRepair.patchOutputHash, hash(rawReplies[1]));
      assert.equal(repaired.metadata.fieldRepair.mergedOutputHash, hash(repaired.output));
      assert.equal(saved.responses[0].requirements[0].accuracy.tolerance, accuracy.tolerance);
    }
  });
});

test('malformed and unfinished responses retain bounded literal wire evidence without accepted messages', async t => {
  for (const [label, reply, expected] of [
    ['malformed complete args', () => json(wire(message('{"answer":"synthetic"'))), '{"answer":"synthetic"'],
    ['stream stopped early', () => sse([{ choices: [{ delta: { tool_calls: [call('{"answer":')] } }] }]), '{"answer":'],
    ['stream length with parseable prefix', () => sse([
      { choices: [{ delta: { tool_calls: [call()] } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]), answer],
  ]) await t.test(label, async t => {
    const f = await responseFunctionFixture(t, { reply });
    await assert.rejects(f.runtime.runAgent(f.options));
    const threadId = f.events.find(event => event.type === 'thread').threadId, saved = await f.runtime.readThread(threadId);
    const evidence = saved.responseOutput;
    assert.equal(evidence.truncated, false);
    const args = evidence.message?.tool_calls?.[0].function.arguments ?? evidence.frames[0][0].delta.tool_calls[0].function.arguments;
    assert.equal(args, expected);
    assert.equal(saved.messages.some(item => item.role === 'assistant'), false);
    assert.equal(f.events.some(event => event.type === 'message' || event.type === 'delta'), false);
    noEffects(f);
  });
  const capture = createResponseFunctionEvidence(), enormous = [{ delta: { tool_calls: [call('x'.repeat(RESPONSE_FUNCTION_EVIDENCE_MAX_CHARS + 200))] } }];
  capture.capture(enormous); capture.capture(enormous);
  assert.equal(capture.evidence.truncated, true);
  assert.equal(capture.evidence.capturedCharacters, RESPONSE_FUNCTION_EVIDENCE_MAX_CHARS);
  assert.equal(capture.evidence.rawEnvelopePrefix, JSON.stringify(enormous).slice(0, RESPONSE_FUNCTION_EVIDENCE_MAX_CHARS));
  assert.equal(capture.evidence.message, undefined);
  capture.finish(message(), 'tool_calls');
  assert.equal(capture.evidence.truncated, false);
  assert.equal(capture.evidence.rawEnvelopePrefix, undefined);
  assert.ok(JSON.stringify(capture.evidence).length < 1000, 'Superseded oversized prefix is removed.');
});

test('resuming ordinary conversation sends prior data as text, never replays response envelope as a tool', async t => {
  const f = await responseFunctionFixture(t, { reply: (_request, _options, index) => index === 1
    ? json(wire()) : json(wire({ role: 'assistant', content: 'Synthetic follow-up.' }, 'stop')) });
  const first = await f.runtime.runAgent(f.options);
  const second = await f.runtime.runAgent({ ...f.options, responseOnly: false, outputSchema: undefined, threadId: first.threadId,
    prompt: 'Summarize the previous synthetic data.' });
  assert.equal(second.output, 'Synthetic follow-up.');
  const body = posts(f)[1].body;
  assert.ok(body.messages.some(item => item.role === 'assistant' && item.content === answer));
  assert.equal(body.messages.some(item => item.tool_calls || item.role === 'tool' || item.responseOutput), false);
  assert.equal(body.tools, undefined); noEffects(f);
});


import { workbenchFramePng } from '../lib/workbench-agent-tools.mjs';
test('failed image-bearing stream never persists separately echoed small image fragments', async t => {
  const b = Buffer.alloc(58); b.write('BM'); b.writeUInt32LE(58, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(1, 18); b.writeInt32LE(-1, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(32, 28); b[54] = 91; b[55] = 43; b[56] = 17;
  const imageUrl = 'data:image/png;base64,' + workbenchFramePng({ bytes: b, width: 1, height: 1, contentType: 'image/bmp' }).toString('base64');
  const raw = imageUrl.split(',')[1], fragments = raw.match(/.{1,16}/g);
  for (const fail of [true, false]) {
    const chunks = [{ choices: [{ delta: { tool_calls: [call('{"answer":"')] } }] },
      ...fragments.map(fragment => ({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] } }] }))];
    if (!fail) chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, finish_reason: 'tool_calls' }] });
    const f = await responseFunctionFixture(t, { reply: () => sse(chunks) });
    const pending = f.runtime.runAgent({ ...f.options, inputImages: [{ imageUrl }] });
    if (fail) await assert.rejects(pending); else assert.ok((await pending).output.includes('[image data omitted]'));
    const saved = await f.runtime.readThread(f.events.find(event => event.type === 'thread').threadId);
    const retained = JSON.stringify(saved.responseOutput);
    assert.equal(retained.includes(raw), false);
    if (fail) {
      assert.deepEqual(saved.responseOutput.frames, []);
      for (const fragment of fragments.slice(0, -1)) assert.equal(retained.includes(fragment), false);
      assert.equal(saved.responseOutput.streamContentOmitted, 'image-input-fragments');
    }
    assert.equal(JSON.stringify(f.events).includes(raw), false); noEffects(f);
  }
});

test('initial malformed exact function data gets only the existing full-response repair', async t => {
  const rawReplies = [], captured = [];
  const f = await responseFunctionFixture(t, { reply: (request, _options, index) => {
    const prompt = request.body.messages.findLast(item => item.role === 'user').content;
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)); captured.push(input);
    assert.ok(index <= 2);
    if (index === 2) { assert.equal(input.protocol, undefined); assert.equal(input.formatRepair.previousOutput, rawReplies[0]); }
    let raw = JSON.stringify(viabilityBody(input)); if (index === 1) raw = raw.slice(0, -1);
    rawReplies.push(raw); return json(wire(message(raw)));
  } });
  const store = await new PlanningBrowserStore({ dataDir: f.dir }).init();
  const runner = new PlanningBrowserRuntime({ store, runtime: f.runtime, defaultCwd: f.dir, getSettings: () => ({ maxSubagents: 2 }) });
  t.after(async () => { await runner.close(); await store.close(); });
  const request = await store.create({ conversationId: 'synthetic-malformed-wire', title: 'Fictional comparison',
    objective: 'North seats four and South seats six. Choose the room for five people.', cwd: f.dir });
  const withNode = await store.addNode(request.id, { kind: 'viability', title: 'Compare fictional rooms', prompt: request.objective });
  const node = withNode.nodes.at(-1), budget = { used: 0, max: 4 };
  const start = await runner.start({ requestId: request.id, nodeId: node.id, expectedNodeRevision: node.revision,
    clientRequestId: 'synthetic-malformed-wire', model: f.options.model, providerBudget: budget });
  const result = await runner.wait(request.id, start.attempt.id), saved = await store.get(request.id);
  assert.equal(result.attempt.status, 'completed', result.attempt.message);
  assert.equal(posts(f).length, 2); assert.equal(budget.used, 2);
  assert.equal(saved.attempts.length, 2); assert.equal(saved.responses.length, 1);
  assert.equal(saved.attempts[0].partialOutput, rawReplies[0]);
  assert.equal(saved.attempts[0].metadata.capabilities.wireSchemaEnforced, false);
  assert.equal(saved.attempts[0].metadata.capabilities.responseFunctions, 1);
  assert.equal(saved.attempts[1].metadata.fieldRepair, undefined);
  assert.doesNotThrow(() => validatePlanningModuleResponse(saved.attempts[1], saved.attempts[1].output));
  const failedThread = await f.runtime.readThread(saved.attempts[0].metadata.threadId);
  assert.equal(failedThread.responseOutput.message.tool_calls[0].function.arguments, rawReplies[0]);
  assert.equal(failedThread.messages.some(item => item.role === 'assistant'), false);
  noEffects(f);
});
