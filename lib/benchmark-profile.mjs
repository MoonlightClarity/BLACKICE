import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const BENCHMARK_PROFILE = 'minicpm-code-v1';
export const BENCHMARK_COMMAND = 'node test-public.cjs';
export const BENCHMARK_FILES = Object.freeze([
  'METHOD.md', 'TASK.md', 'task.json', 'public-cases.json', 'test-public.cjs',
  'test-support/grade-modules.cjs', 'test-support/module-worker.cjs',
]);
export const BENCHMARK_LIMITS = Object.freeze({ maxModules: 32, maxSourceBytes: 200000, maxDepth: 8, commandTimeoutMs: 10000 });
const hashPattern = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
export const benchmarkHash = value => createHash('sha256').update(value).digest('hex');
export function benchmarkContractHash(value) {
  const { contractSha256, ...contract } = value;
  const canonical = input => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])])) : input;
  return benchmarkHash(JSON.stringify(canonical(contract)));
}
export const benchmarkError = (code, message) => Object.assign(new Error(message), { code, status: 400, actionDispatched: false });
const fail = (code, message) => { throw benchmarkError(code, message); };
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const below = (root, target) => { const rel = path.relative(root, target); return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const isSource = value => /^src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.cjs$/.test(value);
const isSourceDirectory = value => value === 'src' || /^src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value);

/** The benchmark is an explicit capability profile, not an OS security sandbox. */
export function benchmarkRelativePath(value, { directory = false } = {}) {
  if (directory && value === '.') return value;
  if (typeof value !== 'string' || !value || value.length > 240 || !/^[A-Za-z0-9_.\/-]+$/.test(value)
      || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) fail('BENCHMARK_PATH', 'Use one task-relative path with forward slashes.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('BENCHMARK_PATH', 'Parent paths, aliases and device names are unavailable in this benchmark.');
  if (parts.length > BENCHMARK_LIMITS.maxDepth + 2) fail('BENCHMARK_PATH', 'The benchmark source path is too deep.');
  return value;
}

function regular(file, { directory = false } = {}) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || directory && !stat.isDirectory() || !directory && (!stat.isFile() || stat.nlink > 1))
    fail('BENCHMARK_LINK', 'Benchmark paths must be ordinary directories or single-link regular files.');
  return stat;
}

function canonicalExisting(file, { directory = false } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) fail('BENCHMARK_PATH', 'The controller must supply an absolute path.');
  const absolute = path.resolve(file), ancestry = [];
  for (let current = absolute; ; current = path.dirname(current)) {
    ancestry.push(current);
    if (path.dirname(current) === current) break;
  }
  for (let i = ancestry.length - 1; i >= 0; i--) regular(ancestry[i], { directory: i !== 0 || directory });
  const real = fs.realpathSync.native(absolute);
  if (!samePath(real, absolute)) fail('BENCHMARK_LINK', 'Benchmark paths cannot resolve through filesystem aliases.');
  return real;
}

function readStable(file, maxBytes = 1024 * 1024) {
  const first = regular(file);
  if (first.size > maxBytes) fail('BENCHMARK_SIZE', 'The benchmark file exceeds its bounded size.');
  const handle = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(handle);
    if (!opened.isFile() || opened.nlink > 1 || opened.dev !== first.dev || opened.ino !== first.ino)
      fail('BENCHMARK_CHANGED', 'The benchmark file changed while it was opened.');
    const bytes = fs.readFileSync(handle), last = fs.fstatSync(handle);
    if (bytes.length > maxBytes || last.size !== opened.size || last.mtimeMs !== opened.mtimeMs || bytes.length !== opened.size)
      fail('BENCHMARK_CHANGED', 'The benchmark file changed while it was read.');
    const current = regular(file);
    if (current.dev !== last.dev || current.ino !== last.ino || current.size !== last.size || current.mtimeMs !== last.mtimeMs)
      fail('BENCHMARK_CHANGED', 'The benchmark file changed before its read completed.');
    return bytes;
  } finally { fs.closeSync(handle); }
}

export function resolveBenchmarkPath(profile, relative, { mutation = false, directory = false, allowMissing = false } = {}) {
  benchmarkRelativePath(relative, { directory });
  const permitted = directory ? relative === '.' || relative === 'test-support' || isSourceDirectory(relative)
    : isSource(relative) || BENCHMARK_FILES.includes(relative);
  if (!permitted || mutation && !isSource(relative)) fail('BENCHMARK_SCOPE', 'Only task files can be read; only .cjs implementation files under src can be changed.');
  if (!samePath(canonicalExisting(profile.workspace, { directory: true }), profile.workspace))
    fail('BENCHMARK_CHANGED', 'The benchmark working directory changed.');
  const target = relative === '.' ? profile.workspace : path.resolve(profile.workspace, ...relative.split('/'));
  if (relative !== '.' && !below(profile.workspace, target)) fail('BENCHMARK_SCOPE', 'The path is outside this benchmark attempt.');
  if (relative === '.') return target;
  const parts = relative.split('/'); let current = profile.workspace, missing = false;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (missing) continue;
    try {
      regular(current, { directory: i < parts.length - 1 || directory });
      if (!below(profile.workspace, fs.realpathSync.native(current))) fail('BENCHMARK_LINK', 'The path resolves outside this benchmark attempt.');
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing && mutation) { missing = true; continue; }
      throw error;
    }
  }
  return target;
}

