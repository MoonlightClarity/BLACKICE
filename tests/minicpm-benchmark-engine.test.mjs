import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HarnessEngine } from '../lib/engine.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { projectTurnMachineTrace } from '../lib/turn-machine-trace.mjs';
import { projectTurnReceipts } from '../lib/turn-receipts.mjs';
import { benchmarkHash, benchmarkContractHash } from '../lib/benchmark-profile.mjs';
import { benchmarkFixture, fixtureWorkflow, validSource, toolJSON, readHashes } from './helpers/minicpm-benchmark-fixture.mjs';

const receipt = result => result.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];
const task = 'Read METHOD.md and TASK.md, save implementation under src, and verify with node test-public.cjs.';
const fixtureContext = Object.freeze({ preset: 'custom', windowTokens: 65536, autoCompact: false, outputReserveTokens: 4096, headroomTokens: 3276 });
const requestFor = f => ({ workflow: { ...structuredClone(fixtureWorkflow), id: 'minicpm-code-boundary-fixture',
  settings: { ...fixtureWorkflow.settings, context: { ...fixtureContext } } }, input: {
  task, cwd: f.workspace, directoryActions: 'on', chatPlanning: 'off', pastChats: 'off',
  directoryDiagnostics: 'maximal', benchmark: structuredClone(f.request),
} });
class ScriptedRuntime extends EventEmitter {
  calls = 0;
  status() { return { connected: true, authenticated: true, models: [{ id: 'fixture-model', supportsTools: true }] }; }
  async runAgent(options) { this.calls++; return this.execute(options); }
}
class NoExternalModel extends EventEmitter {
  status() { return { connected: false, authenticated: false, models: [] }; }
  async close() {}
  async runAgent() { throw Error('An external model is forbidden in this deterministic fixture.'); }
}
async function setup(t, execute = async () => { throw Error('The provider must not start.'); }) {
  const cleanup = [], f = benchmarkFixture({ after: fn => cleanup.push(fn) });
  let engine;
  t.after(async () => { await engine?.close(); for (const fn of cleanup) await fn(); });
  const runtime = new ScriptedRuntime(); runtime.execute = execute;
  engine = await new HarnessEngine({ runtime, dataDir: path.join(f.root, 'engine'), defaultCwd: f.workspace }).init();
  return { ...f, engine, runtime };
}

