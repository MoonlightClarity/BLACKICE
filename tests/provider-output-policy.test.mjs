import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { normalizeProvider } from '../lib/provider-store.mjs';
import {
  normalizeOutputTokenPolicy, createOutputTokenPolicySnapshot,
  outputTokenPolicyForRecord, outputTokenBudgetForRequest,
} from '../lib/provider-output-policy.mjs';

const localConfig = {
  id: 'local_llamacpp', type: 'compatible', preset: 'llamacpp',
  baseUrl: 'http://127.0.0.1:8080/v1', models: ['fixture'], maxTokens: 8192,
};
const json = value => new Response(JSON.stringify(value), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
class NoNative extends EventEmitter {
  calls = 0;
  status() { return { connected: false, authenticated: false, models: [] }; }
  async runAgent() { this.calls++; throw Error('No native inference is permitted in this fixture.'); }
  async close() {}
}

async function fixture(t, {
  policy = 'provider-default', allocation = 262144, modelOutput = null,
  storedWindow, measuredInput = 40, finishReason = 'stop',
} = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'provider-output-policy-'));
  const requests = [], measurements = [], events = [], order = [], natives = [];
  let runtime, leases = 0, acquisitions = 0, releases = 0, summaryFinish = 'stop';
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    assert.equal(target.origin, 'http://127.0.0.1:8080',
      'all provider traffic is intercepted; no fixture network request may escape');
    if ((options.method || 'GET') === 'GET') {
      assert.equal(target.pathname, '/v1/models');
      order.push('catalog');
      return json({ data: [{
        id: 'fixture', context_length: allocation,
        ...(modelOutput ? { max_output_tokens: modelOutput } : {}),
      }] });
    }
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    if (target.pathname === '/v1/chat/completions/input_tokens') {
      measurements.push(body); order.push('measure');
      assert.equal(Object.hasOwn(body, 'max_tokens'), false);
      return json({ input_tokens: measuredInput });
    }
    assert.equal(target.pathname, '/v1/chat/completions');
    assert.ok(leases > 0, 'generation stays inside the prepared-model lease');
    const summary = body.messages.some(message => message.role === 'system'
      && String(message.content).includes('Summarize historical context only.'));
    requests.push({ body, summary }); order.push(summary ? 'summary' : 'generation');
    return json({
      choices: [{
        message: { role: 'assistant', content: summary ? 'Saved synthetic continuity.' : 'Completed.' },
        finish_reason: summary ? summaryFinish : finishReason,
      }],
      usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 },
    });
  };
  const open = async () => {
    const native = new NoNative(); natives.push(native);
    const instance = await new ProviderRuntime({
      dataDir, codex: native, fetchImpl,
      modelLimitResolver: { enrich: async (_config, models) => models.map(model => ({
        ...model, contextWindowTokens: allocation, contextWindowSource: 'runtime-reported',
        ...(modelOutput ? { maxOutputTokens: modelOutput, maxOutputTokensSource: 'runtime-reported' } : {}),
      })) },
    }).init();
    instance.localModels = { acquireLlama: async (model, { signal }) => {
      assert.equal(model, 'fixture'); signal.throwIfAborted();
      order.push('lease'); leases++; acquisitions++;
      let released = false;
      return { release() {
        assert.equal(released, false, 'a prepared lease must settle once');
        released = true; leases--; releases++; order.push('release');
      } };
    } };
    return instance;
  };
  runtime = await open();
  t.after(async () => {
    await runtime?.close();
    assert.equal(leases, 0); assert.equal(acquisitions, releases);
    assert.ok(natives.every(native => native.calls === 0));
    await rm(dataDir, { recursive: true, force: true });
  });
  await runtime.saveProvider({
    ...localConfig,
    models: [{ id: 'fixture', ...(storedWindow ? { contextWindowTokens: storedWindow } : {}) }],
    ...(policy === undefined ? {} : { outputTokenPolicy: policy }),
  });
  requests.length = 0; measurements.length = 0; order.length = 0;
  return {
    dataDir, requests, measurements, events, order,
    get runtime() { return runtime; },
    get leases() { return leases; },
    setSummaryFinish(value) { summaryFinish = value; },
    run(options = {}) {
      return runtime.runAgent({
        cwd: dataDir, model: 'local_llamacpp::fixture', prompt: 'Complete the public fixture task.',
        dynamicTools: [], ...options, onEvent: event => events.push(event),
      });
    },
    async configure(patch) { return runtime.saveProvider({ id: 'local_llamacpp', ...patch }); },
    async restart() { await runtime.close(); runtime = await open(); },
    async record(threadId) { return JSON.parse(await readFile(runtime.threadFile(threadId), 'utf8')); },
  };
}

