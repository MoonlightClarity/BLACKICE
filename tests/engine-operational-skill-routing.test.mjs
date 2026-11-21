import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { IdentityStore } from '../lib/identity.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { createSkillsCatalog } from '../lib/skills-catalog.mjs';
import { chatGPTStartChatTool } from '../lib/chatgpt-start-chat.mjs';
import { submitChat } from '../public/next/chat/send.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';

const application = 'Apply to one job for me: Senior Product Manager, AI Evaluation & Quality. Use the employer site for this posting only. Submit the ordinary application and verify the result.';
const operationalIds = ['builtin-task-grounding', 'library-job-search'];

class UnusedNative extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async close() {}
  async runAgent() { assert.fail('This test must never call a live model.'); }
}

async function fixture(t) {
  const tempRoot = await realpath(tmpdir());
  const cwd = await mkdtemp(path.join(tempRoot, 'blackice-operational-routing-'));
  const dataDir = path.join(cwd, 'engine');
  const catalog = createSkillsCatalog({ dataDir });
  const requests = [];
  let engine, runtime, identity, serial = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.end(JSON.stringify({
      choices: [{
        index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: 'Synthetic read-only fixture response.' },
      }],
    }));
  });
  t.after(async () => {
    await engine?.close();
    await runtime?.close();
    await catalog.close();
    await identity?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const actual = await realpath(cwd);
    assert.equal(path.dirname(actual), tempRoot);
    assert.match(path.basename(actual), /^blackice-operational-routing-/);
    await rm(actual, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  runtime = new ProviderRuntime({
    codex: new UnusedNative(), dataDir: cwd,
    modelLimitResolver: { enrich: async (_config, model) => model },
  });
  await runtime.store.init();
  await runtime.saveProvider({
    id: 'fixture', type: 'compatible',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    models: [{ id: 'fixture', contextWindowTokens: 65536, maxOutputTokens: 4096 }],
  }, { preserveDefault: true });
  identity = await new IdentityStore({ dataDir }).init();
  engine = await new HarnessEngine({
    runtime, dataDir, defaultCwd: cwd, identity,
    browser: {
      status: () => ({ available: true, contained: true, tabs: [] }),
      perform: () => assert.fail('No real browser action is part of instruction routing.'),
    },
  }).init();
  const direct = chatGPTStartChatTool({ engine, defaultCwd: cwd });
  const api = async (route, _method, body) => route === '/api/workflows' ? body : engine.startRun(body);

  async function invoke(route, task = application, { assignment, authored = false } = {}) {
    const before = requests.length;
    let runId;
    if (route === 'direct') {
      const result = await direct.execute({
        requestId: 'operational-routing-' + (++serial), message: task,
        model: 'fixture::fixture', planningMode: 'off',
      }, { client: { id: 'fixture-client' } });
      assert.equal(result.success, true);
      const admission = JSON.parse(result.contentItems[0].text);
      assert.equal(admission.accepted, true);
      runId = admission.runId;
    } else if (assignment || authored) {
      const workflow = createMissionWorkflow({
        id: (authored ? 'authored_' : 'mission_chat_') + 'routing_' + (++serial),
        task, model: 'fixture::fixture', cwd, planningMode: 'off',
      });
      if (assignment) workflow.nodes.find(node => node.type === 'agent').assignment = assignment;
      runId = engine.startRun({
        workflow, input: { task, cwd, planningMode: 'off', chatPlanning: 'off', directoryActions: 'off' },
      }).id;
    } else {
      const result = await submitChat({
        api, runs: [], task, model: 'fixture::fixture', cwd,
        chatPlanning: 'off', directoryActions: 'off',
      });
      runId = result.run.id;
    }
    await engine.executions.get(runId);
    const run = engine.getRun(runId);
    assert.equal(run.status, 'completed', run.error);
    const delivered = requests.slice(before);
    // Module R intentionally adds one evidence self-check for ordinary action tasks.
    // Static fixture responses must settle after that one review; excluded routes stay single-turn.
    const expectsReview = task === application && !assignment && !authored;
    assert.equal(delivered.length, expectsReview ? 2 : 1,
      expectsReview ? 'ordinary action routes require exactly one evidence review after the main turn'
        : 'unrelated, assigned, and authored routes must not acquire a completion review');
    assert.equal(run.planningMode, 'off', 'routing must preserve Planning Off');
    assert.notEqual(run.directoryActions, 'on', 'routing must not enable Action Directory');
    return {
      run,
      prompt: JSON.stringify(delivered[0].messages),
      receipts: run.skillLoadReceipts || [],
      sections: run.nodes.agent.instructionAudit?.sections || [],
    };
  }
  return { catalog, invoke };
}

function requireOperational(result, expectedSource) {
  for (const id of operationalIds) {
    const receipt = result.receipts.find(row => row.skillId === id);
    assert.ok(receipt, id + ' must reach the actual provider');
    assert.equal(receipt.type, 'skill_context_submitted');
    if (expectedSource) assert.equal(receipt.source, expectedSource);
    assert.ok(result.sections.some(section => section.id === 'skill-' + id), id + ' must appear in instruction audit');
  }
}

function requireAbsent(result) {
  for (const id of operationalIds) {
    assert.ok(!result.receipts.some(row => row.skillId === id), id + ' must not have a delivery receipt');
    assert.ok(!result.sections.some(section => section.id === 'skill-' + id), id + ' must not appear in instruction audit');
  }
}

test('direct and Mission application entry points deliver the same operational skill bodies and receipts', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const mission = await f.invoke('mission');
  const direct = await f.invoke('direct');
  requireOperational(mission, 'bundled');
  requireOperational(direct, 'bundled');
  for (const id of operationalIds) {
    const skill = await f.catalog.detail({ id });
    assert.ok(mission.prompt.includes(JSON.stringify(skill.content).slice(1, -1)), id + ' body reached Mission provider');
    assert.ok(direct.prompt.includes(JSON.stringify(skill.content).slice(1, -1)), id + ' body reached direct provider');
  }
  assert.deepEqual(
    direct.receipts.filter(row => operationalIds.includes(row.skillId)),
    mission.receipts.filter(row => operationalIds.includes(row.skillId)),
  );
});

test('both application entry points deliver current owner revisions instead of bundled fallbacks', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const contents = new Map([
    ['builtin-task-grounding', '# Anti-Overalignment\nOwner method: continue authorized work using observable results.'],
    ['library-job-search', '# Job Search\nOwner method: verify the requested application outcome.'],
  ]);
  for (const [id, content] of contents) {
    const prior = await f.catalog.detail({ id });
    await f.catalog.save({ id, value: { expectedRevision: prior.revision, content } });
  }
  for (const route of ['mission', 'direct']) {
    const result = await f.invoke(route);
    requireOperational(result, 'user');
    for (const [id, content] of contents) {
      const current = await f.catalog.detail({ id });
      assert.equal(result.receipts.find(row => row.skillId === id).sourceRevision, current.revision);
      assert.ok(result.prompt.includes(JSON.stringify(content).slice(1, -1)), route + ' receives the edited body');
    }
  }
});

test('deleted operational skills remain absent through both application entry points', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const id of operationalIds) {
    const prior = await f.catalog.detail({ id });
    await f.catalog.delete({ id, value: { expectedRevision: prior.revision } });
  }
  for (const route of ['mission', 'direct']) {
    const result = await f.invoke(route);
    requireAbsent(result);
    assert.ok(result.receipts.some(row => row.skillId === 'library-what-makes-done'));
  }
});

test('unrelated explanatory requests do not acquire job operational skills through either entry point', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const route of ['mission', 'direct']) {
    requireAbsent(await f.invoke(route, 'Explain how job search works.'));
  }
});

test('an explicitly assigned worker does not receive root application operational skills', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  requireAbsent(await f.invoke('mission', application, {
    assignment: {
      scope: 'Inspect the supplied application requirements without external action.',
      inputs: ['Requirements supplied by the coordinator.'],
      result: 'A concise requirements summary.',
      doneWhen: 'The supplied requirements have been summarized.',
    },
  }));
});

test('an authored workflow is not reclassified as ordinary Chat merely because its input is an application request', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  requireAbsent(await f.invoke('mission', application, { authored: true }));
});
