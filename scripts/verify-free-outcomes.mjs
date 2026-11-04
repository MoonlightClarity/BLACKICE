#!/usr/bin/env node
// Opt-in compatible-API behavior evaluation on isolated fictional local files.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createFreeEvaluationRuntime, FREE_MODEL, FREE_MODEL_ID, FREE_EVALUATION_BUDGETS, observedFreeEvaluationBudgets } from './verify-free-advocacy.mjs';
import { snapshotOutcomeSources } from './outcome-eval-support.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const timeoutMs = FREE_EVALUATION_BUDGETS.caseTimeoutMs, planningMode = 'forced', effort = 'default';
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => structuredClone(value);
const errorDetails = error => ({ message: error.message, code: error.code, stack: error.stack });

export function parseFreeOutcomeOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--live') { if (options.live) throw Error('Duplicate --live.'); options.live = true; continue; }
    if (!['--output-dir', '--case-file', '--ids'].includes(name) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Unknown or incomplete option: ' + name);
    if (options[name]) throw Error('Duplicate option: ' + name);
    options[name] = args[++i];
  }
  if (!options.live) throw Error('Explicitly opt in with --live --output-dir NEW_ABSOLUTE_DIRECTORY --case-file FILE [--ids id,id].');
  if (!options['--output-dir'] || !path.isAbsolute(options['--output-dir'])) throw Error('Supply a new absolute output directory.');
  if (!options['--case-file']) throw Error('Supply --case-file.');
  return { root: path.resolve(options['--output-dir']), caseFile: path.resolve(options['--case-file']), ids: options['--ids']?.split(',') };
}

export function selectOutcomeCases(allCases, ids) {
  if (!Array.isArray(allCases) || !allCases.length) throw Error('The case file must contain a nonempty array.');
  const seen = new Set();
  for (const item of allCases) {
    if (!item || typeof item.id !== 'string' || !/^[a-z0-9-]+$/.test(item.id) || seen.has(item.id)) throw Error('Case IDs must be unique lowercase letters, digits and hyphens.');
    seen.add(item.id);
    if (typeof item.task !== 'string' || !item.task.trim() || !item.files || Array.isArray(item.files) || !Object.keys(item.files).length) throw Error('Case lacks a task or source files: ' + item.id);
    for (const [name, text] of Object.entries(item.files)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(name) || name.toLowerCase() === 'decision.json' || typeof text !== 'string') throw Error('Invalid fixture file: ' + item.id + '/' + name);
    }
  }
  const selected = ids || allCases.map(item => item.id);
  if (!selected.length || new Set(selected).size !== selected.length) throw Error('Select unique case IDs.');
  return selected.map(id => { const item = allCases.find(value => value.id === id); if (!item) throw Error('Unknown case: ' + id); return item; });
}

export function allowsFixtureTool(tool, args, cwd, files) {
  if (tool === 'relay_task') return true;
  if (tool !== 'relay_workspace' || !args || typeof args !== 'object') return false;
  if (args.cwd !== undefined && (typeof args.cwd !== 'string' || path.resolve(cwd, args.cwd) !== cwd)) return false;
  if (args.path !== undefined && typeof args.path !== 'string') return false;
  const target = path.resolve(cwd, args.path || '.'), decision = path.join(cwd, 'decision.json');
  const known = [decision, ...Object.keys(files).map(name => path.join(cwd, name))];
  if (['write', 'patch'].includes(args.action)) return target === decision;
  if (args.action === 'read') return known.includes(target);
  return ['list', 'search'].includes(args.action) && (target === cwd || known.includes(target));
}

export async function loadOutcomeModules(snapshot) {
  const [server, mission] = await Promise.all([
    import(pathToFileURL(path.join(snapshot, 'server.mjs')).href),
    import(pathToFileURL(path.join(snapshot, 'public', 'mission-model.mjs')).href),
  ]);
  return { createHarnessServer: server.createHarnessServer, createMissionWorkflow: mission.createMissionWorkflow };
}