test('output policy is explicit; old maxTokens and null semantics are unchanged', () => {
  const old = normalizeProvider(localConfig);
  assert.equal(old.maxTokens, 8192);
  assert.equal(Object.hasOwn(old, 'outputTokenPolicy'), false);
  assert.equal(normalizeProvider({ id: old.id, maxTokens: null }, old).maxTokens, 8192);
  assert.equal(normalizeOutputTokenPolicy(undefined, localConfig), 'configured-limit');
  assert.equal(createOutputTokenPolicySnapshot(old), undefined);
  assert.equal(outputTokenPolicyForRecord({}, { ...localConfig, outputTokenPolicy: 'provider-default' }), 'configured-limit');
  const selected = normalizeProvider({ ...localConfig, outputTokenPolicy: 'provider-default' });
  assert.equal(selected.outputTokenPolicy, 'provider-default');
  assert.equal(selected.maxTokens, 8192, 'retained configured budget is not the selected generation policy');
  const snapshot = createOutputTokenPolicySnapshot(selected);
  assert.deepEqual(snapshot, { version: 1, policy: 'provider-default' });
  assert.ok(Object.isFrozen(snapshot));
  const state = { config: selected, record: { outputTokenPolicy: snapshot } };
  assert.equal(outputTokenBudgetForRequest(state), null);
  assert.equal(outputTokenBudgetForRequest({ ...state, responseMaxTokens: 256 }), 256);
  assert.throws(() => outputTokenBudgetForRequest({ ...state, responseMaxTokens: Infinity }),
    { code: 'INVALID_OUTPUT_TOKEN_POLICY' });
});

test('unsupported output policies and transports are rejected without changing legacy defaults', () => {
  for (const value of [null, '', 'unlimited', true, 8192, {}])
    assert.throws(() => normalizeProvider({ ...localConfig, outputTokenPolicy: value }),
      { code: 'INVALID_OUTPUT_TOKEN_POLICY' });
  for (const changes of [
    { id: 'other_local' }, { baseUrl: 'https://remote.example/v1' },
    { baseUrl: 'http://127.0.0.1:8081/v1' }, { preset: 'compatible' },
    { endpoints: { chatCompletions: '/other/completions' } },
  ]) assert.throws(() => normalizeProvider({ ...localConfig, ...changes, outputTokenPolicy: 'provider-default' }),
    { code: 'INVALID_OUTPUT_TOKEN_POLICY' });
  assert.throws(() => normalizeOutputTokenPolicy('provider-default', { ...localConfig, type: 'anthropic' }),
    { code: 'INVALID_OUTPUT_TOKEN_POLICY' });
  assert.equal(normalizeProvider({ ...localConfig, id: 'other_local' }).maxTokens, 8192);
});

