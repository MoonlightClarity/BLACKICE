import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HarnessEngine } from '../lib/engine.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { BENCHMARK_AGENT_TOOLS_PROFILE, benchmarkHash } from '../lib/benchmark-profile.mjs';
import { benchmarkFixture, fixtureWorkflow, validSource, toolJSON, readHashes } from './helpers/minicpm-benchmark-fixture.mjs';

class NoExternalModel extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async close() {}
  async runAgent() { throw Error('External model execution is forbidden in this deterministic fixture.'); }
}
const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const directory = (id, args) => tool(id, 'relay_directory_action', args);
const workspace = (id, args) => tool(id, 'relay_workspace', args);
const receiptId = result => {
  const match = result.contentItems.map(item => item.text || '').join('\n').match(/DIRECTORY HOST RECEIPT (receipt-\d+)/);
  assert.ok(match, 'Observation must cite an actual host receipt'); return match[1];
};

async function exercise(t, { profile = BENCHMARK_AGENT_TOOLS_PROFILE, passes = true } = {}) {
  const cleanup = [], f = benchmarkFixture({ after: fn => cleanup.push(fn) });
  const immutable = readHashes(f), canary = fs.readFileSync(f.canary);
  const isV2 = profile === BENCHMARK_AGENT_TOOLS_PROFILE, qualifies = isV2 && passes;
  const source = passes ? '// workspace progress integration\n' + validSource
    : 'module.exports = { directorySmoke: value => "wrong:" + value };\n';
  const requests = [], executed = new Map(), delivered = new Map(), reviews = [], openings = [];
  let engine, runtime, runId, stage = 0, protocolError = null;
  const get = id => { assert.ok(executed.has(id), 'Missing executed call ' + id); return executed.get(id); };
  const script = [
    () => workspace('initial-read', { action: 'read', path: 'src/index.cjs' }),
    () => 'The implementation still needs to be saved and checked.',
    () => directory('plan', { action: 'plan', actions: [
      { id: 'implement', objective: 'Save directorySmoke and verify both fixed public cases.', dependsOn: [] },
    ] }),
    () => directory('focus', { action: 'focus', id: 'implement' }),
    () => isV2 ? tool('save', 'relay_code', { action: 'save', language: 'javascript', path: 'src/index.cjs',
      code: source, expectedHash: toolJSON(get('initial-read')).sha256 })
      : workspace('save', { action: 'write', path: 'src/index.cjs', text: source, expectedHash: toolJSON(get('initial-read')).sha256 }),
    () => workspace('public-check', { action: 'run', command: 'node test-public.cjs', timeoutMs: 10000 }),
    () => passes ? 'The source was saved and its public check passed.' : 'The source was saved but its public check failed.',
    ...(qualifies ? [
      () => directory('observe', { action: 'observe', id: 'implement', outcome: 'objective-met',
        claim: 'The saved implementation passed both fixed public cases. No hidden-test claim is made.',
        receipts: [receiptId(get('public-check'))] }),
      () => 'Saved the implementation and verified both fixed public cases.',
    ] : []),
  ];
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), text = JSON.stringify(body.messages);
      const planning = text.includes('This is one bounded planning phase');
      const summary = text.includes('Create a concise continuity checkpoint');
      requests.push({ kind: planning ? 'planning' : summary ? 'summary' : 'main', body });
      const respond = message => res.end(JSON.stringify({ choices: [{ index: 0,
        finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
      if (planning) {
        assert.ok(isV2); assert.ok(!body.tools?.length);
        respond({ role: 'assistant', content: 'Synthetic planning produced no structured outline.' }); return;
      }
      if (summary) {
        assert.ok(!body.tools?.length);
        respond({ role: 'assistant', content: 'Use the current Directory and saved source for the admitted directorySmoke task.' }); return;
      }
      assert.deepEqual(body.tools.map(item => item.function.name), isV2
        ? ['relay_directory_action', 'relay_workspace', 'relay_code', 'relay_skills']
        : ['relay_directory_action', 'relay_workspace']);
      assert.ok(stage < script.length, 'Unexpected main-provider request ' + stage);
      const next = script[stage++]();
      respond(typeof next === 'string' ? { role: 'assistant', content: next }
        : { role: 'assistant', content: null, tool_calls: [next] });
    } catch (error) {
      protocolError ||= error;
      res.statusCode = 400; res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  t.after(async () => {
    await engine?.close(); await runtime?.close(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    for (const finish of cleanup) await finish();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  runtime = new ProviderRuntime({ codex: new NoExternalModel(), dataDir: path.join(f.root, 'provider'),
    modelLimitResolver: { enrich: async (_config, models) => models } });
  await runtime.store.init();
  await runtime.saveProvider({ id: 'fixture', type: 'compatible',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', maxSteps: null,
    models: [{ id: 'fixture', contextWindowTokens: 65536, maxOutputTokens: 4096, supportsTools: true }],
  }, { preserveDefault: true });
  const provider = () => {
    const value = runtime.listProviders().find(item => item.id === 'fixture');
    return { context: value.context, maxTokens: value.maxTokens, maxSteps: value.maxSteps,
      models: value.models.map(({ id, contextWindowTokens, maxOutputTokens }) => ({ id, contextWindowTokens, maxOutputTokens })) };
  };
  const budgets = structuredClone(provider());
  const execute = runtime.executeTool.bind(runtime);
  runtime.executeTool = async (state, call) => {
    assert.ok(!executed.has(call.id), 'One dispatch per call');
    const result = await execute(state, call); executed.set(call.id, structuredClone(result)); return result;
  };
  const delegate = runtime.runAgent.bind(runtime);
  runtime.runAgent = async options => {
    openings.push({ responseOnly: options.responseOnly === true, context: structuredClone(options.context) });
    return delegate({ ...options, onToolResultDelivered: event => {
      delivered.set(event.call.callId, structuredClone(event.result)); return options.onToolResultDelivered?.(event);
    }, ...(options.onBeforeFinal ? { onBeforeFinal: async candidate => {
      try {
        const result = await options.onBeforeFinal(candidate);
        const snapshot = (await engine.actionDirectories.get(runId, 'Fixture')).read();
        reviews.push({ threadId: candidate.threadId, result: structuredClone(result),
          focus: snapshot.focus, actions: snapshot.actions.map(({ id, state }) => ({ id, state })) });
        return result;
      } catch (error) {
        const snapshot = (await engine.actionDirectories.get(runId, 'Fixture')).read();
        reviews.push({ code: error.code, focus: snapshot.focus,
          actions: snapshot.actions.map(({ id, state }) => ({ id, state })) }); throw error;
      }
    } } : {}) });
  };
  engine = await new HarnessEngine({ runtime, dataDir: path.join(f.root, 'engine'), defaultCwd: f.workspace }).init();
  const workflow = structuredClone(fixtureWorkflow); workflow.id = 'workspace-progress-' + randomUUID();
  workflow.nodes.find(node => node.type === 'agent').model = 'fixture::fixture';
  const started = engine.startRun({ workflow, requestId: 'workspace-progress-' + randomUUID(), input: {
    task: 'Implement directorySmoke in src/index.cjs and verify node test-public.cjs.',
    cwd: f.workspace, planningMode: 'off', directoryMode: 'off', directoryActions: 'on',
    chatPlanning: isV2 ? 'on' : 'off', pastChats: 'off', directoryDiagnostics: 'maximal',
    benchmark: { ...f.request, profile }, benchmarkBudget: { wallMs: 30000 },
  } });
  runId = started.id;
  const deadline = structuredClone(engine.getRun(runId).benchmarkDeadline);
  await engine.executions.get(runId);
  const run = engine.getRun(runId), ledger = (await engine.actionDirectories.get(runId, 'Fixture')).read();
  assert.equal(protocolError, null, protocolError?.stack); assert.equal(stage, script.length);
  assert.equal(run.settled, true); assert.deepEqual(run.benchmarkDeadline, deadline);
  assert.deepEqual(provider(), budgets, 'The repair must not change provider budgets or capabilities');
  assert.deepEqual(readHashes(f), immutable); assert.deepEqual(fs.readFileSync(f.canary), canary);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'src/index.cjs'), 'utf8'), source);
  assert.equal(openings.filter(item => !item.responseOnly).length, 1, 'Feedback stays in the same provider execution');
  assert.equal(delivered.size, executed.size);
  const raw = get('public-check'), accepted = delivered.get('public-check'), body = toolJSON(raw);
  const wire = requests.filter(item => item.kind === 'main').flatMap(item => item.body.messages)
    .filter(message => message.role === 'tool' && message.tool_call_id === 'public-check');
  const originalText = raw.contentItems.map(item => item.text).join('\n');
  assert.equal(accepted.contentItems.map(item => item.text).join('\n'), originalText);
  assert.ok(wire.some(item => item.content === originalText), 'The checker result must reach the actual HTTP request');
  assert.equal(body.actionDispatched, true); assert.equal(body.command, 'node test-public.cjs');
  assert.equal(body.shell, 'none'); assert.deepEqual(body.args, ['test-public.cjs']);
  assert.equal(body.sourceSnapshotVerified, true); assert.equal(body.reportValid, true);
  const report = JSON.parse(body.stdout);
  assert.equal(report.taskId, 'D0'); assert.equal(report.caseCount, 2); assert.equal(report.executedCases, 2);
  assert.equal(report.semanticPass, passes); assert.equal(body.exitCode, passes ? 0 : 2);
  assert.equal(report.sourceSnapshotSha256, body.sourceSnapshotBeforeSha256);
  assert.equal(body.sourceSnapshotBeforeSha256, body.sourceSnapshotAfterSha256);
  assert.equal(toolJSON(get('initial-read')).sha256, benchmarkHash(validSource));
  return { run, ledger, reviews, report, receipt: receiptId(raw), executed, delivered };
}

test('trusted Workspace public check earns the same source-progress follow-up through real engine and provider', { timeout: 40000 }, async t => {
  const f = await exercise(t);
  assert.equal(f.run.status, 'completed', f.run.error); assert.equal(f.reviews.length, 3);
  assert.match(f.reviews[0].result.prompt, /Directory has no actions/);
  const review = f.reviews[1];
  assert.match(review.result.prompt, /source-bound public test check returned successfully/);
  assert.match(review.result.prompt, /"sourceScope":"module-snapshot"/);
  assert.ok(review.result.prompt.includes(f.report.sourceSnapshotSha256));
  assert.match(review.result.prompt, /not hidden-test success or full-objective completion/);
  assert.match(review.result.prompt, /Do not repeat the save or check merely to create a new receipt/);
  assert.equal(review.focus, 'implement'); assert.deepEqual(review.actions, [{ id: 'implement', state: 'active' }]);
  assert.ok(!f.reviews[2].result);
  assert.equal(f.ledger.actions[0].state, 'observed');
  assert.equal(f.ledger.actions[0].observation.authority, 'agent');
  assert.ok(f.ledger.actions[0].observation.receipts.includes(f.receipt));
  assert.ok(f.executed.has('observe'), 'Completion requires an explicit model-authored observe call');
  const progress = f.run.events.filter(event => event.data?.phase === 'continue-after-source-check');
  assert.equal(progress.length, 1); assert.equal(progress[0].data.receiptId, f.receipt);
  assert.equal(progress[0].data.sourceSha256, f.report.sourceSnapshotSha256);
  assert.equal(new Set(f.reviews.map(row => row.threadId).filter(Boolean)).size, 1);
});

test('failed real Workspace public check cannot authorize source-progress continuation', { timeout: 40000 }, async t => {
  const f = await exercise(t, { passes: false });
  assert.equal(f.run.status, 'failed'); assert.match(f.run.error, /Directory still has/);
  assert.equal(f.reviews.length, 2); assert.equal(f.reviews[1].code, 'DIRECTORY_ACTION_UNFINISHED');
  assert.equal(f.ledger.actions[0].state, 'active'); assert.equal(f.executed.has('observe'), false);
  assert.equal(f.run.events.filter(event => event.data?.phase === 'continue-after-source-check').length, 0);
});

test('legacy two-tool benchmark does not gain an unrequested Workspace progress capability', { timeout: 40000 }, async t => {
  const f = await exercise(t, { profile: 'minicpm-code-v1' });
  assert.equal(f.report.semanticPass, true);
  assert.equal(f.run.status, 'failed'); assert.match(f.run.error, /Directory still has/);
  assert.equal(f.reviews.length, 2); assert.equal(f.reviews[1].code, 'DIRECTORY_ACTION_UNFINISHED');
  assert.equal(f.ledger.actions[0].state, 'active'); assert.equal(f.executed.has('observe'), false);
  assert.equal(f.run.events.filter(event => event.data?.phase === 'continue-after-source-check').length, 0);
});