export function planningServiceEvidence(app) {
  return {
    taskViabilityAttached: app.engine.taskViability === app.taskViability && typeof app.taskViability?.forRun === 'function',
    responseCycleAttached: app.engine.responseCycle === app.responseCycle && typeof app.responseCycle?.forRun === 'function',
    planningRuntimeAttached: app.taskViability?.runner === app.planningBrowserRuntime && app.responseCycle?.runner === app.planningBrowserRuntime,
    planningStoreAttached: app.taskViability?.store === app.planningBrowser && app.responseCycle?.store === app.planningBrowser,
    serverListening: app.server.listening,
  };
}

export async function createOutcomeApp({ setup, modules, root }) {
  // Construct production services, but never listen: listen() starts native runtime.
  const app = await modules.createHarnessServer({ runtime: setup.runtime, port: 0, dataDir: path.join(root, 'harness-profile'),
    defaultCwd: path.join(root, 'cases'), remoteAccess: false, maxConcurrentRuns: 1, autoAttachDesktop: false });
  try {
    await app.runtimeSettings.update({ subagentsEnabled: false, runTimeoutMs: FREE_EVALUATION_BUDGETS.runTimeoutMs, verbosity: 'concise' });
    await app.learning.updateSettings({ mode: 'manual' });
    const services = planningServiceEvidence(app);
    if (!services.taskViabilityAttached || !services.responseCycleAttached || !services.planningRuntimeAttached || !services.planningStoreAttached || services.serverListening) throw Error('Production Planning services must be attached without listening.');
    return app;
  } catch (error) { await app.close(); throw error; }
}

