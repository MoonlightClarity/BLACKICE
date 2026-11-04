import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ADVOCACY_CASES, runAdvocacyCase } from '../scripts/verify-luna-advocacy.mjs';

test('default live-form setup uses Forced application Planning and blocks operations after failed admission', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-advocacy-planning-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.match(path.basename(root), /^blackice-advocacy-planning-/);
    await rm(root, { recursive: true, force: true });
  });
  class AnalyticalFailure extends EventEmitter {
    calls = []; starts = 0; closes = 0;
    status() { return { connected: true, authenticated: true, isolatedHistory: true, defaultModel: 'fixture-model',
      models: [{ id: 'fixture-model', available: true, supportsTools: true, supportedReasoningEfforts: ['default'] }] }; }
    async start() { this.starts++; throw Error('The evaluator must never start a provider during app setup.'); }
    async runAgent(options) {
      this.calls.push(options);
      assert.equal(options.responseOnly, true, 'Operational work must not bypass the application Planning service.');
      throw Object.assign(Error('Synthetic Planning admission failure; no model called.'), { code: 'FIXTURE_PLANNING_FAILURE' });
    }
    async close() { this.closes++; }
  }
  const runtime = new AnalyticalFailure();
  const result = await runAdvocacyCase({ runtime, root, item: ADVOCACY_CASES.find(item => item.id === 'required-nationality-decline'),
    model: 'fixture-model', effort: 'default', timeoutMs: 900000, runTimeoutMs: 600000 });
  assert.equal(result.status, 'failed');
  assert.equal(result.settled, true);
  assert.equal(result.errorCode, 'FIXTURE_PLANNING_FAILURE');
  assert.ok(runtime.calls.length > 0);
  assert.ok(runtime.calls.every(call => call.responseOnly === true && call.timeoutMs === 600000));
  assert.equal(result.timeoutMs, 900000);
  assert.equal(result.runTimeoutMs, 600000);
  assert.equal(result.timedOut, false);
  assert.equal(runtime.starts, 0);
  assert.equal(runtime.closes, 0, 'The caller retains runtime ownership across form cases.');
  assert.deepEqual(result.planningConfiguration, { setup: 'application-services', requestedMode: 'forced',
    effectiveMode: 'on', enforcement: 'forced', guardrails: true, servicesAttached: true });
  assert.equal(result.responseCycle.state, 'failed');
  assert.ok(result.planningGraph?.cycles?.length);
  assert.equal(result.form.calls.length, 0);
  assert.equal(result.form.submitted, false);
  assert.equal(result.assessment.objective, 'fail');
});

test('the form whole-case deadline cancels and settles an active Planning call', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-advocacy-deadline-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.match(path.basename(root), /^blackice-advocacy-deadline-/);
    await rm(root, { recursive: true, force: true });
  });
  class WaitingAdmission extends EventEmitter {
    calls = []; closes = 0;
    status() { return { connected: true, authenticated: true, isolatedHistory: true, defaultModel: 'fixture-model',
      models: [{ id: 'fixture-model', available: true, supportsTools: true, supportedReasoningEfforts: ['default'] }] }; }
    async runAgent(options) {
      this.calls.push(options);
      assert.equal(options.responseOnly, true);
      assert.equal(options.timeoutMs, 10000);
      return new Promise((_resolve, reject) => {
        const abort = () => reject(Object.assign(Error('Synthetic cancelled admission.'), { name: 'AbortError', code: 'ABORT_ERR' }));
        if (options.signal.aborted) return abort();
        options.signal.addEventListener('abort', abort, { once: true });
      });
    }
    async close() { this.closes++; }
  }
  const runtime = new WaitingAdmission();
  const result = await runAdvocacyCase({ runtime, root,
    item: ADVOCACY_CASES.find(item => item.id === 'required-nationality-decline'),
    model: 'fixture-model', effort: 'default', timeoutMs: 500, runTimeoutMs: 10000 });
  assert.ok(runtime.calls.length > 0);
  assert.equal(result.timedOut, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.settled, true);
  assert.equal(result.assessment.checks.caseDeadline, false);
  assert.equal(result.assessment.objective, 'fail');
  assert.equal(result.form.submitted, false);
  assert.equal(runtime.closes, 0);
});
