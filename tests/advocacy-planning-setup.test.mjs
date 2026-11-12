import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_PLANNING_ONTOLOGY } from '../public/planning-module-policy.mjs';
import { ADVOCACY_CASES, runAdvocacyCase } from '../scripts/verify-luna-advocacy.mjs';

test('default fictional form setup uses direct modular execution and preserves a provider failure without external dispatch', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-advocacy-planning-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.match(path.basename(root), /^blackice-advocacy-planning-/);
    await rm(root, { recursive: true, force: true });
  });
  class OperationalFailure extends EventEmitter {
    calls = []; starts = 0; closes = 0;
    status() { return { connected: true, authenticated: true, isolatedHistory: true, defaultModel: 'fixture-model',
      models: [{ id: 'fixture-model', available: true, supportsTools: true, supportedReasoningEfforts: ['default'] }] }; }
    async start() { this.starts++; throw Error('The evaluator must never start a provider during app setup.'); }
    async runAgent(options) {
      this.calls.push(options);
      assert.notEqual(options.responseOnly, true); assert.equal(options.onBeforeFinal, undefined);
      assert.match(options.developerInstructions, /MODULAR PLANNING ONTOLOGY/); assert.ok(options.dynamicTools.some(tool => tool.name === 'relay_browser'));
      throw Object.assign(Error('Synthetic operational provider failure; no external form accessed.'), { code: 'FIXTURE_PROVIDER_FAILURE' });
    }
    async close() { this.closes++; }
  }
  const runtime = new OperationalFailure();
  const result = await runAdvocacyCase({ runtime, root, item: ADVOCACY_CASES.find(item => item.id === 'required-nationality-decline'),
    model: 'fixture-model', effort: 'default', timeoutMs: 900000, runTimeoutMs: 600000 });
  assert.equal(result.status, 'failed');
  assert.equal(result.settled, true);
  assert.equal(result.errorCode, 'FIXTURE_PROVIDER_FAILURE');
  assert.equal(runtime.calls.length, 1);
  assert.ok(runtime.calls.every(call => call.responseOnly !== true && call.timeoutMs === 600000));
  assert.equal(result.timeoutMs, 900000);
  assert.equal(result.runTimeoutMs, 600000);
  assert.equal(result.timedOut, false);
  assert.equal(runtime.starts, 0);
  assert.equal(runtime.closes, 0, 'The caller retains runtime ownership across form cases.');
  assert.deepEqual(result.planningConfiguration, { setup: 'application-services', requestedMode: 'ontology',
    effectiveMode: 'off', enforcement: null, guardrails: false, servicesAttached: true, ontology: DEFAULT_PLANNING_ONTOLOGY });
  assert.equal(result.responseCycle, null); assert.equal(result.viability, null); assert.equal(result.planningGraph, null);
  assert.equal(result.inputIntegrity, true); assert.deepEqual(result.externalDispatches, []);
  assert.equal(result.form.calls.length, 0);
  assert.equal(result.form.submitted, false);
  assert.equal(result.assessment.objective, 'fail');
});

test('the fictional form whole-case deadline aborts and settles an active direct provider call', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-advocacy-deadline-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.match(path.basename(root), /^blackice-advocacy-deadline-/);
    await rm(root, { recursive: true, force: true });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deadlineMs = 500;
  class WaitingProvider extends EventEmitter {
    calls = []; closes = 0; aborts = 0;
    status() { return { connected: true, authenticated: true, isolatedHistory: true, defaultModel: 'fixture-model',
      models: [{ id: 'fixture-model', available: true, supportsTools: true, supportedReasoningEfforts: ['default'] }] }; }
    async runAgent(options) {
      this.calls.push(options);
      assert.notEqual(options.responseOnly, true); assert.equal(options.onBeforeFinal, undefined);
      assert.equal(options.timeoutMs, 10000);
      return new Promise((_resolve, reject) => {
        const abort = () => { this.aborts++; reject(Object.assign(Error('Synthetic cancelled direct call.'), { name: 'AbortError', code: 'ABORT_ERR' })); };
        if (options.signal.aborted) return abort();
        options.signal.addEventListener('abort', abort, { once: true });
        // Advance the deadline only after the synthetic direct call is active.
        t.mock.timers.tick(deadlineMs);
      });
    }
    async close() { this.closes++; }
  }
  const runtime = new WaitingProvider();
  const result = await runAdvocacyCase({ runtime, root,
    item: ADVOCACY_CASES.find(item => item.id === 'required-nationality-decline'),
    model: 'fixture-model', effort: 'default', timeoutMs: deadlineMs, runTimeoutMs: 10000 });
  assert.equal(runtime.calls.length, 1); assert.equal(runtime.aborts, 1); assert.equal(runtime.calls[0].signal.aborted, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.settled, true);
  assert.equal(result.assessment.checks.caseDeadline, false);
  assert.equal(result.assessment.objective, 'fail');
  assert.equal(result.form.submitted, false);
  assert.equal(runtime.closes, 0);
  assert.equal(result.responseCycle, null); assert.equal(result.planningGraph, null);
  assert.equal(result.inputIntegrity, true); assert.deepEqual(result.externalDispatches, []);
});