export async function runFreeOutcomeCase({ setup, app, modules, root, item, sourceFingerprint }) {
  const cwd = path.join(root, 'cases', item.id, 'workspace'), { engine } = app;
  await fs.mkdir(cwd, { recursive: true });
  for (const [name, text] of Object.entries(item.files)) await fs.writeFile(path.join(cwd, name), text, { flag: 'wx' });
  const { runtime } = setup, original = runtime.runAgent, calls = [], requestStart = setup.requests.length;
  let runId, timer, executionError = null, timedOut = false;
  runtime.runAgent = async options => {
    const call = { startedAt: new Date().toISOString(), kind: options.responseOnly === true ? 'response-only' : 'execution', model: options.model, effort: options.effort, cwd: options.cwd, prompt: options.prompt, developerInstructions: options.developerInstructions, outputSchema: copy(options.outputSchema), tools: copy(options.dynamicTools), toolCalls: [], events: [] };
    calls.push(call);
    try {
      const result = await Reflect.apply(original, runtime, [{
        ...options,
        // Response-only Planning modules retain their production no-tools handler.
        onToolCall: options.responseOnly === true ? options.onToolCall : async (tool, context) => {
          const record = { at: new Date().toISOString(), name: tool.name, arguments: copy(tool.arguments) };
          call.toolCalls.push(record);
          try {
            const args = typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : tool.arguments;
            if (!allowsFixtureTool(tool.name, args, cwd, item.files)) {
              record.deniedByFixture = true;
              record.response = { success: false, code: 'FIXTURE_SCOPE', contentItems: [{ type: 'inputText', text: 'This isolated local case permits relay_task, reading its supplied files, and writing or patching decision.json. Commands, outside paths and external integrations are unavailable.' }] };
            } else record.response = await options.onToolCall(tool, context);
            return record.response;
          } catch (error) { record.error = errorDetails(error); throw error; }
        },
        onEvent: event => { call.events.push(copy(event)); options.onEvent?.(event); },
      }]);
      call.output = result.output; call.threadId = result.threadId; call.usage = result.usage;
      return result;
    } catch (error) { call.error = errorDetails(error); throw error; }
    finally { call.finishedAt = new Date().toISOString(); }
  };
  try {
    const workflow = modules.createMissionWorkflow({ id: 'free-outcome-' + item.id, task: item.task, model: setup.model, effort, cwd, planningMode });
    const started = engine.startRun({ workflow, input: item.task, planningMode });
    runId = started.id;
    timer = setTimeout(() => { timedOut = true; engine.cancelRun(runId); }, timeoutMs);
    await engine.executions.get(runId);
  } catch (error) { executionError = errorDetails(error); }
  finally {
    clearTimeout(timer);
    runtime.runAgent = original;
  }
  await setup.flush();
  const run = runId ? engine.getRun(runId) : null;
  const planningRequests = [], planningCaptureErrors = [];
  for (const id of new Set([run?.responseCycle?.requestId, run?.viability?.requestId].filter(Boolean))) {
    try { planningRequests.push(await app.planningBrowser.get(id)); }
    catch (error) { planningCaptureErrors.push({ requestId: id, ...errorDetails(error) }); }
  }
  const planning = { selectedMode: planningMode, savedMode: run?.planningMode ?? null, enforcement: run?.planningEnforcement ?? null,
    planningGuardrails: run?.runtimeSettings?.planningGuardrails ?? null, executionGuardrails: run?.runtimeSettings?.executionGuardrails ?? null,
    executionMode: run?.planningExecutionMode ?? null, services: planningServiceEvidence(app) };
  let decision = null, decisionText = null, artifactError = null;
  try { decisionText = await fs.readFile(path.join(cwd, 'decision.json'), 'utf8'); decision = JSON.parse(decisionText); }
  catch (error) { artifactError = error.message; }
  const inputSha256 = {}, inputIntegrity = {};
  for (const [name, text] of Object.entries(item.files)) {
    let actual = null; try { actual = hash(await fs.readFile(path.join(cwd, name))); } catch {}
    inputSha256[name] = { expected: hash(text), actual }; inputIntegrity[name] = actual === hash(text);
  }
  const requests = setup.requests.slice(requestStart), inference = requests.filter(request => request.method === 'POST');
  const apiReceiptIntegrity = {
    http200Response: inference.some(request => request.response?.status === 200),
    completedExecution: calls.some(call => call.kind === 'execution' && !call.error && call.finishedAt && typeof call.output === 'string'),
    exactModel: inference.length > 0 && inference.every(request => request.request?.model === setup.modelId),
    instructionsDelivered: inference.some(request => request.request?.messages?.some(message => message.role === 'system' && typeof message.content === 'string' && message.content.includes(calls.find(call => call.kind === 'execution')?.developerInstructions || '\u0000'))),
    taskDelivered: inference.some(request => request.request?.messages?.some(message => typeof message.content === 'string' && message.content.includes(item.task))),
    noCredentials: requests.every(request => !(request.headerNames || []).some(name => ['authorization', 'api-key', 'x-api-key', 'cookie'].includes(name.toLowerCase()))),
    captureComplete: requests.every(request => !request.captureError),
    noNativeCalls: setup.native.startCalls === 0 && setup.native.runCalls === 0,
  };
  return { format: 1, case: item.id, transport: 'compatible-api', native: false, model: setup.model, modelId: setup.modelId, effort, planningMode, timeoutMs, budgets: observedFreeEvaluationBudgets(requests),
    cwd, sourceFingerprint, taskSha256: hash(item.task), runId, status: run?.status || 'failed', settled: run?.settled || false,
    startedAt: run?.startedAt, finishedAt: run?.finishedAt, output: run?.output, error: run?.error || executionError, executionError, timedOut,
    decision, decisionText, decisionSha256: decisionText === null ? null : hash(decisionText), artifactError, inputSha256, inputIntegrity,
    planning, responseCycle: run?.responseCycle, viability: run?.viability, planningRequests, planningCaptureErrors,
    plan: run?.taskState, runtimeSettings: run?.runtimeSettings, events: run?.events, nodes: run?.nodes, calls, usage: calls.map(call => ({ kind: call.kind, threadId: call.threadId, usage: call.usage })),
    apiRequests: requests, apiReceiptIntegrity, responseModelIds: [...new Set(requests.flatMap(request => request.responseModelIds || []))],
    evidenceStatus: 'semantic_review_needed', behavioralResult: 'not_assessed' };
}