test('fresh local provider-default requests omit max_tokens despite the ordinary 8192 admission reserve', async t => {
  const f = await fixture(t);
  const prompt = 'Preserve this complete public input \u{1f642}\u{10400}.';
  const result = await f.run({ prompt });
  assert.equal(f.requests.length, 1);
  assert.equal(Object.hasOwn(f.requests[0].body, 'max_tokens'), false);
  assert.equal(Object.hasOwn(f.requests[0].body, 'max_completion_tokens'), false);
  assert.equal(f.requests[0].body.messages.at(-1).content, prompt);
  const context = f.events.find(event => event.type === 'context').context;
  assert.equal(context.outputReserveTokens, 8192);
  assert.equal(context.effectiveWindowTokens, 262144);
  assert.deepEqual((await f.record(result.threadId)).outputTokenPolicy,
    { version: 1, policy: 'provider-default' });
  assert.equal(f.events.find(event => event.type === 'thread').outputTokenPolicy, 'provider-default');
  assert.ok(f.order.indexOf('lease') < f.order.indexOf('generation'));
  assert.equal(f.order.at(-1), 'release');
});

test('analytical local requests omit max_tokens while retaining a known model capacity for admission', async t => {
  const f = await fixture(t, { modelOutput: 4096 });
  await f.run({ responseOnly: true });
  assert.equal(f.requests.length, 1);
  assert.equal(Object.hasOwn(f.requests[0].body, 'max_tokens'), false);
  assert.equal(f.events.find(event => event.type === 'context').context.outputReserveTokens, 4096);
  assert.equal(f.requests[0].body.model, 'fixture');
});

test('legacy conversation continuation retains its configured limit after the provider default changes', async t => {
  const f = await fixture(t, { policy: 'configured-limit' });
  const first = await f.run({ context: { autoCompact: false }, effort: 'default' });
  const before = await f.record(first.threadId);
  assert.equal(f.requests[0].body.max_tokens, 8192);
  assert.equal(Object.hasOwn(before, 'outputTokenPolicy'), false);
  await f.configure({ outputTokenPolicy: 'provider-default' });
  const resumed = await f.run({ threadId: first.threadId, prompt: 'Continue the same public fixture.' });
  assert.equal(resumed.threadId, first.threadId);
  assert.equal(f.requests.at(-1).body.max_tokens, 8192);
  const after = await f.record(first.threadId);
  assert.equal(Object.hasOwn(after, 'outputTokenPolicy'), false);
  assert.equal(after.model, before.model);
  assert.deepEqual(after.contextOptions, before.contextOptions);
});

test('a new opt-in policy survives restart and direct continuation after provider configuration changes', async t => {
  const f = await fixture(t);
  const first = await f.run({ context: { autoCompact: false }, effort: 'default' });
  const before = await f.record(first.threadId);
  await f.configure({ outputTokenPolicy: 'configured-limit', maxTokens: 1024 });
  await f.restart();
  await f.run({ threadId: first.threadId, prompt: 'Continue using the recorded choice.' });
  assert.equal(Object.hasOwn(f.requests.at(-1).body, 'max_tokens'), false);
  const after = await f.record(first.threadId);
  assert.deepEqual(after.outputTokenPolicy, before.outputTokenPolicy);
  assert.deepEqual(after.contextOptions, before.contextOptions);
  assert.equal(after.model, before.model);
  await f.run({ prompt: 'A separate new conversation uses the current configured limit.' });
  assert.equal(f.requests.at(-1).body.max_tokens, 1024);
});

