/**
 * Opt-in acceptance QA against the signed-in native Codex runtime.
 * Uses real model calls and additional account usage. No mocked runtime.
 * All workflow state, fixtures and output files stay in a new QA directory.
 * Usage: node scripts/verify-agentic-runtime.mjs --live [--output-dir ABSOLUTE_PATH]
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexRuntime } from '../lib/codex.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { createSwarmWorkflow } from '../public/swarm-model.mjs';

const args = process.argv.slice(2);
if (!args.includes('--live')) {
  console.error('This check uses real signed-in model calls. Run with --live to test delegation and swarms.');
  process.exit(2);
}
const directoryFlag = args.indexOf('--output-dir');
const requestedDirectory = directoryFlag < 0 ? null : args[directoryFlag + 1];
if (args.some((arg, index) => !['--live', '--output-dir'].includes(arg) && !(directoryFlag >= 0 && index === directoryFlag + 1))
  || requestedDirectory !== null && (!requestedDirectory || !path.isAbsolute(requestedDirectory))) {
  console.error('Usage: node scripts/verify-agentic-runtime.mjs --live [--output-dir ABSOLUTE_PATH]');
  process.exit(2);
}
const root = requestedDirectory || await mkdtemp(path.join(tmpdir(), 'blackice-agentic-qa-'));
// Exclusive creation keeps a repeated invocation from overwriting earlier evidence.
if (requestedDirectory) await mkdir(root, { recursive: false });
const cwd = path.join(root, 'workspace'), dataDir = path.join(root, 'profile');
await mkdir(cwd);
const keys = { alpha: randomUUID(), beta: randomUUID() };
for (const [id, key] of Object.entries(keys)) {
  await writeFile(path.join(cwd, id + '.txt'), JSON.stringify({ id, key, value: id === 'alpha' ? 17 : 25 }) + '\n');
}
const runtime = new CodexRuntime({ cwd, runTimeoutMs: 180_000, requestTimeoutMs: 30_000 });
const settings = await new RuntimeSettingsStore({ dataDir }).init();
await settings.update({ subagentsEnabled: true, maxSubagents: 2, runTimeoutMs: 180_000, verbosity: 'concise' });
const engine = new HarnessEngine({ runtime, dataDir, defaultCwd: cwd });
engine.runtimeSettings = settings;
await engine.init();
const receipt = { schema: 1, startedAt: new Date().toISOString(), root, cwd, checks: [], live: true };
const calls = [], original = runtime.runAgent.bind(runtime);
runtime.runAgent = async options => {
  const call = {
    role: options.prompt.startsWith('You are a short-lived Relay subagent.') ? 'child' : options.prompt.match(/^You are ([^\n]+)/)?.[1] || 'unknown',
    startedAt: new Date().toISOString(), toolCalls: [], events: [],
  };
  calls.push(call);
  try {
    const result = await original({
      ...options,
      onToolCall: async (tool, context) => {
        const record = { name: tool.name, arguments: typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : tool.arguments };
        call.toolCalls.push(record);
        const response = await options.onToolCall(tool, context);
        record.success = response.success;
        try { record.result = JSON.parse(response.contentItems?.[0]?.text); } catch {}
        return response;
      },
      onEvent: event => {
        if (['thread', 'tool.result'].includes(event.type)) call.events.push(event);
        options.onEvent?.(event);
      },
    });
    Object.assign(call, { finishedAt: new Date().toISOString(), output: result.output, threadId: result.threadId, usage: result.usage });
    return result;
  } catch (error) {
    call.error = { message: error.message, code: error.code };
    throw error;
  }
};
const run = async (workflow, input) => {
  const started = engine.startRun({ workflow, input });
  console.log(JSON.stringify({ event: 'started', id: started.id, name: workflow.name }));
  await engine.executions.get(started.id);
  const finished = engine.getRun(started.id);
  receipt.checks.push({ name: workflow.name, status: finished.status, id: finished.id, output: finished.output, error: finished.error, nodes: finished.nodes, events: finished.events });
  if (finished.status !== 'completed') throw Error(finished.error || 'Run did not complete.');
};
const workspaceReads = call => call.toolCalls.filter(tool => tool.name === 'relay_workspace' && tool.arguments.action === 'read');
const inputReads = call => workspaceReads(call).filter(tool => /(?:^|[/\\])(alpha|beta)\.txt$/.test(tool.arguments.path));
const matchesArtifact = (artifact, source) => artifact.alpha === keys.alpha && artifact.beta === keys.beta && artifact.sum === 42 && artifact.source === source;
try {
  const status = await runtime.start();
  receipt.runtime = { connected: status.connected, authenticated: status.authenticated, version: status.version, model: status.defaultModel };
  console.log(JSON.stringify({ event: 'runtime', ...receipt.runtime }));
  const graph = {
    id: 'live-delegation', name: 'Live authenticated parent-child delegation',
    nodes: [
      { id: 'input', type: 'input', name: 'Task' },
      { id: 'agent', type: 'agent', name: 'QA coordinator', model: 'default', prompt: 'Follow the exact QA procedure in the user task. Treat a child result as usable only if status completed.' },
      { id: 'output', type: 'output', name: 'Result' },
    ],
    edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }],
    settings: { cwd, maxParallel: 1 },
  };
  await run(graph, 'This is an isolated end-to-end QA run. Use only attached Relay dynamic tools, not native shell, browser or MCP tools. Do not modify files except the requested result. You MUST call relay_delegate ONCE with two independent children alpha and beta. Assign alpha to read alpha.txt and beta to read beta.txt using relay_workspace action read. Each child must return the exact key and numeric value in its assigned file, with no other file reads. Wait for both child results, then use relay_workspace action write to create delegated-result.json with keys alpha, beta (the exact read keys), sum (the sum of numeric values) and source "live-relay-delegate". Do not read alpha.txt or beta.txt yourself. Finally report the path and sum. Do not call relay_control.');
  const artifact = JSON.parse(await readFile(path.join(cwd, 'delegated-result.json'), 'utf8'));
  const children = calls.filter(call => call.role === 'child'), parent = calls.find(call => call.role.startsWith('QA coordinator'));
  const delegation = parent?.toolCalls.filter(tool => tool.name === 'relay_delegate');
  const delegatedResults = delegation?.[0]?.result?.results || [];
  receipt.delegation = {
    artifact, childCount: children.length,
    singleDelegateCall: delegation?.length === 1 && delegation[0].success === true,
    childrenReadThroughRelay: children.length === 2 && children.every(call => workspaceReads(call).length === 1 && inputReads(call).length === 1 && inputReads(call)[0].success === true)
      && new Set(children.flatMap(inputReads).map(tool => path.basename(tool.arguments.path))).size === 2,
    parentDidNotReadInputs: Boolean(parent) && inputReads(parent).length === 0,
    distinctRuntimeThreads: new Set([parent?.threadId, ...children.map(call => call.threadId)]).size === 3,
    measuredChildReceipts: delegatedResults.length === 2 && delegatedResults.every(result => result.threadId && result.usage?.totalTokens > 0 && result.toolSummary?.completed > 0),
    relayToolsOnly: calls.every(call => call.events.filter(event => event.type === 'tool.result').every(event => event.tool.startsWith('relay_'))),
    artifactMatches: matchesArtifact(artifact, 'live-relay-delegate'),
  };
  if (Object.entries(receipt.delegation).some(([key, value]) => !['artifact', 'childCount'].includes(key) && value !== true)) throw Error('Live delegation evidence did not meet the QA contract.');
  await settings.update({ subagentsEnabled: false });
  const swarm = createSwarmWorkflow({ id: 'live-swarm', name: 'Live authenticated specialist swarm', cwd, members: 2, pattern: 'research' });
  swarm.nodes.filter(node => node.id.startsWith('specialist-')).forEach((node, index) => {
    node.prompt = `You are independent QA specialist ${index + 1}. Use relay_task read/describe/plan/step/checkpoint for your task outline, and only relay_workspace action read to inspect ${index === 0 ? 'alpha' : 'beta'}.txt. Return its exact key and numeric value. Do not read the other input. Do not modify files or call relay_control. Do not use native tools.`;
  });
  swarm.nodes.find(node => node.id === 'coordinator').prompt = 'Use the two upstream specialist results, then relay_workspace action write to create swarm-result.json with keys alpha and beta (their exact keys), sum (the sum of values) and source "live-specialist-swarm". Do not read either input file yourself. Do not use native tools. Finally report the saved path and sum.';
  const before = calls.length;
  await run(swarm, 'Run this isolated QA workflow. Each worker must follow its assigned file boundary, and the coordinator must combine both verified handoffs into the requested output file.');
  const swarmArtifact = JSON.parse(await readFile(path.join(cwd, 'swarm-result.json'), 'utf8'));
  const swarmCalls = calls.slice(before), workers = swarmCalls.filter(call => !call.role.startsWith('Synthesize'));
  const coordinator = swarmCalls.find(call => call.role.startsWith('Synthesize'));
  receipt.swarm = {
    artifact: swarmArtifact, workerCount: workers.length,
    overlap: workers.length === 2 && Date.parse(workers[0].startedAt) < Date.parse(workers[1].finishedAt) && Date.parse(workers[1].startedAt) < Date.parse(workers[0].finishedAt),
    artifactMatches: matchesArtifact(swarmArtifact, 'live-specialist-swarm'),
    workersReadThroughRelay: workers.length === 2 && workers.every(call => workspaceReads(call).length === 1 && inputReads(call).length === 1 && inputReads(call)[0].success === true),
    relayToolsOnly: swarmCalls.every(call => call.events.filter(event => event.type === 'tool.result').every(event => event.tool.startsWith('relay_'))),
    coordinatorDidNotReadInputs: Boolean(coordinator) && inputReads(coordinator).length === 0,
    coordinatorWaited: Date.parse(coordinator?.startedAt) >= Math.max(...workers.map(call => Date.parse(call.finishedAt))),
  };
  if (Object.entries(receipt.swarm).some(([key, value]) => !['artifact', 'workerCount'].includes(key) && value !== true)) throw Error('Live swarm evidence did not meet the QA contract.');
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = { message: error.message, code: error.code };
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  receipt.calls = calls;
  await engine.close();
  await settings.close();
  await runtime.close();
  await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ event: 'receipt', passed: receipt.passed, path: path.join(root, 'receipt.json'), error: receipt.error }));
}
