#!/usr/bin/env node
// Explicit, opt-in real-model comparison on fictional local files.
// Reviewer expectations remain outside the task workspaces.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { installNativeRequestRecorder } from './outcome-native-receipts.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i]?.startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Use --option value pairs.');
  options[args[i].slice(2)] = args[i + 1];
}
for (const key of Object.keys(options)) if (!['baseline', 'candidate', 'root', 'case-file', 'modes', 'ids', 'dependencies'].includes(key)) throw Error('Unknown option: ' + key);
if (!options.baseline || !options.candidate || !options.root) throw Error('Usage: node scripts/outcome-live-eval.mjs --baseline SOURCE --candidate SOURCE --root UNUSED_DIRECTORY [--modes on,off] [--ids CASE,CASE]');
const root = path.resolve(options.root);
const sources = { baseline: path.resolve(options.baseline), candidate: path.resolve(options.candidate) };
const modes = (options.modes || 'on').split(',');
if (!modes.length || modes.some(mode => !['on', 'off'].includes(mode)) || new Set(modes).size !== modes.length) throw Error('Planning modes must be on, off, or on,off.');
if (!options['case-file']) throw Error('Supply --case-file with an explicit local fixture file.');
const caseFile = path.resolve(options['case-file']);
const caseFileBytes = await fs.readFile(caseFile);
const allCases = JSON.parse(caseFileBytes.toString('utf8'));
const ids = options.ids ? options.ids.split(',') : allCases.map(item => item.id);
const cases = ids.map(id => {
  const item = allCases.find(value => value.id === id);
  if (!item || !/^[a-z0-9-]+$/.test(id)) throw Error('Unknown or invalid case: ' + id);
  if (typeof item.task !== 'string' || !item.task.trim() || !item.files || !Object.keys(item.files).length) throw Error('Case lacks task or evidence: ' + id);
  for (const [name, text] of Object.entries(item.files)) if (path.basename(name) !== name || typeof text !== 'string') throw Error('Invalid fixture file: ' + id + '/' + name);
  return item;
});
if (new Set(ids).size !== ids.length) throw Error('Duplicate case IDs.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
await fs.mkdir(path.dirname(root), { recursive: true });
await fs.mkdir(root); // Never overwrite an earlier experiment or start it twice.
const results = [], apps = {}, nativeRecorders = {};
let failure = null;
const log = async value => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n';
  await fs.appendFile(path.join(root, 'progress.jsonl'), line);
  process.stdout.write(line);
};
const saveStatus = async status => {
  const file = path.join(root, 'status.json'), temporary = file + '.tmp';
  await fs.writeFile(temporary, json({ status, updatedAt: new Date().toISOString(), failure, completed: results.length, planned: cases.length * modes.length * 2, results: results.map(({ events, plan, ...rest }) => rest) }));
  await fs.rename(temporary, file);
};
const snapshot = async (source, target) => {
  await fs.mkdir(target);
  for (const directory of ['lib', 'public']) await fs.cp(path.join(source, directory), path.join(target, directory), { recursive: true });
  for (const file of ['server.mjs', 'package.json']) await fs.copyFile(path.join(source, file), path.join(target, file));
  const files = {};
  async function walk(directory, relative = '') {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const key = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), key);
      else if (entry.isFile()) files[key] = hash(await fs.readFile(path.join(directory, entry.name)));
    }
  }
  await walk(target);
  const dependencies = await fs.realpath(options.dependencies || path.join(sources.baseline, 'node_modules'));
  await fs.symlink(dependencies, path.join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return { fingerprint: hash(json(files)), files, dependencies };
};
try {
  await saveStatus('preparing');
  const snapshots = {};
  for (const [variant, source] of Object.entries(sources)) snapshots[variant] = await snapshot(source, path.join(root, 'source-' + variant));
  const changedFiles = [...new Set([...Object.keys(snapshots.baseline.files), ...Object.keys(snapshots.candidate.files)])].filter(file => snapshots.baseline.files[file] !== snapshots.candidate.files[file]);
  const evaluator = {};
  for (const file of ['outcome-live-eval.mjs', 'outcome-native-receipts.mjs']) evaluator[file] = hash(await fs.readFile(new URL(file, import.meta.url)));
  await fs.writeFile(path.join(root, 'manifest.json'), json({ format: 2, sources, model: 'gpt-6-luna', effort: 'max', planningModes: modes, snapshots, changedFiles, evaluator, fixture: { path: caseFile, sha256: hash(caseFileBytes), bytes: caseFileBytes.length }, cases: cases.map(item => ({ id: item.id, task: item.task, taskSha256: hash(item.task), review: item.review, inputSha256: Object.fromEntries(Object.entries(item.files).map(([name, text]) => [name, hash(text)])) })) }));
  await fs.mkdir(path.join(root, 'native-requests'));
  for (const variant of Object.keys(sources)) {
    const source = path.join(root, 'source-' + variant);
    const { createHarnessServer } = await import(pathToFileURL(path.join(source, 'server.mjs')).href);
    const app = await createHarnessServer({ port: 0, dataDir: path.join(root, 'data', variant), defaultCwd: path.join(root, 'cases', variant), remoteAccess: false, maxConcurrentRuns: 1 });
    apps[variant] = app;
    nativeRecorders[variant] = installNativeRequestRecorder(app.runtime.codex, { file: path.join(root, 'native-requests', variant + '.jsonl') });
    await app.learning.updateSettings({ mode: 'manual' });
    await app.listen();
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const status = app.runtime.status();
      if (status.connected && status.authenticated) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const status = app.runtime.status();
    if (!status.connected || !status.authenticated) throw Error(variant + ' provider did not become available.');
  }
  await saveStatus('running');
  for (const mode of modes) for (const item of cases) {
    const pair = [];
    for (const variant of Object.keys(sources)) {
      const cwd = path.join(root, 'cases', variant, mode, item.id);
      await fs.mkdir(cwd, { recursive: true });
      for (const [name, text] of Object.entries(item.files)) await fs.writeFile(path.join(cwd, name), text);
      const source = path.join(root, 'source-' + variant);
      const { createMissionWorkflow } = await import(pathToFileURL(path.join(source, 'public', 'mission-model.mjs')).href);
      const workflow = createMissionWorkflow({ id: `outcome-${variant}-${mode}-${item.id}`, task: item.task, model: 'gpt-6-luna', effort: 'max', cwd, planningMode: mode });
      const app = apps[variant], started = app.engine.startRun({ workflow, input: { task: item.task, cwd, planningMode: mode } });
      pair.push({ variant, app, cwd, id: started.id });
      await log({ event: 'started', mode, case: item.id, variant, runId: started.id });
    }
    await Promise.all(pair.map(async ({ variant, app, cwd, id }) => {
      await app.engine.executions.get(id);
      const run = app.engine.getRun(id);
      let decision = null, artifactError = null;
      try { decision = JSON.parse(await fs.readFile(path.join(cwd, 'decision.json'), 'utf8')); } catch (error) { artifactError = error.message; }
      const inputIntegrity = {};
      for (const [name, text] of Object.entries(item.files)) {
        try { inputIntegrity[name] = hash(await fs.readFile(path.join(cwd, name))) === hash(text); } catch { inputIntegrity[name] = false; }
      }
      const recorder = nativeRecorders[variant];
      let nativeReceiptError = null;
      try { await recorder.flush(); } catch (error) { nativeReceiptError = error.message; }
      const nativeRequests = recorder.forCwd(cwd);
      const nativeReceiptIntegrity = {
        acceptedThreadWithInstructions: nativeRequests.some(record => ['thread/start', 'thread/resume'].includes(record.method) && record.status === 'fulfilled' && record.response?.threadId && typeof record.request.developerInstructions?.text === 'string'),
        acceptedTurnWithTask: nativeRequests.some(record => record.method === 'turn/start' && record.status === 'fulfilled' && record.response?.turnId && record.request.inputTexts?.some(input => input.text.includes(item.task))),
      };
      const instructionBudgets = Object.entries(run.nodes || {}).flatMap(([nodeId, node]) => node?.instructionBudget ? [{ nodeId, ...node.instructionBudget }] : []);
      const result = { case: item.id, mode, variant, runId: id, model: 'gpt-6-luna', effort: 'max', sourceFingerprint: snapshots[variant].fingerprint, status: run.status, settled: run.settled, startedAt: run.startedAt, finishedAt: run.finishedAt, elapsedMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt), output: run.output, decision, artifactError, inputIntegrity, instructionBudgets, nativeReceiptFile: recorder.file, nativeReceiptError, nativeReceiptIntegrity, nativeRequests, error: run.error, plan: run.taskState, events: run.events };
      await fs.writeFile(path.join(root, `${item.id}-${mode}-${variant}.json`), json(result));
      results.push(result);
      await log({ event: 'finished', mode, case: item.id, variant, runId: id, status: run.status, settled: run.settled, decision, artifactError, inputIntegrity });
    }));
    await saveStatus('running');
  }
  const complete = results.every(result => result.status === 'completed' && result.settled === true && !result.artifactError && Object.values(result.inputIntegrity).every(Boolean) && !result.nativeReceiptError && Object.values(result.nativeReceiptIntegrity).every(Boolean));
  await saveStatus(complete ? 'semantic_review_needed' : 'incomplete');
  if (!complete) process.exitCode = 1;
} catch (error) {
  failure = error.stack || String(error);
  await log({ event: 'failed', error: failure });
  await saveStatus('failed');
  process.exitCode = 1;
} finally {
  for (const app of Object.values(apps)) await app.close().catch(async error => log({ event: 'close_error', message: error.message }));
  for (const [variant, recorder] of Object.entries(nativeRecorders)) {
    try { await recorder.flush(); }
    catch (error) {
      failure ||= error.stack || String(error);
      process.exitCode = 1;
      await log({ event: 'native_receipt_error', variant, message: error.message });
      await saveStatus('failed');
    } finally { recorder.restore(); }
  }
}
