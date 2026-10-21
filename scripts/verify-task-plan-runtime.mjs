/** Opt-in, bounded acceptance of the default outline through real native Codex.
 * Uses one model turn and a disposable profile/workspace; never opens the app. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexRuntime } from '../lib/codex.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { TaskStateStore, TASK_TOOL, TASK_SCHEMA_VERSION } from '../lib/task-state.mjs';
import { RuntimeSettingsStore } from '../lib/runtime-settings.mjs';
import { MethodStore } from '../lib/methods.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { appFingerprint } from './release-check.mjs';

const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');

export function parsePlanAcceptanceArguments(args) {
  const result = { live: false, model: 'gpt-6.1-sol', timeoutMs: 85000 };
  for (let index = 0; index < args.length; index++) {
    const key = args[index]; if (key === '--live') { result.live = true; continue; }
    const field = ({ '--output-dir': 'outputDir', '--model': 'model', '--timeout-ms': 'timeoutMs' })[key];
    if (!field || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('Use --live [--output-dir ABSOLUTE_PATH] [--model EXACT_MODEL] [--timeout-ms 15000..100000].');
    result[field] = field === 'timeoutMs' ? Number(args[++index]) : args[++index];
  }
  if (!result.live) throw Error('This acceptance uses one real signed-in model turn. Supply --live to run it.');
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 15000 || result.timeoutMs > 100000) throw Error('Use a timeout between 15000 and 100000 milliseconds.');
  if (result.outputDir && !path.isAbsolute(result.outputDir)) throw Error('The output directory must be absolute and new.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(result.model)) throw Error('Supply one exact model ID.');
  return result;
}

export function assessPlanAcceptance({ run, calls, artifact, expected, nativeTools = [], denied = [], rootBeforeModel = false }) {
  const steps = run?.taskState?.steps || [], actions = steps.filter(step => step.kind === 'action'), toolCalls = calls.flatMap(call => call.toolCalls || []);
  const planIndex = toolCalls.findIndex(call => call.name === 'relay_task' && call.arguments?.action === 'plan' && call.success === true);
  const writeIndex = toolCalls.findIndex(call => call.name === 'relay_workspace' && call.arguments?.action === 'write');
  const checks = {
    oneExactModelTurn: calls.length === 1 && calls[0].model === expected.model && calls[0].resolvedModel === expected.model && Boolean(calls[0].finishedAt),
    completedRun: run?.status === 'completed' && run.settled === true,
    initialRootWasHonest: rootBeforeModel,
    agentAuthoredPlan: run?.taskState?.planVersion === 1 && run.taskState.plan?.origin === 'agent' && run.taskState.plan.authoredBy?.runId === run.id,
    currentSchemaUsed: run?.nodes?.agent?.taskSchemaVersion === TASK_SCHEMA_VERSION && run.nodes.agent.planning?.status === 'recorded',
    plannedBeforeFileWrite: planIndex >= 0 && writeIndex > planIndex,
    manageableBranches: actions.length >= 3 && actions.length <= 20 && steps.some(step => ['sequence','parallel','choice'].includes(step.kind)) && actions.some(step => step.parentId),
    evidenceForCompletedActions: actions.some(step => step.status === 'done') && actions.filter(step => step.status === 'done').every(step => Boolean(step.doneWhen?.trim()) && Boolean(step.evidence?.trim())),
    explicitPlanCompletion: run?.taskState?.progress?.complete === true,
    originalInputsRead: ['alpha.json','beta.json'].every(name => toolCalls.some(call => call.name === 'relay_workspace' && call.arguments?.action === 'read' && path.basename(call.arguments.path || '') === name && call.success === true)),
    savedResultReadBack: toolCalls.some(call => call.name === 'relay_workspace' && call.arguments?.action === 'read' && path.basename(call.arguments.path || '') === 'result.json' && call.success === true),
    correctResult: artifact?.decision === 'combined' && artifact.currency === 'USD' && artifact.total === 42 && Array.isArray(artifact.sourceTokens) && artifact.sourceTokens.length === 2 && [...artifact.sourceTokens].sort().join('|') === [...expected.tokens].sort().join('|'),
    registeredActualResult: run?.taskState?.artifacts?.some(item => item.fileName === 'result.json' && /^[a-f0-9]{64}$/.test(item.sha256)) === true,
    onlyRequestedToolWork: nativeTools.length === 0 && denied.length === 0 && toolCalls.every(call => ['relay_task','relay_workspace'].includes(call.name)),
  };
  return { checks, passed: Object.values(checks).every(Boolean) };
}

export async function runPlanAcceptance(options) {
  if (!options.live) throw Error('Live acceptance was not authorized.');
  const root = options.outputDir || await fs.mkdtemp(path.join(tmpdir(), 'blackice-plan-acceptance-'));
  if (options.outputDir) await fs.mkdir(root, { recursive: false });
  const owned = path.join(root, 'owned-fixture'), cwd = path.join(owned, 'workspace'), dataDir = path.join(owned, 'profile');
  await fs.mkdir(cwd, { recursive: true });
  const tokens = [randomUUID(), randomUUID()];
  await fs.writeFile(path.join(cwd, 'alpha.json'), JSON.stringify({ token: tokens[0], currency: 'USD', amount: 17 }));
  await fs.writeFile(path.join(cwd, 'beta.json'), JSON.stringify({ token: tokens[1], currency: 'USD', amount: 25 }));
  const receipt = { format: 1, product: 'BLACKICE', live: true, platform: process.platform, expected: { model: options.model, tokens }, startedAt: new Date().toISOString(), requestedModel: options.model, timeoutMs: options.timeoutMs, sourceDirectory: candidate, outputDirectory: root, calls: [], nativeTools: [], denied: [], passed: false, modelRuntimeClosed: false, fixtureRemoved: false, rootBeforeModel: false, appFingerprintBefore: await appFingerprint(candidate) };
  receipt.version = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'))).version;
  receipt.taskSchemaSha256 = hash(JSON.stringify(TASK_TOOL));
  const sourceFiles = ['lib/planning-policy.mjs','lib/harness-identity.mjs','public/planning-mode.mjs','lib/engine.mjs','lib/task-state.mjs','lib/task-plan.mjs','lib/methods.mjs','lib/process-ontology.mjs','lib/tool-routing.mjs','lib/codex.mjs','public/mission-model.mjs','scripts/verify-task-plan-runtime.mjs'];
  receipt.runtimeSources = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name, hash(await fs.readFile(path.join(candidate, name)))])));
  let runtime, engine, tasks, methods, settings, child, deadline, result, artifact;
  try {
    runtime = new CodexRuntime({ cwd, runTimeoutMs: options.timeoutMs, requestTimeoutMs: 20000, approvalTimeoutMs: 15000 });
    tasks = await new TaskStateStore({ dataDir }).init();
    methods = await new MethodStore({ dataDir, projects: { definition() { throw Error('This acceptance does not create projects.'); }, create() { throw Error('This acceptance does not create projects.'); } } }).init();
    settings = await new RuntimeSettingsStore({ dataDir }).init(); await settings.update({ subagentsEnabled: false, runTimeoutMs: options.timeoutMs, verbosity: 'concise' });
    engine = new HarnessEngine({ runtime, tasks, methods, dataDir, defaultCwd: cwd }); engine.runtimeSettings = settings; engine.methods = methods; await engine.init();
    const nativeRun = runtime.runAgent.bind(runtime);
    runtime.runAgent = async options => {
      const scaffold = [...engine.runs.values()].at(-1)?.taskState;
      receipt.rootBeforeModel = scaffold?.plan?.origin === 'runtime' && scaffold.steps.length === 0 && scaffold.progress.done === 0;
      const call = { model: options.model, startedAt: new Date().toISOString(), taskToolSchemaSha256: hash(JSON.stringify(options.dynamicTools?.find(tool => tool.name === 'relay_task'))), toolCalls: [] }; receipt.calls.push(call);
      try {
        const actual = await nativeRun({ ...options,
          onToolCall: async (tool, context) => {
            const args = typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : tool.arguments;
            const entry = { name: tool.name, arguments: args, startedAt: new Date().toISOString() }; call.toolCalls.push(entry);
            const file = typeof args?.path === 'string' ? path.resolve(cwd, args.path) : null;
            const scopedCwd = args?.cwd === undefined || typeof args.cwd === 'string' && path.resolve(args.cwd) === cwd;
            const allowedFile = scopedCwd && file && path.dirname(file) === cwd && ['alpha.json','beta.json','result.json'].includes(path.basename(file));
            const allowed = tool.name === 'relay_task' && ['read','describe','plan','step','checkpoint','artifact'].includes(args.action) && (args.action !== 'artifact' || allowedFile && path.basename(file) === 'result.json') || tool.name === 'relay_workspace' && allowedFile && ['read','write'].includes(args.action) && (args.action !== 'write' || path.basename(file) === 'result.json');
            if (!allowed) { receipt.denied.push(entry); entry.success = false; return { success: false, contentItems: [{ type: 'inputText', text: 'The QA request permits task planning plus reads of alpha.json, beta.json and result.json, and writing/registering result.json only. Continue within that scope.' }] }; }
            const response = await options.onToolCall(tool, context); entry.success = response.success; entry.finishedAt = new Date().toISOString();
            if (!response.success) entry.error = response.contentItems?.find(item => item.type === 'inputText')?.text;
            return response;
          },
          onEvent: event => { if (event.type === 'thread') { call.threadId = event.threadId; call.resolvedModel = event.model; } if (event.type === 'tool.result' && event.tool && !event.tool.startsWith('relay_')) receipt.nativeTools.push({ tool: event.tool, status: event.status }); options.onEvent?.(event); }
        });
        Object.assign(call, { finishedAt: new Date().toISOString(), threadId: actual.threadId, usage: actual.usage, output: actual.output }); return actual;
      } catch (error) { call.error = { message: error.message, code: error.code }; throw error; }
    };
    const status = await runtime.start(); child = runtime.child; receipt.ownedRuntimePid = child?.pid;
    assert.equal(status.authenticated, true, 'The existing native account must be signed in.');
    const available = status.models.some(model => model.id === options.model || model.model === options.model); assert.equal(available, true, 'The selected exact model must be advertised by this connection.');
    const input = 'Compare the two local summaries in alpha.json and beta.json. Their independent source readings can be handled separately. If their currencies agree, combine the amounts; otherwise explain why a combined total is inappropriate. Save result.json with decision (combined or incompatible), currency, total, and sourceTokens as a two-element JSON array of strings containing the exact token from each source. Read the saved file back, check all fields against the actual inputs, and register it as the deliverable. Keep the outcome concise. This is an isolated acceptance task: use only attached relay_task planning/continuity tools and relay_workspace read/write. Do not use native tools, shell, network, other files, subagents, projects, or external services. Only result.json may be written. ';
    const workflow = createMissionWorkflow({ task: input, model: options.model, effort: 'low', cwd, id: 'default-outline-acceptance', planDetail: 'detailed' });
    workflow.nodes.find(node => node.id === 'agent').sandbox = 'read-only';
    result = engine.startRun({ workflow, input: { task: input, cwd, planDetail: 'detailed' }, requestId: 'one-live-outline-acceptance' }); receipt.runId = result.id;
    deadline = setTimeout(() => { receipt.deadlineReached = true; try { engine.cancelRun(result.id); } catch (error) { receipt.cancelError = error.message; } }, options.timeoutMs + 1000);
    await engine.executions.get(result.id); result = engine.getRun(result.id);
    receipt.run = result;
    const bytes = await fs.readFile(path.join(cwd, 'result.json')); artifact = JSON.parse(bytes); receipt.artifact = artifact; receipt.artifactSha256 = hash(bytes);
    const assessed = assessPlanAcceptance({ run: result, calls: receipt.calls, artifact, expected: { model: options.model, tokens }, nativeTools: receipt.nativeTools, denied: receipt.denied, rootBeforeModel: receipt.rootBeforeModel });
    Object.assign(receipt, assessed);
    receipt.checks.exactArtifactHash = result.taskState.artifacts.some(item => item.fileName === 'result.json' && item.sha256 === receipt.artifactSha256);
    receipt.checks.exactSchema = receipt.calls.every(call => call.taskToolSchemaSha256 === receipt.taskSchemaSha256);
    receipt.passed = Object.values(receipt.checks).every(Boolean);
  } catch (error) { receipt.passed = false; receipt.error = { message: error.message, code: error.code }; if (engine && result?.id) receipt.run = engine.getRun(result.id); }
  finally {
    clearTimeout(deadline);
    for (const [name, close] of [['engine', () => engine?.close()], ['methods', () => methods?.close()], ['taskState', () => tasks?.close()], ['settings', () => settings?.close()], ['runtime', () => runtime?.close()]]) {
      try { await close(); } catch (error) { (receipt.cleanupErrors ||= []).push({ component: name, message: error.message }); }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const until = Date.now() + 5000; while (Date.now() < until && child.exitCode === null && child.signalCode === null) await delay(50);
    }
    receipt.modelRuntimeClosed = Boolean(child) && (child.exitCode !== null || child.signalCode !== null);
    try { assert.equal(path.dirname(owned), root); assert.equal(path.basename(owned), 'owned-fixture'); await fs.rm(owned, { recursive: true, force: true, maxRetries: 6, retryDelay: 180 }); receipt.fixtureRemoved = true; }
    catch (error) { (receipt.cleanupErrors ||= []).push({ component: 'fixture', message: error.message }); }
    receipt.appFingerprintAfter = await appFingerprint(candidate); receipt.unchangedDuringCheck = receipt.appFingerprintBefore === receipt.appFingerprintAfter;
    receipt.finishedAt = new Date().toISOString(); receipt.passed = receipt.passed && receipt.unchangedDuringCheck && receipt.modelRuntimeClosed && receipt.fixtureRemoved && !receipt.cleanupErrors?.length;
    await fs.writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ passed: receipt.passed, receipt: path.join(root, 'receipt.json'), checks: receipt.checks, error: receipt.error, modelRuntimeClosed: receipt.modelRuntimeClosed, fixtureRemoved: receipt.fixtureRemoved }));
  }
  if (!receipt.passed) process.exitCode = 1;
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) Promise.resolve().then(() => runPlanAcceptance(parsePlanAcceptanceArguments(process.argv.slice(2)))).catch(error => { console.log(JSON.stringify({ passed: false, error: error.message })); process.exitCode = 1; });
