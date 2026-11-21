import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processRun } from './workspace-tools.mjs';
import { parseBenchmarkWorkspaceCall as parseCall } from './benchmark-workspace-contract.mjs';
export { BENCHMARK_WORKSPACE_TOOL } from './benchmark-workspace-contract.mjs';
import { describeHostOperation, normalizeHostOperationResult } from './operation-descriptors.mjs';
import {
  BENCHMARK_FILES, BENCHMARK_COMMAND, BENCHMARK_LIMITS, benchmarkError, benchmarkHash, benchmarkContractHash,
  assertBenchmarkIntegrity, benchmarkSourceSnapshot, readBenchmarkFile, resolveBenchmarkPath,
} from './benchmark-profile.mjs';

export const BENCHMARK_WORKSPACE_INSTRUCTIONS = '\nBENCHMARK FILE CAPABILITY\nThis run uses the explicit minicpm-code-v1 benchmark profile. Only relay_directory_action and relay_workspace are attached. The benchmark workspace tool accepts task-relative paths with forward slashes; no absolute path, parent traversal, cwd override or outside discovery is available. Read the fixed task files and implementation. Change only .cjs files under src. Run exactly node test-public.cjs and inspect its actual exit status and report. General descriptions of unrestricted workspace access do not apply to this selected capability. The controller grades the saved source separately.\n';
const check = signal => { if (signal?.aborted) throw Object.assign(benchmarkError('ABORT_ERR', 'Benchmark action cancelled.'), { name: 'AbortError' }); };
const response = (value, success = true) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const denial = (error, dispatched = false) => {
  const value = { error: error.message, code: error.code || 'BENCHMARK_ERROR', actionDispatched: dispatched,
    ...(error.launch ? { launch: error.launch, recovery: error.recovery } : {}) };
  return { ...response(value, false), code: value.code, actionDispatched: dispatched };
};

