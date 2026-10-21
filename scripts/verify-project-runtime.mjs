/**
 * Opt-in live project acceptance check. Uses the authenticated native Codex runtime,
 * the real HTTP application, real workspace tools and separate implementation/review turns.
 * Usage: node scripts/verify-project-runtime.mjs --live [--output-dir ABSOLUTE_PATH] [--plan-from RECEIPT_PATH]
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexRuntime } from '../lib/codex.mjs';
import { createHarnessServer } from '../server.mjs';

const args = process.argv.slice(2), directoryIndex = args.indexOf('--output-dir'), planningIndex = args.indexOf('--plan-from'), requestedDirectory = directoryIndex < 0 ? null : args[directoryIndex + 1], planningReceipt = planningIndex < 0 ? null : args[planningIndex + 1];
if (!args.includes('--live') || args.some((arg, index) => !['--live', '--output-dir', '--plan-from'].includes(arg) && !(directoryIndex >= 0 && index === directoryIndex + 1) && !(planningIndex >= 0 && index === planningIndex + 1)) || [requestedDirectory, planningReceipt].some(value => value !== null && (!value || !path.isAbsolute(value)))) {
  console.error('This opt-in check uses real signed-in model calls. Usage: node scripts/verify-project-runtime.mjs --live [--output-dir ABSOLUTE_PATH] [--plan-from RECEIPT_PATH]'); process.exit(2);
}
const previousReceipt = planningReceipt ? JSON.parse(await readFile(planningReceipt, 'utf8')) : null;
if (previousReceipt && (previousReceipt.project?.status !== 'completed' || !previousReceipt.projectId || previousReceipt.calls?.length !== 6 || !path.isAbsolute(previousReceipt.root))) throw Error('Resume only a completed six-phase live project receipt.');
const outputDir = requestedDirectory || (planningReceipt ? path.dirname(planningReceipt) : await mkdtemp(path.join(tmpdir(), 'blackice-project-live-'))); await mkdir(outputDir, { recursive: true });
const root = previousReceipt?.root || path.join(outputDir, 'project-live-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)), cwd = path.join(root, 'workspace'), dataDir = path.join(root, 'profile'); await mkdir(cwd, { recursive: true });
const model = 'gpt-6.1-sol', seed = previousReceipt?.seed || { token: randomUUID(), first: 19, second: 23 }; if (!previousReceipt) await writeFile(path.join(cwd, 'seed.json'), JSON.stringify(seed));
const receipt = previousReceipt ? { ...previousReceipt, passed: false, planningStartedAt: new Date().toISOString() } : { schema: 1, live: true, model, startedAt: new Date().toISOString(), root, cwd, seed, passed: false, checks: {}, calls: [] };
class NoDesktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }
const runtime = new CodexRuntime({ cwd, runTimeoutMs: 180000, requestTimeoutMs: 30000 }), original = runtime.runAgent.bind(runtime);
runtime.runAgent = async options => {
  const call = { model: options.model, role: options.prompt.match(/^You are ([^\n]+)/)?.[1] || 'unknown', startedAt: new Date().toISOString(), tools: [], events: [] }; receipt.calls.push(call);
  try {
    const result = await original({ ...options, onToolCall: async (tool, context) => {
      let arguments_; try { arguments_ = typeof tool.arguments === 'string' ? JSON.parse(tool.arguments) : tool.arguments; } catch { arguments_ = null; }
      const record = { name: tool.name, arguments: arguments_ }; call.tools.push(record); const response = await options.onToolCall(tool, context); record.success = response.success;
      if (['relay_workspace', 'relay_project'].includes(tool.name)) { try { record.result = JSON.parse(response.contentItems?.[0]?.text); } catch {} } return response;
    }, onEvent: event => { if (event.type === 'thread' || event.type === 'tool.result') call.events.push(event); options.onEvent?.(event); } });
    Object.assign(call, { finishedAt: new Date().toISOString(), output: result.output, threadId: result.threadId, usage: result.usage }); return result;
  } catch (error) { call.error = { message: error.message, code: error.code }; throw error; }
};
let app, projectId, url, cookie;
const api = async (route, method = 'GET', value) => {
  const response = await fetch(new URL(route, url), { method, headers: { Cookie: cookie, ...(value === undefined ? {} : { 'Content-Type': 'application/json', Origin: url }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const data = await response.json(); if (!response.ok) throw Error(`${method} ${route}: ${response.status} ${data.error || JSON.stringify(data)}`); return data;
};
const check = (name, passed) => { receipt.checks[name] = Boolean(passed); if (!passed) throw Error('Live acceptance check failed: ' + name); };
try {
  const status = await runtime.start(); receipt.runtime = { connected: status.connected, authenticated: status.authenticated, version: status.version, defaultModel: status.defaultModel };
  check('authenticatedRuntime', status.connected && status.authenticated); check('requestedModelAvailable', status.models.some(item => (item.model || item.id) === model));
  app = await createHarnessServer({ port: 0, dataDir, defaultCwd: cwd, runtime, desktop: new NoDesktop(), autoAttachDesktop: false, maxConcurrentRuns: 1 });
  await app.learning.updateSettings({ mode: 'manual' }); await app.runtimeSettings.update({ subagentsEnabled: false, defaultEffort: 'low', runTimeoutMs: 180000, verbosity: 'concise' });
  url = await app.listen(); const home = await fetch(url); cookie = home.headers.get('set-cookie').split(';', 1)[0]; await home.arrayBuffer();
  if (!previousReceipt) {
  const definition = {
    name: 'Live verified capability ' + randomUUID().slice(0, 8), objective: 'Isolated end-to-end QA of implementation, independent rejection, repair, verified task dependencies, and capability reuse. All file reads and writes must use the attached relay_workspace tools only. Do not use native shell, browser, MCP, relay_control, or project tools. Read the actual seed.json; its random token is intentionally absent from these instructions. Modify only attempt-marker.txt, proof.json and dependent.json in this isolated folder.', cwd, model, verifierModel: model, maxRepairs: 1,
    tasks: [
      { id: 'proof', title: 'Produce proof, intentionally fail once, then repair', instructions: 'This is a controlled QA fixture. First inspect whether attempt-marker.txt exists using relay_workspace. If absent, write attempt-marker.txt containing first-attempt, and intentionally write proof.json as {"token":"intentional-qa-wrong","sum":0,"ready":false}. STOP that implementation turn after writing this intentional wrong result: the separate reviewer must reject it. If attempt-marker.txt already exists, this is the repair: read seed.json and write proof.json with its exact token, sum equal to seed.first + seed.second, and ready true. On the repair do not repeat the intentional failure. Report what you actually wrote. The first implementation is intentionally expected to fail acceptance; the reviewer must report that failure honestly.', acceptanceCriteria: ['proof.json has exactly the token from seed.json, sum equal to seed.first plus seed.second, and ready true.'], dependsOn: [] },
      { id: 'dependent', title: 'Use independently reviewed proof', instructions: 'Read proof.json and seed.json through relay_workspace. Confirm proof.ready is true, proof.token equals seed.token, and proof.sum is the sum of seed.first and seed.second. Write dependent.json with token copied from proof.token, sum copied from proof.sum, and fromVerifiedProof true. Do not modify proof.json or seed.json. Report the actual observed values and file written.', acceptanceCriteria: ['dependent.json has token and sum copied from the matching ready proof.json and seed.json, and fromVerifiedProof true.'], dependsOn: ['proof'] },
    ],
  };
  const project = await api('/api/projects', 'POST', definition); projectId = project.id; receipt.projectId = projectId; check('createdDraftWithoutCalls', project.status === 'draft' && receipt.calls.length === 0); await api(`/api/projects/${projectId}/start`, 'POST', {});
  const deadline = Date.now() + 10 * 60 * 1000; let signature = '';
  while (Date.now() < deadline) {
    const current = app.projects.get(projectId), nextSignature = JSON.stringify([current.status, current.tasks.map(task => [task.status, task.round, task.attempts.at(-1)?.implementation?.runId, task.attempts.at(-1)?.verification?.runId])]);
    if (signature !== nextSignature) { signature = nextSignature; console.log(JSON.stringify({ event: 'project-progress', status: current.status, tasks: current.tasks.map(task => ({ id: task.id, status: task.status, round: task.round, error: task.error })) })); }
    if (['completed', 'needs_attention'].includes(current.status)) break; await new Promise(resolve => setTimeout(resolve, 500));
  }
  const completed = await api(`/api/projects/${projectId}`); receipt.project = completed; check('projectCompleted', completed.status === 'completed');
  const [proofTask, dependentTask] = completed.tasks; check('firstVerifierActuallyRejected', proofTask.attempts.length === 2 && proofTask.attempts[0].verification?.verdict?.passed === false); check('boundedRepairPassed', proofTask.round === 1 && proofTask.attempts[1].verification?.verdict?.passed === true);
  const proof = JSON.parse(await readFile(path.join(cwd, 'proof.json'), 'utf8')), dependent = JSON.parse(await readFile(path.join(cwd, 'dependent.json'), 'utf8')); receipt.artifacts = { proof, dependent };
  check('randomTokenAndCalculationActuallyMatch', proof.token === seed.token && proof.sum === 42 && proof.ready === true && dependent.token === seed.token && dependent.sum === 42 && dependent.fromVerifiedProof === true);
  const verificationRun = app.engine.getRun(proofTask.attempts[1].verification.runId), downstreamRun = app.engine.getRun(dependentTask.attempts[0].implementation.runId); check('dependencyWaitedForVerification', Date.parse(downstreamRun.startedAt) >= Date.parse(verificationRun.finishedAt));
  const verifierThreadIds = completed.tasks.flatMap(task => task.attempts.map(attempt => app.engine.getRun(attempt.verification.runId).nodes.agent.threadId));
  const verifierCalls = receipt.calls.filter(call => verifierThreadIds.includes(call.threadId)); for (const call of verifierCalls) call.role = 'Independent verifier'; check('separateVerifierThreads', verifierCalls.length === 3 && new Set(receipt.calls.map(call => call.threadId)).size === 6);
  check('reviewersActuallyReadWorkspaceFiles', verifierCalls.every(call => call.tools.some(tool => tool.name === 'relay_workspace' && tool.arguments?.action === 'read' && tool.success === true)));
  check('allCallsUsedRequestedModel', receipt.calls.length === 6 && receipt.calls.every(call => call.model === model));
  const capability = await api('/api/capabilities', 'POST', { projectId, name: 'Live checked proof capability' }); receipt.capability = capability;
  const reused = await api(`/api/capabilities/${capability.id}/use`, 'POST', { cwd, name: 'Recheck proof capability in a fresh draft' }); receipt.reusedProject = reused;
  check('capabilityContainsActualVerificationRunIds', capability.evidence.length === 2 && capability.evidence.every(item => completed.tasks.find(task => task.id === item.taskId).verification.runId === item.verificationRunId));
  check('reuseIsUnverifiedDraftAndStartsNoWork', reused.id !== projectId && reused.status === 'draft' && reused.tasks.every(task => task.status === 'pending' && task.attempts.length === 0 && !task.verification) && receipt.calls.length === 6);
  } else {
    projectId = previousReceipt.projectId;
    const completed = await api(`/api/projects/${projectId}`); receipt.project = completed; check('projectCompleted', completed.status === 'completed');
    const verifierThreadIds = completed.tasks.flatMap(task => task.attempts.map(attempt => app.engine.getRun(attempt.verification.runId).nodes.agent.threadId)), verifierCalls = receipt.calls.filter(call => verifierThreadIds.includes(call.threadId));
    for (const call of verifierCalls) call.role = 'Independent verifier'; check('separateVerifierThreads', verifierCalls.length === 3 && new Set(receipt.calls.map(call => call.threadId)).size === 6);
    check('reviewersActuallyReadWorkspaceFiles', verifierCalls.every(call => call.tools.some(tool => tool.name === 'relay_workspace' && tool.arguments?.action === 'read' && tool.success === true)));
    check('allCallsUsedRequestedModel', receipt.calls.every(call => call.model === model));
    if (!receipt.capability) receipt.capability = await api('/api/capabilities', 'POST', { projectId, name: 'Live checked proof capability' });
    if (!receipt.reusedProject) receipt.reusedProject = await api(`/api/capabilities/${receipt.capability.id}/use`, 'POST', { cwd, name: 'Recheck proof capability in a fresh draft' });
    check('capabilityContainsActualVerificationRunIds', receipt.capability.evidence.length === 2 && receipt.capability.evidence.every(item => completed.tasks.find(task => task.id === item.taskId).verification.runId === item.verificationRunId));
    check('reuseIsUnverifiedDraftAndStartsNoWork', receipt.reusedProject.status === 'draft' && receipt.reusedProject.tasks.every(task => task.status === 'pending' && task.attempts.length === 0 && !task.verification) && receipt.calls.length === 6);
  }
  const beforeProjects = app.projects.list(), beforeCalls = receipt.calls.length;
  const collaborationWorkflow = { id: 'capability-collaboration-qa-' + randomUUID(), name: 'Live human-agent capability planning', nodes: [{ id: 'input', type: 'input', name: 'Request' }, { id: 'agent', type: 'agent', name: 'Capability planning collaborator', model, prompt: 'Collaborate on the shared project using the attached relay_project tool. Inspect actual project evidence first, then reuse the requested capability exactly once as a fresh draft. Do not start execution or alter any existing project.' }, { id: 'output', type: 'output', name: 'Planning receipt' }], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { cwd, maxParallel: 1 } };
  const planning = await api('/api/runs', 'POST', { workflow: collaborationWorkflow, input: { cwd, task: `Use relay_task read/describe/plan/step/checkpoint for the default task outline and relay_project for the requested project actions. First call relay_project action get with id ${projectId} and inspect its completed task criteria and review evidence. Then call action use_capability exactly ONCE with id ${receipt.capability.id}, name "Agent-created collaborative draft", and cwd ${JSON.stringify(cwd)}. This creates a draft only. Do not start any project, do not call any other project-changing action, do not use relay_control, and do not read/write files or use native tools. Finish by reporting the returned new project id and its draft status. Do not claim the new draft is verified.` } });
  await app.engine.executions.get(planning.id); const planningRun = app.engine.getRun(planning.id); receipt.planningRun = planningRun; check('ordinaryPlanningChatCompleted', planningRun.status === 'completed');
  const planningCall = receipt.calls.at(-1), projectTools = planningCall.tools.filter(tool => tool.name === 'relay_project'), inspections = projectTools.filter(tool => tool.arguments?.action === 'get' && tool.arguments.id === projectId), uses = projectTools.filter(tool => tool.arguments?.action === 'use_capability' && tool.arguments.id === receipt.capability.id);
  check('modelInspectedSharedProjectThroughTool', inspections.length >= 1 && inspections.every(tool => tool.success === true && tool.result?.id === projectId));
  check('modelReusedCapabilityThroughToolOnce', uses.length === 1 && uses[0].success === true);
  const newProjects = app.projects.list().filter(project => !beforeProjects.some(previous => previous.id === project.id)); receipt.agentCreatedProjects = newProjects;
  check('agentCreatedOneFreshUnverifiedDraft', newProjects.length === 1 && newProjects[0].id === uses[0].result.id && newProjects[0].status === 'draft' && newProjects[0].tasks.every(task => task.attempts.length === 0 && task.status === 'pending' && !task.verification));
  check('planningStartsNoImplementationWork', receipt.calls.length === beforeCalls + 1 && app.projects.get(projectId).status === 'completed' && app.engine.executionStatus().activeCount === 0);
  receipt.passed = true; delete receipt.error;
} catch (error) { receipt.error = { message: error.message, code: error.code }; process.exitCode = 1; if (app && projectId) receipt.project = app.projects.get(projectId); }
finally {
  if (app) await app.close().catch(error => { receipt.closeError = error.message; receipt.passed = false; process.exitCode = 1; }); else await runtime.close().catch(() => {});
  receipt.finishedAt = new Date().toISOString(); const target = path.join(outputDir, 'project-live-receipt.json'); try { await stat(target); await rename(target, path.join(outputDir, 'project-live-receipt.previous-' + Date.now() + '.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(target, JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ event: 'receipt', passed: receipt.passed, path: target, error: receipt.error }));
}