async function main(args) {
  const { root, caseFile, ids } = parseFreeOutcomeOptions(args), fixtureBytes = await fs.readFile(caseFile);
  const cases = selectOutcomeCases(JSON.parse(fixtureBytes.toString('utf8')), ids);
  await fs.mkdir(path.dirname(root), { recursive: true });
  await fs.mkdir(root); // Refuse reuse, including accidental duplicate execution.
  const report = { format: 1, transport: 'compatible-api', native: false, model: FREE_MODEL, modelId: FREE_MODEL_ID, effort, planningMode, timeoutMs, budgets: FREE_EVALUATION_BUDGETS,
    startedAt: new Date().toISOString(), status: 'preparing', behavioralResult: 'not_assessed', results: [] };
  let setup, app;
  const save = () => fs.writeFile(path.join(root, 'report.json'), json(report));
  try {
    await save();
    const { snapshots } = await snapshotOutcomeSources({ sources: { candidate: sourceRoot }, root, dependencies: path.join(sourceRoot, 'node_modules') });
    const modules = await loadOutcomeModules(path.join(root, 'source-candidate'));
    const evaluator = {};
    for (const file of ['verify-free-outcomes.mjs', 'verify-free-advocacy.mjs', 'verify-luna-advocacy.mjs', 'outcome-eval-support.mjs']) evaluator[file] = hash(await fs.readFile(new URL(file, import.meta.url)));
    await fs.writeFile(path.join(root, 'manifest.json'), json({
      sourceRoot, snapshots, evaluator, providerRuntimeSource: 'ProviderRuntime is imported from the original source tree by verify-free-advocacy.mjs; createHarnessServer, production services and workflow use source-candidate.',
      fixture: { path: caseFile, sha256: hash(fixtureBytes), bytes: fixtureBytes.length },
      cases: cases.map(item => ({ id: item.id, task: item.task, taskSha256: hash(item.task), review: item.review, inputSha256: Object.fromEntries(Object.entries(item.files).map(([name, text]) => [name, hash(text)])) })),
    }));
    setup = await createFreeEvaluationRuntime({ root });
    app = await createOutcomeApp({ setup, modules, root });
    report.planningServices = planningServiceEvidence(app);
    report.catalog = setup.catalog; report.sourceFingerprint = snapshots.candidate.fingerprint; report.status = 'running';
    await save();
    for (const item of cases) {
      console.log(JSON.stringify({ event: 'started', case: item.id, model: setup.model, budgets: FREE_EVALUATION_BUDGETS }));
      const result = await runFreeOutcomeCase({ setup, app, modules, root, item, sourceFingerprint: snapshots.candidate.fingerprint });
      const complete = result.status === 'completed' && result.settled && !result.timedOut && !result.artifactError && !result.executionError && !result.planningCaptureErrors.length && result.planning.enforcement === 'forced' && result.planning.planningGuardrails === true && Object.values(result.inputIntegrity).every(Boolean) && Object.values(result.apiReceiptIntegrity).every(Boolean);
      result.evidenceStatus = complete ? 'semantic_review_needed' : 'incomplete';
      await fs.writeFile(path.join(root, item.id + '.json'), json(result));
      report.budgets = observedFreeEvaluationBudgets(setup.requests);
      report.results.push({ case: item.id, budgets: result.budgets, runId: result.runId, status: result.status, settled: result.settled, evidenceStatus: result.evidenceStatus, artifactError: result.artifactError, planning: result.planning, responseCycleState: result.responseCycle?.state, planningCaptureErrors: result.planningCaptureErrors, inputIntegrity: result.inputIntegrity, apiReceiptIntegrity: result.apiReceiptIntegrity });
      await save();
      console.log(JSON.stringify({ event: 'finished', case: item.id, status: result.status, evidenceStatus: result.evidenceStatus }));
    }
    report.status = report.results.every(result => result.evidenceStatus === 'semantic_review_needed') ? 'semantic_review_needed' : 'incomplete';
    if (report.status === 'incomplete') process.exitCode = 1;
  } catch (error) { report.status = 'failed'; report.error = errorDetails(error); process.exitCode = 1; }
  finally {
    try { if (app) await app.close(); else await setup?.runtime.close(); await setup?.flush(); }
    catch (error) { report.status = 'failed'; report.closeError = errorDetails(error); process.exitCode = 1; }
    if (setup) {
      report.budgets = observedFreeEvaluationBudgets(setup.requests);
      report.nativeCalls = setup.native;
      report.inferenceRequests = setup.requests.filter(request => request.method === 'POST').length;
      report.responseModelIds = [...new Set(setup.requests.flatMap(request => request.responseModelIds || []))];
      await fs.writeFile(path.join(root, 'api-requests.json'), json(setup.requests));
    }
    report.finishedAt = new Date().toISOString();
    await save();
    console.log(JSON.stringify({ event: 'report', status: report.status, path: path.join(root, 'report.json'), error: report.error }));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
}