test('provider-default keeps the fresh leased physical slot bound and rejects oversized measured input', async t => {
  const f = await fixture(t, { allocation: 8192, storedWindow: 262144, measuredInput: 8190 });
  await assert.rejects(f.run({
    prompt: 'x'.repeat(40000), context: { autoCompact: false, headroomTokens: 128 },
  }), { code: 'CONTEXT_OVERFLOW' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.measurements.length, 1);
  assert.ok(f.events.some(event => event.type === 'context' && event.context.effectiveWindowTokens === 8192));
  assert.equal(f.leases, 0);
});

test('measured local input can trade only the default reserve without creating a generation ceiling', async t => {
  const f = await fixture(t, { allocation: 8192, measuredInput: 7000 });
  const prompt = 'x'.repeat(40000) + 'COMPLETE_PUBLIC_INPUT';
  await f.run({ prompt, context: { autoCompact: false, headroomTokens: 128 } });
  assert.equal(f.measurements.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(Object.hasOwn(f.requests[0].body, 'max_tokens'), false);
  assert.equal(f.requests[0].body.messages.at(-1).content, prompt);
  const fit = f.events.filter(event => event.type === 'context')
    .map(event => event.context).find(context => context.measuredInputTokens === 7000 && context.inputBudgetTokens === 7000);
  assert.equal(fit.outputReserveTokens, 1064);
});

test('provider-default does not overrule an explicitly reserved physical context budget', async t => {
  const f = await fixture(t, { allocation: 8192, measuredInput: 7000 });
  await assert.rejects(f.run({
    prompt: 'x'.repeat(40000),
    context: { autoCompact: false, headroomTokens: 128, outputReserveTokens: 2048 },
  }), { code: 'CONTEXT_OVERFLOW' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.measurements.length, 1);
});

async function history(f) {
  let result;
  for (let index = 0; index < 3; index++) result = await f.run({
    ...(result ? { threadId: result.threadId } : {}),
    prompt: 'Public exchange ' + index + ': ' + 'saved context '.repeat(700),
    context: { autoCompact: false, keepRecentTokens: 512 },
  });
  return result.threadId;
}

test('finite host compaction subrequests stay finite and do not alter the opted-in conversation policy', async t => {
  const f = await fixture(t, { allocation: 65536 });
  const threadId = await history(f);
  const before = await f.record(threadId);
  const result = await f.runtime.compactThread(threadId);
  assert.equal(result.compacted, true);
  const summaries = f.requests.filter(request => request.summary);
  assert.ok(summaries.length > 0);
  for (const { body } of summaries) {
    assert.ok(Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 && body.max_tokens <= 4096);
    assert.ok(!body.tools?.length);
  }
  const after = await f.record(threadId);
  assert.deepEqual(after.outputTokenPolicy, before.outputTokenPolicy);
  await f.run({ threadId, prompt: 'Continue after the saved checkpoint.' });
  assert.equal(Object.hasOwn(f.requests.at(-1).body, 'max_tokens'), false);
});

test('a failed finite summary retains the original history and the opted-in generation policy', async t => {
  const f = await fixture(t, { allocation: 65536 });
  const threadId = await history(f), before = await f.record(threadId);
  f.setSummaryFinish('length');
  await assert.rejects(f.runtime.compactThread(threadId), { code: 'CONTEXT_SUMMARY_FAILED' });
  assert.ok(f.requests.some(request => request.summary && Number.isSafeInteger(request.body.max_tokens)));
  const after = await f.record(threadId);
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.outputTokenPolicy, before.outputTokenPolicy);
});

test('provider truncation reports the omitted wire limit without inventing an 8192 generation cap', async t => {
  const f = await fixture(t, { finishReason: 'length' });
  await assert.rejects(f.run(), cause => {
    assert.equal(cause.code, 'PROVIDER_TRUNCATED');
    assert.match(cause.message, /provider default; no max_tokens generation limit was sent/);
    assert.doesNotMatch(cause.message, /8,192|Configured output budget/);
    return true;
  });
  assert.equal(f.requests.length, 1);
  assert.equal(Object.hasOwn(f.requests[0].body, 'max_tokens'), false);
  const final = f.events.find(event => event.type === 'provider.final');
  assert.equal(final.incomplete, true);
  assert.equal(final.providerTermination, 'length');
});

test('a malformed saved output policy is rejected before acquiring a model lease or making requests', async t => {
  const f = await fixture(t), first = await f.run();
  const record = await f.record(first.threadId);
  record.outputTokenPolicy = { version: 2, policy: 'provider-default' };
  await writeFile(f.runtime.threadFile(first.threadId), JSON.stringify(record));
  const requests = f.requests.length, admissions = f.order.filter(item => item === 'lease').length;
  await assert.rejects(f.run({ threadId: first.threadId, prompt: 'This malformed snapshot must not run.' }),
    { code: 'INVALID_OUTPUT_TOKEN_POLICY' });
  assert.equal(f.requests.length, requests);
  assert.equal(f.order.filter(item => item === 'lease').length, admissions);
});