export function readBenchmarkFile(profile, relative) {
  const file = resolveBenchmarkPath(profile, relative);
  const bytes = readStable(file);
  resolveBenchmarkPath(profile, relative);
  const expected = profile.immutableFiles[relative];
  if (expected && benchmarkHash(bytes) !== expected) fail('BENCHMARK_SCAFFOLD_CHANGED', 'A fixed benchmark file no longer matches its admitted hash.');
  return bytes;
}

export function benchmarkSourceInventory(profile) {
  const root = resolveBenchmarkPath(profile, 'src', { directory: true }), files = [];
  let bytes = 0, entries = 0;
  const visit = (directory, relative, depth) => {
    if (depth > BENCHMARK_LIMITS.maxDepth) fail('BENCHMARK_SIZE', 'The benchmark source tree is too deep.');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (++entries > 256) fail('BENCHMARK_SIZE', 'The benchmark source inventory is too large.');
      const name = relative + '/' + entry.name;
      benchmarkRelativePath(name);
      if (entry.isDirectory()) {
        const child = resolveBenchmarkPath(profile, name, { directory: true }); visit(child, name, depth + 1);
      } else {
        if (!isSource(name)) fail('BENCHMARK_SCOPE', 'Only .cjs implementation files are allowed under src.');
        const file = resolveBenchmarkPath(profile, name), stat = regular(file);
        bytes += stat.size; files.push({ path: name, bytes: stat.size });
        if (files.length > BENCHMARK_LIMITS.maxModules || bytes > BENCHMARK_LIMITS.maxSourceBytes)
          fail('BENCHMARK_SIZE', 'The benchmark allows at most 32 modules and 200000 source bytes.');
      }
    }
  };
  visit(root, 'src', 0);
  if (!files.some(file => file.path === 'src/index.cjs')) fail('BENCHMARK_ENTRY', 'The benchmark entry src/index.cjs is missing.');
  return { files, bytes };
}

/** Match grade-modules.cjs exactly: depth-first code-unit name order, relative paths without src/. */
export function benchmarkSourceSnapshot(profile) {
  const inventory = benchmarkSourceInventory(profile);
  let totalBytes = 0;
  const modules = inventory.files.map(file => {
    const bytes = readBenchmarkFile(profile, file.path); totalBytes += bytes.length;
    if (totalBytes > BENCHMARK_LIMITS.maxSourceBytes) fail('BENCHMARK_SIZE', 'Implementation exceeds the bounded source snapshot.');
    return { path: file.path.slice(4), sha256: benchmarkHash(bytes) };
  });
  return { schema: 'blackice.minicpm.module-snapshot.v1', modules, totalBytes, sha256: benchmarkHash(JSON.stringify(modules)) };
}

export function assertBenchmarkIntegrity(profile) {
  if (!profile || profile.schema !== 'blackice.minicpm.benchmark-profile.v1' || profile.profile !== BENCHMARK_PROFILE)
    fail('BENCHMARK_PROFILE_INVALID', 'A normalized benchmark profile is required.');
  canonicalExisting(profile.scaffoldReceiptPath);
  if (benchmarkHash(readStable(profile.scaffoldReceiptPath, 65536)) !== profile.scaffoldReceiptSha256)
    fail('BENCHMARK_RECEIPT_CHANGED', 'The admitted benchmark receipt changed.');
  for (const file of BENCHMARK_FILES) readBenchmarkFile(profile, file);
  return benchmarkSourceInventory(profile);
}

/** Fresh-run constraints are checked by the host, never by model-authored flags. */
export function assertBenchmarkExecutionOptions({ workflow, directoryActions, chatPlanning, pastChats, attachmentIds = [], goal, continuation = false } = {}) {
  if (continuation) fail('BENCHMARK_RESUME_UNSUPPORTED', 'This benchmark profile requires a fresh attempt; continuation and retry are not supported.');
  if (!workflow || !Array.isArray(workflow.nodes) || workflow.nodes.filter(node => node.type === 'agent').length !== 1
      || workflow.planning?.shared || workflow.nodes.some(node => node.assignment)
      || directoryActions !== 'on' || chatPlanning !== 'off' || pastChats !== 'off'
      || !Array.isArray(attachmentIds) || attachmentIds.length || goal)
    fail('BENCHMARK_RUN_SHAPE', 'Use a fresh single-agent benchmark with Action Directory on, Chat Planning and Past Chats off, and no attachments, shared workers or goal.');
}