const receiptBody = receipt => JSON.parse(receipt.contentItems.find(item => item.type === 'inputText').text);
for (const scenario of [
  { name: 'default modular success', success: true },
  { name: 'historical Forced alias success', planningMode: 'forced', success: true },
  { name: 'actual destination validation failure', omitPhone: true, success: false },
  { name: 'lost provider result after one confirmed effect', lostResult: true, success: false },
]) test('the advocacy evaluator reports ' + scenario.name + ' from the actual synthetic form', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-advocacy-outcome-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)); assert.match(path.basename(root), /^blackice-advocacy-outcome-/); await rm(root, { recursive: true, force: true }); });
  const item = ADVOCACY_CASES.find(item => item.id === 'required-nationality-decline');
  let calls = 0, closes = 0;
  class SyntheticProvider extends EventEmitter {
    status() { return { connected: true, authenticated: true, isolatedHistory: true, defaultModel: 'fixture-model',
      models: [{ id: 'fixture-model', available: true, supportsTools: true, supportedReasoningEfforts: ['default'] }] }; }
    async start() { assert.fail('The fixture must not start a live provider.'); }
    async close() { closes++; }
    async runAgent(options) {
      calls++; assert.equal(calls, 1); assert.notEqual(options.responseOnly, true); assert.equal(options.onBeforeFinal, undefined);
      assert.match(options.developerInstructions, /MODULAR PLANNING ONTOLOGY/);
      options.onEvent({ type: 'thread', threadId: 'synthetic-form-thread', model: 'fixture-model' });
      const send = async (args, callId) => {
        const result = await options.onToolCall({ name: 'relay_browser', arguments: args, callId });
        assert.equal(result.success, true, JSON.stringify(result)); return result;
      };
      const opened = receiptBody(await send({ action: 'open', browser: 'relay', url: 'https://forms.example.test/' + item.id }, 'open-form'));
      const guard = { browser: 'relay', tabId: opened.tabId, expectedUrl: opened.url, expectedDocumentId: opened.documentId };
      for (const [ref, text] of [['full_name', item.profile.fullName], ['email', item.profile.email], ...(!scenario.omitPhone ? [['phone', item.profile.phone]] : [])]) {
        await send({ ...guard, action: 'fill', ref, text }, 'fill-' + ref);
      }
      await send({ ...guard, action: 'select', ref: 'nationality', value: 'Prefer not to say' }, 'select-nationality');
      const submit = { name: 'relay_browser', callId: 'one-submission', arguments: { ...guard, action: 'click', ref: 'submit' } };
      const [result, duplicate] = await Promise.all([options.onToolCall(submit), options.onToolCall(structuredClone(submit))]);
      assert.equal(result.success, true, JSON.stringify(result)); assert.deepEqual(duplicate, result);
      if (scenario.lostResult) throw Object.assign(Error('Synthetic provider lost its final response after the confirmed form effect.'), { code: 'FIXTURE_RESULT_LOST' });
      return { output: scenario.omitPhone ? 'The form reported phone is required; nothing was submitted.' : 'The application was received with confirmation FIXTURE-' + item.id + '.', threadId: 'synthetic-form-thread' };
    }
  }
  const runtime = new SyntheticProvider(), original = runtime.runAgent;
  const result = await runAdvocacyCase({ runtime, root, item, model: 'fixture-model', effort: 'default',
    timeoutMs: 10000, runTimeoutMs: 10000, ...(scenario.planningMode ? { planningMode: scenario.planningMode } : {}) });
  assert.equal(result.assessment.objective, scenario.success ? 'pass' : 'fail', JSON.stringify({ error: result.error, checks: result.assessment.checks }));
  assert.equal(result.form.submitted, !scenario.omitPhone); assert.equal(result.form.submissionCount, scenario.omitPhone ? 0 : 1);
  assert.equal(result.form.calls.filter(call => call.args.action === 'click').length, 1, 'Duplicate callbacks do not submit again.');
  assert.equal(result.form.values.nationality, 'Prefer not to say');
  assert.equal(result.planningConfiguration.requestedMode, scenario.planningMode || 'ontology');
  assert.equal(result.planningConfiguration.effectiveMode, 'off'); assert.deepEqual(result.planningConfiguration.ontology, DEFAULT_PLANNING_ONTOLOGY);
  assert.equal(result.responseCycle, null); assert.equal(result.planningGraph, null); assert.equal(result.viability, null);
  assert.equal(Object.hasOwn(result.assessment.checks, 'forcedPlanning'), false); assert.equal(Object.hasOwn(result.assessment.checks, 'planningCycle'), false);
  assert.deepEqual(result.externalDispatches, []); assert.equal(result.inputIntegrity, true); assert.equal(result.timedOut, false);
  assert.equal(result.settled, true); assert.equal(calls, 1); assert.equal(closes, 0); assert.equal(runtime.runAgent, original);
  if (scenario.lostResult) { assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'FIXTURE_RESULT_LOST'); }
  else assert.equal(result.status, 'completed', result.error);
  if (scenario.omitPhone) assert.equal(result.assessment.checks.expectedSubmission, false);
});