/** Node is resolved by the host, never through a model-supplied shell command. */
export function benchmarkNodeExecutable(explicit) {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !path.isAbsolute(explicit) || !fs.statSync(explicit).isFile())
      throw benchmarkError('BENCHMARK_NODE_UNAVAILABLE', 'A host-owned absolute Node executable is required.');
    return fs.realpathSync.native(explicit);
  }
  if (!process.versions.electron) return fs.realpathSync.native(process.execPath);
  const key = Object.keys(process.env).find(name => name.toUpperCase() === 'PATH');
  for (const directory of (process.env[key] || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
    try { if (fs.statSync(candidate).isFile()) return fs.realpathSync.native(candidate); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw benchmarkError('BENCHMARK_NODE_UNAVAILABLE', 'The benchmark requires an installed Node executable; no alternate shell or Electron launch was attempted.');
}

/** Absolute Node and worker paths need no PATH, COMSPEC, credentials or NODE_OPTIONS. */
export function benchmarkChildEnvironment() {
  const env = {};
  if (process.platform === 'win32') for (const name of ['SystemRoot', 'WINDIR']) {
    const key = Object.keys(process.env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
    if (key && process.env[key]) env[name] = process.env[key];
  }
  return env;
}

function readResult(profile, args) {
  const bytes = readBenchmarkFile(profile, args.path);
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw benchmarkError('BENCHMARK_UTF8', 'The benchmark file is not valid UTF-8.'); }
  const lines = text.split(/\r?\n/), startLine = args.startLine ?? 1, count = args.lineCount ?? 200;
  if (startLine > lines.length) throw benchmarkError('BENCHMARK_READ_RANGE', 'The requested line starts beyond the file.');
  const page = { path: resolveBenchmarkPath(profile, args.path), size: bytes.length, sha256: benchmarkHash(bytes),
    startLine, endLine: startLine - 1, totalLines: lines.length, content: '', truncated: true, nextStartLine: startLine };
  for (let index = startLine - 1; index < Math.min(lines.length, startLine - 1 + count); index++) {
    const content = page.content + (page.content ? '\n' : '') + (index + 1) + ': ' + lines[index];
    const next = { ...page, endLine: index + 1, content, truncated: index + 1 < lines.length, nextStartLine: index + 1 < lines.length ? index + 2 : null };
    if (JSON.stringify(next).length > 35000) {
      if (!page.content) throw benchmarkError('BENCHMARK_READ_LINE_TOO_LONG', 'This source line exceeds the bounded file response.');
      break;
    }
    Object.assign(page, next);
  }
  return page;
}

function listResult(profile, args, inventory) {
  const selected = args.path ?? '.', directory = resolveBenchmarkPath(profile, selected, { directory: true });
  const all = new Map();
  for (const name of [...BENCHMARK_FILES, ...inventory.files.map(file => file.path)]) {
    all.set(name, 'file');
    const parts = name.split('/'); parts.pop();
    while (parts.length) { all.set(parts.join('/'), 'directory'); parts.pop(); }
  }
  const prefix = selected === '.' ? '' : selected + '/', depth = args.depth ?? 0, limit = args.limit ?? 150;
  const entries = [...all].filter(([name]) => name.startsWith(prefix) && name !== selected && name.slice(prefix.length).split('/').length <= depth + 1)
    .sort(([a], [b]) => a.localeCompare(b)).map(([name, type]) => ({ name: name.slice(prefix.length), path: path.resolve(profile.workspace, ...name.split('/')), type }));
  return { path: directory, entries: entries.slice(0, limit), truncated: entries.length > limit, scope: 'Only fixed task files and this attempt source are listed.' };
}

function replacement(profile, args, inventory) {
  const target = resolveBenchmarkPath(profile, args.path, { mutation: true, allowMissing: args.action === 'write' });
  let old = null;
  try { old = readBenchmarkFile(profile, args.path); } catch (error) { if (!(args.action === 'write' && error.code === 'ENOENT')) throw error; }
  if (args.expectedHash !== undefined && (!old || benchmarkHash(old) !== args.expectedHash)) throw benchmarkError('BENCHMARK_CONFLICT', 'The saved source changed. Read it and use its current hash.');
  let text = args.text;
  if (args.action === 'patch') {
    const previous = new TextDecoder('utf-8', { fatal: true }).decode(old), first = previous.indexOf(args.oldText);
    if (first < 0 || previous.indexOf(args.oldText, first + 1) !== -1) throw benchmarkError('BENCHMARK_PATCH_MATCH', 'oldText must match exactly one source span.');
    text = previous.slice(0, first) + args.newText + previous.slice(first + args.oldText.length);
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.toString('utf8') !== text) throw benchmarkError('BENCHMARK_UTF8', 'Source text must round-trip as UTF-8.');
  if (inventory.bytes - (old?.length || 0) + bytes.length > BENCHMARK_LIMITS.maxSourceBytes || !old && inventory.files.length >= BENCHMARK_LIMITS.maxModules)
    throw benchmarkError('BENCHMARK_SIZE', 'The benchmark allows at most 32 modules and 200000 source bytes.');
  return { target, bytes, beforeHash: old ? benchmarkHash(old) : null };
}

export function createBenchmarkWorkspaceToolHandler({ profile, signal, onEvent = () => {}, nodeExecutable, runProcess = processRun } = {}) {
  assertBenchmarkIntegrity(profile);
  const expected = profile.contractSha256;
  if (!expected || benchmarkContractHash(profile) !== expected) throw benchmarkError('BENCHMARK_PROFILE_INVALID', 'The frozen benchmark contract changed.');
  let chain = Promise.resolve();
  const validateCall = call => {
    const args = parseCall(call), inventory = assertBenchmarkIntegrity(profile);
    if (args.action === 'list') resolveBenchmarkPath(profile, args.path ?? '.', { directory: true });
    if (args.action === 'read') resolveBenchmarkPath(profile, args.path);
    if (['write', 'patch'].includes(args.action)) replacement(profile, args, inventory);
    return args;
  };
  const execute = async (call, context = {}) => {
    const effectiveSignal = context.signal ? AbortSignal.any([signal, context.signal].filter(Boolean)) : signal;
    let dispatched = false;
    try {
      check(effectiveSignal);
      const args = validateCall(call);
      const descriptor = await handler.describeOperation(call, { ...context, signal: effectiveSignal });
      if (context.operationDescriptor && context.operationDescriptor.operationKey !== descriptor.operationKey)
        throw benchmarkError('OPERATION_DESCRIPTOR_CHANGED', 'The benchmark operation changed after admission.');
      await context.onOperationDispatch?.(descriptor);
      check(effectiveSignal);
      const inventory = assertBenchmarkIntegrity(profile);
      if (args.action === 'read') return response(readResult(profile, args));
      if (args.action === 'list') return response(listResult(profile, args, inventory));
      if (['write', 'patch'].includes(args.action)) {
        const saved = replacement(profile, args, inventory), parent = path.dirname(saved.target);
        dispatched = true;
        fs.mkdirSync(parent, { recursive: true });
        resolveBenchmarkPath(profile, args.path, { mutation: true, allowMissing: true });
        const temporary = path.join(parent, '.' + path.basename(saved.target) + '.benchmark-' + randomUUID() + '.tmp');
        try {
          fs.writeFileSync(temporary, saved.bytes, { flag: 'wx', mode: 0o600 });
          check(effectiveSignal); resolveBenchmarkPath(profile, args.path, { mutation: true, allowMissing: true });
          fs.renameSync(temporary, saved.target);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        const actual = readBenchmarkFile(profile, args.path);
        if (!actual.equals(saved.bytes)) throw benchmarkError('BENCHMARK_WRITE_READBACK', 'The saved implementation did not match the written bytes.');
        onEvent({ type: 'workspace.action', action: args.action, path: saved.target, message: 'Benchmark source saved and read back' });
        return response({ path: saved.target, bytesWritten: actual.length, atomic: true, beforeHash: saved.beforeHash, sha256: benchmarkHash(actual), readbackVerified: true, actionDispatched: true });
      }
      const executable = benchmarkNodeExecutable(nodeExecutable);
      check(effectiveSignal); assertBenchmarkIntegrity(profile);
      const sourceBefore = benchmarkSourceSnapshot(profile);
      dispatched = true;
      onEvent({ type: 'workspace.action', action: 'run', message: 'Benchmark public check' });
      const ran = await runProcess(executable, ['test-public.cjs'], { cwd: profile.workspace, signal: effectiveSignal,
        timeoutMs: args.timeoutMs ?? BENCHMARK_LIMITS.commandTimeoutMs, childEnv: benchmarkChildEnvironment() });
      // Preserve the actual command receipt even when the source or scaffold changes during execution.
      let sourceAfter, integrityError;
      try { assertBenchmarkIntegrity(profile); sourceAfter = benchmarkSourceSnapshot(profile); }
      catch (error) { integrityError = error; }
      let report; try { report = JSON.parse(ran.stdout.trim()); } catch { report = null; }
      const reportValid = report?.schema === 'blackice.minicpm.public-smoke.v1' && report.taskId === profile.caseId
        && report.caseCount === profile.publicCaseCount && Number.isInteger(report.executedCases)
        && Number.isInteger(report.passedCases) && typeof report.semanticPass === 'boolean'
        && /^[a-f0-9]{64}$/.test(report.sourceSnapshotSha256 || '');
      const sourceSnapshotVerified = !integrityError && sourceBefore.sha256 === sourceAfter?.sha256
        && sourceBefore.sha256 === report?.sourceSnapshotSha256;
      const passed = reportValid && sourceSnapshotVerified && report.semanticPass === true
        && report.executedCases === profile.publicCaseCount && report.passedCases === profile.publicCaseCount;
      const error = integrityError
        ? { code: integrityError.code || 'BENCHMARK_INTEGRITY', error: integrityError.message }
        : !reportValid ? { code: 'BENCHMARK_PUBLIC_REPORT_INVALID', error: 'The completed command did not produce the fixed public report.' }
        : !sourceSnapshotVerified ? { code: 'BENCHMARK_SOURCE_CHANGED', error: 'The saved source and the tested source revision did not match.' } : {};
      return response({ ...ran, command: BENCHMARK_COMMAND, shell: 'none', executable, args: ['test-public.cjs'], actionDispatched: true,
        reportValid, sourceSnapshotVerified, sourceSnapshotBeforeSha256: sourceBefore.sha256,
        sourceSnapshotAfterSha256: sourceAfter?.sha256 ?? null, ...error },
        ran.exitCode === 0 && ran.signal === null && ran.timedOut === false && ran.truncated === false && passed);
    } catch (error) { return denial(error, dispatched); }
  };
  const handler = (call, context = {}) => {
    const work = chain.then(() => execute(call, context));
    chain = work.then(() => undefined, () => undefined);
    return work;
  };
  handler.validateCall = validateCall;
  handler.describeOperation = (call, context = {}) => {
    parseCall(call);
    return describeHostOperation(call, { cwd: profile.workspace, signal: context.signal || signal });
  };
  handler.operationAdapter = 'relay_workspace';
  handler.normalizeOperationResult = (result, context = {}) => normalizeHostOperationResult(result, { ...context, cwd: profile.workspace, signal: context.signal || signal });
  return handler;
}