/** Pure request identity is checked before idempotent replay; filesystem admission follows only for new runs. */
export function benchmarkRequest(value) {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).sort().join(',') !== 'profile,scaffoldReceiptPath,scaffoldReceiptSha256'
      || value.profile !== BENCHMARK_PROFILE || !hashPattern.test(value.scaffoldReceiptSha256 || '')
      || typeof value.scaffoldReceiptPath !== 'string' || !path.isAbsolute(value.scaffoldReceiptPath) || value.scaffoldReceiptPath.includes('\0'))
    fail('BENCHMARK_PROFILE_INVALID', 'Use profile minicpm-code-v1 with an absolute scaffoldReceiptPath and its SHA-256.');
  return Object.freeze({ profile: BENCHMARK_PROFILE, scaffoldReceiptPath: path.resolve(value.scaffoldReceiptPath), scaffoldReceiptSha256: value.scaffoldReceiptSha256 });
}

/** Synchronous, bounded admission preserves startRun's current synchronous interface. */
export function normalizeBenchmarkProfile(value, { cwd } = {}) {
  value = benchmarkRequest(value);
  if (value === undefined) return undefined;
  const receiptPath = canonicalExisting(value.scaffoldReceiptPath);
  const bytes = readStable(receiptPath, 65536);
  if (benchmarkHash(bytes) !== value.scaffoldReceiptSha256) fail('BENCHMARK_RECEIPT_CHANGED', 'The benchmark receipt does not match the supplied SHA-256.');
  let receipt; try { receipt = JSON.parse(bytes.toString('utf8')); } catch { fail('BENCHMARK_RECEIPT_INVALID', 'The benchmark receipt is not valid JSON.'); }
  const smoke = receipt?.schema === 'blackice.minicpm.directory-smoke-scaffold.v1';
  if (!object(receipt) || !(smoke || receipt.schema === 'blackice.minicpm.agentic-scaffold.v1')
      || !/^(D0|L[1-7])$/.test(receipt.caseId || '') || smoke !== (receipt.caseId === 'D0')
      || smoke && receipt.scored !== false || receipt.publicCaseCount !== 2
      || !object(receipt.immutableFiles) || Object.keys(receipt.immutableFiles).sort().join('\n') !== [...BENCHMARK_FILES].sort().join('\n')
      || Object.values(receipt.immutableFiles).some(hash => !hashPattern.test(hash))
      || receipt.method?.path !== 'METHOD.md' || receipt.method.sha256 !== receipt.immutableFiles['METHOD.md']
      || !object(receipt.initialSource) || Object.keys(receipt.initialSource).length !== 1 || !hashPattern.test(receipt.initialSource['src/index.cjs'] || ''))
    fail('BENCHMARK_RECEIPT_INVALID', 'The receipt must identify the fixed two-case scaffold and its METHOD and source hashes.');
  const workspace = canonicalExisting(receipt.workspace, { directory: true });
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !samePath(workspace, canonicalExisting(cwd, { directory: true })))
    fail('BENCHMARK_WORKSPACE_MISMATCH', 'The run working directory must match its benchmark receipt.');
  if (samePath(workspace, receiptPath) || below(workspace, receiptPath)) fail('BENCHMARK_RECEIPT_SCOPE', 'The controller receipt must be outside the model workspace.');
  const profile = {
    schema: 'blackice.minicpm.benchmark-profile.v1', profile: BENCHMARK_PROFILE, workspace,
    caseId: receipt.caseId, publicCaseCount: receipt.publicCaseCount, command: BENCHMARK_COMMAND,
    scaffoldReceiptPath: receiptPath, scaffoldReceiptSha256: value.scaffoldReceiptSha256,
    immutableFiles: { ...receipt.immutableFiles }, limits: { ...BENCHMARK_LIMITS },
    isolation: 'Enforced benchmark tool/API boundary with a restricted pure-function worker; not an operating-system sandbox.',
  };
  const initialInventory = assertBenchmarkIntegrity(profile);
  if (initialInventory.files.map(file => file.path).sort().join('\n') !== Object.keys(receipt.initialSource).sort().join('\n'))
    fail('BENCHMARK_INITIAL_SOURCE_CHANGED', 'The benchmark must start with exactly the source files declared by its receipt.');
  const task = JSON.parse(readBenchmarkFile(profile, 'task.json').toString('utf8'));
  const cases = JSON.parse(readBenchmarkFile(profile, 'public-cases.json').toString('utf8'));
  if (!object(task) || task.id !== profile.caseId || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(task.functionName || '')
      || !Array.isArray(cases) || cases.length !== profile.publicCaseCount
      || new Set(cases.map(item => item?.id)).size !== cases.length
      || cases.some(item => !object(item) || typeof item.id !== 'string' || !item.id || !Array.isArray(item.args) || !Object.hasOwn(item, 'expected')))
    fail('BENCHMARK_SCAFFOLD_INVALID', 'The fixed task and public cases do not match the benchmark contract.');
  if (benchmarkHash(readBenchmarkFile(profile, 'src/index.cjs')) !== receipt.initialSource['src/index.cjs'])
    fail('BENCHMARK_INITIAL_SOURCE_CHANGED', 'The benchmark must start from its admitted initial source.');
  profile.functionName = task.functionName;
  profile.contractSha256 = benchmarkContractHash(profile);
  return freeze(profile);
}