test('actual compatible adapter uses exactly two benchmark tools and verifies saved modules without outside access', { timeout: 30000 }, async t => {
  const cleanup = [], f = benchmarkFixture({ after: fn => cleanup.push(fn) });
  const immutableBefore = readHashes(f), requests = [], executed = new Map(), delivered = new Map(), deniedRoutes = [];
  const providerRequests = [], rawHostRecords = [], executedRecords = [], deliveryEvents = [], routeProbeRecords = [];
  let engine, runtime, stage = 0, protocolError = null, opening;
  const wrongSource = "module.exports = { directorySmoke: value => 'wrong:' + value };\n";
  const finalSource = "const tag = require('./tag.cjs');\nmodule.exports = { directorySmoke: value => tag + value };\n";
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body); providerRequests.push({ receivedAt: new Date().toISOString(), payload: structuredClone(body) });
      const send = message => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] })); };
      const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      const ws = (id, args) => tool(id, 'relay_workspace', args);
      const dir = (id, args) => tool(id, 'relay_directory_action', args);
      let call;
      switch (stage++) {
        case 0: call = ws('read-method', { action: 'read', path: 'METHOD.md' }); break;
        case 1: call = ws('read-task', { action: 'read', path: 'TASK.md' }); break;
        case 2: call = ws('parent-read', { action: 'read', path: '../outside.cjs' }); break;
        case 3: call = ws('absolute-read', { action: 'read', path: f.canary }); break;
        case 4: call = ws('scaffold-write', { action: 'write', path: 'test-public.cjs', text: 'forged' }); break;
        case 5: call = ws('arbitrary-command', { action: 'run', command: 'node -e "process.stdout.write(1)"' }); break;
        case 6: call = ws('unfocused-command', { action: 'run', command: 'node test-public.cjs' }); break;
        case 7: call = ws('unfocused-write', { action: 'write', path: 'src/index.cjs', text: wrongSource }); break;
        case 8: call = dir('plan', { action: 'plan', actions: [{ id: 'implement', objective: 'Save source modules and pass both fixed public cases.', dependsOn: [] }] }); break;
        case 9: call = dir('focus', { action: 'focus', id: 'implement' }); break;
        case 10: call = ws('write-wrong', { action: 'write', path: 'src/index.cjs', text: wrongSource }); break;
        case 11: call = ws('read-wrong', { action: 'read', path: 'src/index.cjs' }); break;
        case 12: call = ws('run-failed', { action: 'run', command: 'node test-public.cjs', timeoutMs: 10000 }); break;
        case 13: call = dir('after-failure', { action: 'read' }); break;
        case 14: call = ws('write-helper', { action: 'write', path: 'src/tag.cjs', text: "module.exports = 'ok:';\n" }); break;
        case 15: call = ws('write-correct', { action: 'write', path: 'src/index.cjs', text: finalSource }); break;
        case 16: call = ws('read-correct', { action: 'read', path: 'src/index.cjs' }); break;
        case 17: call = ws('run-passed', { action: 'run', command: 'node test-public.cjs', timeoutMs: 10000 }); break;
        case 18: call = dir('observe', { action: 'observe', outcome: 'objective-met', id: 'implement',
          claim: 'Saved implementation was read back, and both fixed public cases passed with exit 0.',
          receipts: [receipt(executed.get('read-correct')), receipt(executed.get('run-passed'))] }); break;
        case 19: send({ role: 'assistant', content: 'Saved source modules. Both fixed public cases passed with exit 0.' }); return;
        default: throw Error('Unexpected extra fixture provider request at stage ' + stage);
      }
      send({ role: 'assistant', content: null, tool_calls: [call] });
    } catch (error) {
      protocolError ||= error;
      res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  t.after(async () => {
    await engine?.close(); await runtime?.close(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    for (const fn of cleanup) await fn();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  runtime = new ProviderRuntime({ codex: new NoExternalModel(), dataDir: path.join(f.root, 'provider'),
    modelLimitResolver: { enrich: async (_config, models) => models } });
  await runtime.store.init();
  await runtime.saveProvider({ id: 'fixture', type: 'compatible', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    maxSteps: null, models: [{ id: 'fixture', contextWindowTokens: 65536, maxOutputTokens: 4096 }] }, { preserveDefault: true });
  const executeTool = runtime.executeTool.bind(runtime);
  runtime.executeTool = async (state, call) => {
    assert(!executed.has(call.id), 'One dispatch per fixture call');
    const startedAt = new Date().toISOString(), result = await executeTool(state, call);
    executedRecords.push({ startedAt, finishedAt: new Date().toISOString(), call: structuredClone(call), result: structuredClone(result) });
    executed.set(call.id, structuredClone(result)); return result;
  };
  const runAgent = runtime.runAgent.bind(runtime);
  runtime.runAgent = async options => {
    assert.equal(opening, undefined, 'Exactly one fixture provider opening');
    opening = { prompt: options.prompt, developerInstructions: options.developerInstructions,
      tools: structuredClone(options.dynamicTools), hostOnlyTools: options.hostOnlyTools, context: structuredClone(options.context) };
    // Probe the engine route directly so catalog filtering alone cannot satisfy acceptance.
    for (const [name, namespace] of [['relay_find_files'], ['relay_control'], ['relay_agents'], ['relay_history'], ['relay_workspace', 'external']]) {
      const call = { name, ...(namespace ? { namespace } : {}), arguments: {}, callId: 'route-' + deniedRoutes.length };
      const startedAt = new Date().toISOString(), result = await options.onToolCall(call);
      routeProbeRecords.push({ startedAt, finishedAt: new Date().toISOString(), call: structuredClone(call), result: structuredClone(result) });
      assert.equal(result.success, false); assert.equal(result.code, 'BENCHMARK_TOOL_UNAVAILABLE');
      assert.equal(result.actionDispatched, false); assert.equal(result.hostHandlerEntered, false); deniedRoutes.push(result);
    }
    return runAgent({ ...options, onToolCall: async (call, context) => {
      const startedAt = new Date().toISOString(), result = await options.onToolCall(call, context);
      rawHostRecords.push({ startedAt, finishedAt: new Date().toISOString(), call: structuredClone(call), result: structuredClone(result) });
      return result;
    }, onToolResultDelivered: event => {
      deliveryEvents.push({ observedAt: new Date().toISOString(), event: structuredClone(event) });
      delivered.set(event.call.callId, structuredClone(event.result)); return options.onToolResultDelivered?.(event);
    } });
  };
  engine = await new HarnessEngine({ runtime, dataDir: path.join(f.root, 'engine'), defaultCwd: f.workspace }).init();
  const request = requestFor(f); request.requestId = 'm6-' + randomUUID();
  request.workflow.nodes.find(node => node.type === 'agent').model = 'fixture::fixture';
  const started = engine.startRun(request);
  await engine.executions.get(started.id);
  assert.equal(protocolError, null, protocolError?.stack);
  const run = engine.getRun(started.id);
  assert.equal(run.status, 'completed', run.error); assert.equal(run.settled, true);
  assert.equal(stage, 20); assert.equal(executed.size, 19); assert.equal(delivered.size, 19); assert.equal(deniedRoutes.length, 5); assert.equal(rawHostRecords.length, 19);
  const names = ['relay_directory_action', 'relay_workspace'];
  assert.deepEqual(opening.tools.map(tool => tool.name), names); assert.deepEqual(run.nodes.agent.toolNames, names);
  assert.equal(opening.hostOnlyTools, true);
  assert.deepEqual(opening.context, fixtureContext);
  assert.deepEqual(run.workflow.nodes.find(node => node.type === 'agent').context || run.workflow.settings.context, fixtureContext);
  for (const wire of requests) assert.deepEqual(wire.tools.map(tool => tool.function.name), names);
  const scoped = opening.tools.find(tool => tool.name === 'relay_workspace');
  assert.deepEqual(scoped.inputSchema.properties.action.enum, ['list', 'read', 'write', 'patch', 'run']);
  assert.equal(scoped.inputSchema.properties.cwd, undefined);
  assert.deepEqual(scoped.inputSchema.properties.command.enum, ['node test-public.cjs']);
  assert.match(opening.developerInstructions, /BENCHMARK FILE CAPABILITY/);
  assert.equal(opening.developerInstructions.split('BENCHMARK FILE CAPABILITY').length - 1, 1);
  assert.doesNotMatch(opening.prompt, /Read or search the requested file locations, including outside that folder/);
  for (const id of ['parent-read', 'absolute-read', 'scaffold-write', 'arbitrary-command']) {
    assert.equal(executed.get(id).success, false); assert.equal(executed.get(id).actionDispatched, false);
    assert.equal(executed.get(id).hostHandlerEntered, false);
    assert.equal(toolJSON(delivered.get(id)).actionDispatched, false);
  }
  assert.equal(executed.get('unfocused-write').code, 'DIRECTORY_FOCUS');
  assert.equal(executed.get('unfocused-write').actionDispatched, false); assert.equal(executed.get('unfocused-write').hostHandlerEntered, true);
  assert.equal(executed.get('unfocused-command').code, 'DIRECTORY_FOCUS');
  assert.equal(executed.get('unfocused-command').actionDispatched, false); assert.equal(executed.get('unfocused-command').hostHandlerEntered, true);
  assert.equal(run.nodes.agent.directoryContext.hostTools.received, 11, 'Nine dispatched calls and two post-counter refusals; early benchmark refusals never enter the counter');
  const methodWire = delivered.get('read-method').contentItems.find(item => item.type === 'inputText').text;
  assert.match(methodWire, /\nDIRECTORY HOST RECEIPT receipt-[0-9]+/);
  const method = JSON.parse(methodWire.split('\nDIRECTORY HOST RECEIPT ')[0]);
  assert.equal(method.path, path.join(f.workspace, 'METHOD.md')); assert.equal(method.sha256, f.receipt.method.sha256);
  assert.equal(method.startLine, 1); assert.equal(method.endLine, method.totalLines); assert.equal(method.truncated, false);
  assert.equal(method.content.split('\n').map(line => line.replace(/^\d+: /, '')).join('\n'), f.files['METHOD.md']);
  const failed = toolJSON(executed.get('run-failed')), passed = toolJSON(executed.get('run-passed'));
  assert.equal(executed.get('run-failed').success, false); assert.equal(failed.exitCode, 2);
  assert.equal(JSON.parse(failed.stdout).executedCases, 2); assert.equal(JSON.parse(failed.stdout).passedCases, 0);
  const afterFailure = toolJSON(executed.get('after-failure'));
  assert.equal(afterFailure.actions[0].state, 'active'); assert.equal(afterFailure.actions[0].observation, undefined);
  assert.equal(executed.get('run-passed').success, true); assert.equal(passed.exitCode, 0);
  assert.equal(passed.signal, null); assert.equal(passed.timedOut, false); assert.equal(passed.truncated, false);
  assert.equal(passed.sourceSnapshotVerified, true); assert.equal(passed.sourceSnapshotBeforeSha256, passed.sourceSnapshotAfterSha256);
  assert.equal(JSON.parse(passed.stdout).sourceSnapshotSha256, passed.sourceSnapshotAfterSha256);
  assert.equal(JSON.parse(passed.stdout).executedCases, 2); assert.equal(JSON.parse(passed.stdout).passedCases, 2);
  assert.equal(fs.readFileSync(path.join(f.workspace, 'src/index.cjs'), 'utf8'), finalSource);
  assert.equal(fs.readFileSync(f.canary, 'utf8'), 'outside-private-canary\n');
  assert.deepEqual(readHashes(f), immutableBefore);
  const ledger = await engine.actionDirectories.get(started.id, 'Fixture'), state = ledger.read(), directoryFinal = ledger.finalStatus();
  assert.equal(state.actions[0].state, 'observed'); assert.equal(state.focus, null); assert.equal(state.receipts.length, 9);
  assert(state.receipts.every(row => row.state === 'returned'));
  assert.equal(state.receipts.filter(row => row.success === false).length, 1);
  const rawRun = structuredClone(engine.runs.get(started.id)), trace = projectTurnMachineTrace(rawRun);
  assert.equal(trace.entries.filter(entry => entry.kind === 'directory.effect' && entry.metadata.phase === 'dispatch').length, 9);
  assert.equal(run.benchmark.workspace, f.workspace); assert.equal(run.benchmark.scaffoldReceiptSha256, f.request.scaffoldReceiptSha256);
  assert.equal(benchmarkContractHash(run.benchmark), run.benchmark.contractSha256);
  assert.deepEqual(run.benchmark.immutableFiles, f.receipt.immutableFiles);
  assert.equal(engine.startRun(request).id, run.id, 'Exact replay after source edits returns the existing run');
  assert.throws(() => engine.startRun({ ...request, input: { ...request.input, benchmark: { ...f.request, scaffoldReceiptSha256: '0'.repeat(64) } } }),
    error => error.status === 409, 'Same request ID cannot change its benchmark binding');
  assert.throws(() => engine.retryRun(run.id), { code: 'BENCHMARK_RESUME_UNSUPPORTED' });
  assert.throws(() => engine.continueRun(run.id, { nodeId: 'agent', message: 'Continue' }), { code: 'BENCHMARK_RESUME_UNSUPPORTED' });
  await assert.rejects(engine.compactRun(run.id, { nodeId: 'agent' }), { code: 'BENCHMARK_RESUME_UNSUPPORTED' });
  await engine.close();
  engine = await new HarnessEngine({ runtime, dataDir: path.join(f.root, 'engine'), defaultCwd: f.workspace }).init();
  assert.deepEqual(engine.getRun(run.id).benchmark, run.benchmark, 'Saved contract survives an engine reload');
  if (process.env.BLACKICE_MINICPM_M6_EVIDENCE_FILE) {
    const providerThread = await runtime.readThread(run.nodes.agent.threadId), receiptPages = {};
    for (const view of ['context', 'tools', 'decisions']) {
      const pages = []; let offset = 0, revision;
      while (offset !== null) {
        const page = projectTurnReceipts(run, { view, offset, limit: 50, ...(revision ? { revision } : {}) });
        pages.push(page); revision = page.revision;
        assert(page.nextOffset === null || Number.isSafeInteger(page.nextOffset) && page.nextOffset > offset);
        offset = page.nextOffset;
      }
      receiptPages[view] = { pages, complete: offset === null };
    }
    const evidence = {
      schema: 'blackice.minicpm.synthetic-native-receipt-evidence.v1',
      label: 'Deterministic public D0 fixture using the real native engine and compatible adapter; no model outcome or scored benchmark.',
      capturedAt: new Date().toISOString(), node: process.version, platform: process.platform,
      request, scaffoldReceiptText: f.receiptBytes, scaffoldReceipt: f.receipt, opening,
      bundle: { kind: 'collect', run, providerThreadId: run.nodes.agent.threadId,
        ledger: { runId: run.id, taskId: run.taskId || run.id, state, final: directoryFinal },
        machine: trace, receiptPages },
      rawRun, providerThread, providerRequests, rawHostRecords, executedRecords, deliveryEvents, routeProbeRecords,
      finalSource: { 'src/index.cjs': finalSource, 'src/tag.cjs': "module.exports = 'ok:';\n" },
      finalSourceSnapshotSha256: passed.sourceSnapshotAfterSha256, immutableScaffoldHashes: immutableBefore,
      interpretation: { hostCounterEntered: 11, dispatchedWorkspaceCalls: 9, earlyBenchmarkRefusals: 4,
        postCounterDirectoryRefusals: 2, directHiddenRouteProbes: 5, publicCasesExecuted: 2, publicCasesPassed: 2 },
    };
    const target = process.env.BLACKICE_MINICPM_M6_EVIDENCE_FILE;
    assert(path.isAbsolute(target), 'Verification artifact path must be absolute');
    const text = JSON.stringify(evidence, null, 2) + '\n';
    fs.writeFileSync(target, text, { flag: 'wx' });
    assert.equal(fs.readFileSync(target, 'utf8'), text, 'Synthetic evidence artifact readback');
  }
  console.log('MINICPM_BENCHMARK_ENGINE ' + JSON.stringify({ status: run.status, settled: run.settled, toolNames: names,
    wireRequests: requests.length, routedDenials: deniedRoutes.length, publicCaseCount: 2, publicExecutedCases: 2,
    commandExitCode: passed.exitCode, sourceSnapshotSha256: passed.sourceSnapshotAfterSha256, scaffoldHashes: immutableBefore,
    benchmarkContractSha256: run.benchmark.contractSha256, receiptCount: state.receipts.length,
    unknownReceipts: state.receipts.filter(row => row.state === 'unknown').length,
    promptSha256: benchmarkHash(opening.prompt), developerSha256: benchmarkHash(opening.developerInstructions),
    toolsSha256: benchmarkHash(JSON.stringify(opening.tools)) }));
});

test('engine rejects invalid opt-in requests without creating a run or starting a provider', async t => {
  const f = await setup(t), mutations = [
    value => { value.input.benchmark = null; },
    value => { value.input.benchmark.extra = true; },
    value => { value.input.benchmark.scaffoldReceiptSha256 = '0'.repeat(64); },
    value => { value.input.cwd = f.root; },
    value => { value.input.directoryActions = 'off'; },
    value => { delete value.input.pastChats; },
    value => { value.input.chatPlanning = 'on'; },
    value => { value.input.attachmentIds = ['unattached-fixture']; },
    value => { value.benchmark = value.input.benchmark; delete value.input.benchmark; },
  ];
  for (const mutate of mutations) {
    const value = requestFor(f); mutate(value);
    assert.throws(() => f.engine.startRun(value), error => /^BENCHMARK_/.test(error.code), 'Rejected request must keep an explicit benchmark failure');
  }
  assert.equal(f.runtime.calls, 0); assert.equal(f.engine.runs.size, 0); assert.equal(f.engine.executions.size, 0);
});

test('scaffold drift after admission fails before a provider opening and cannot fall back to ordinary tools', async t => {
  const f = await setup(t), started = f.engine.startRun(requestFor(f));
  fs.appendFileSync(path.join(f.workspace, 'METHOD.md'), 'Changed after admission.\n');
  await f.engine.executions.get(started.id);
  const run = f.engine.getRun(started.id);
  assert.equal(run.status, 'failed'); assert.equal(run.settled, true); assert.equal(f.runtime.calls, 0);
  assert.match(run.error, /changed|hash|scaffold/i); assert.equal(run.benchmark.profile, 'minicpm-code-v1');
  assert.throws(() => f.engine.retryRun(run.id), { code: 'BENCHMARK_RESUME_UNSUPPORTED' });
});

test('a mutated persisted benchmark contract fails before provider dispatch', async t => {
  const f = await setup(t), started = f.engine.startRun(requestFor(f));
  const current = f.engine.runs.get(started.id);
  current.benchmark = { ...current.benchmark, command: 'node arbitrary.cjs' };
  await f.engine.executions.get(started.id);
  const run = f.engine.getRun(started.id);
  assert.equal(run.status, 'failed'); assert.equal(run.settled, true); assert.equal(f.runtime.calls, 0);
  assert.match(run.error, /benchmark contract(?: or workspace)? changed/i);
});

test('ordinary mode retains outside reads, ordinary commands and its existing catalog', { timeout: 15000 }, async t => {
  let f, captured;
  f = await setup(t, async options => {
    captured = options;
    assert(options.dynamicTools.some(tool => tool.name === 'relay_find_files'));
    assert(options.dynamicTools.length > 2); assert(!options.dynamicTools.some(tool => tool.name === 'relay_directory_action'));
    const read = await options.onToolCall({ name: 'relay_workspace', arguments: { action: 'read', path: f.canary }, callId: 'ordinary-outside' });
    assert.equal(read.success, true, JSON.stringify(read)); assert.match(toolJSON(read).content, /outside-private-canary/);
    const ran = await options.onToolCall({ name: 'relay_workspace',
      arguments: { action: 'run', command: 'node -e "process.stdout.write(\'ordinary-result\')"' }, callId: 'ordinary-command' });
    assert.equal(ran.success, true, JSON.stringify(ran)); assert.equal(toolJSON(ran).stdout, 'ordinary-result');
    return { output: 'Ordinary access preserved.' };
  });
  const request = requestFor(f); delete request.input.benchmark; request.input.directoryActions = 'off';
  const started = f.engine.startRun(request); await f.engine.executions.get(started.id);
  const run = f.engine.getRun(started.id); assert.equal(run.status, 'completed', run.error);
  assert.equal(run.benchmark, undefined); assert.equal(f.runtime.calls, 1);
  assert.match(captured.prompt, /Read or search the requested file locations, including outside that folder/);
  assert.doesNotMatch(captured.developerInstructions, /BENCHMARK FILE CAPABILITY/);
  assert.throws(() => f.engine.continueRun(run.id, { nodeId: 'agent', message: 'Continue', benchmark: f.request }), { code: 'BENCHMARK_RESUME_UNSUPPORTED' });
});
