import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE = 262144;
const failure = (code, message) => Object.assign(new Error(message), { code });
const check = (name, ok, details) => ({ name, status: ok ? 'pass' : 'fail', details });
const contained = (parent, child) => { const rel = path.relative(parent, child); return !rel || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const canonical = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes(':') && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
function csvRows(text) {
  const rows = [];
  for (const line of text.replace(/\r\n/g, '\n').trimEnd().split('\n')) {
    const fields = /^("(?:[^"\r\n]|"")*"|[^",\r\n]*),("(?:[^"\r\n]|"")*"|[^",\r\n]*)$/.exec(line);
    if (!fields) return null;
    rows.push(fields.slice(1).map(value => value.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value));
  }
  return rows;
}
function csvEqual(actual, expected) {
  const rows = csvRows(actual), wanted = csvRows(expected);
  if (!rows || !wanted || rows.length !== wanted.length) return false;
  return rows.every((row, index) => index === 0
    ? row[0] === wanted[0][0] && row[1] === wanted[0][1]
    : row[0] === wanted[index][0] && /^\d+\.\d{2}$/.test(row[1]) && Number(row[1]) === Number(wanted[index][1]));
}

async function readJson(file, limit) {
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) throw failure('EVIDENCE_INVALID', 'JSON input exceeds its declared bound.');
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}
function mapRows(snapshot, definition, caseSha256, workspace, phase) {
  if (snapshot?.schema !== 'blackice.calibration.artifacts.v1' || snapshot.caseId !== definition.id || snapshot.caseSha256 !== caseSha256
      || snapshot.phase !== phase || snapshot.cwd !== workspace || !Number.isFinite(Date.parse(snapshot.observedAtUTC))
      || (phase === 'before' ? snapshot.runId !== null : !UUID.test(snapshot.runId || ''))
      || snapshot.limits?.maxFiles !== 16 || snapshot.limits?.maxFileBytes !== MAX_FILE || snapshot.limits?.maxTotalBytes !== 4194304
      || !Array.isArray(snapshot.files) || snapshot.files.length !== definition.artifacts.length)
    throw failure('EVIDENCE_INVALID', 'Artifact observation identity, phase, limits or path set does not match this case.');
  const rows = new Map();
  for (const row of snapshot.files) {
    if (!row || !definition.artifacts.includes(row.path) || rows.has(row.path)) throw failure('EVIDENCE_INVALID', 'Artifact paths differ or repeat.');
    if (!['file', 'missing', 'not-file'].includes(row.state)) throw failure('EVIDENCE_INCOMPLETE', 'An artifact observation reports an error or limit: ' + row.path);
    if (row.state === 'file' && (!Number.isInteger(row.bytes) || row.bytes < 0 || row.bytes > MAX_FILE || !/^[0-9a-f]{64}$/.test(row.sha256 || '')))
      throw failure('EVIDENCE_INVALID', 'A file observation lacks a usable raw hash and byte count.');
    rows.set(row.path, row);
  }
  return rows;
}
async function currentFile(workspace, relative) {
  const file = path.join(workspace, relative);
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return { state: 'missing' }; throw error; }
  if (!stat.isFile()) return { state: 'not-file' };
  if (stat.size > MAX_FILE) throw failure('EVIDENCE_INCOMPLETE', 'Current artifact exceeds the observation bound: ' + relative);
  const bytes = await fs.readFile(file);
  return { state: 'file', bytes: bytes.length, sha256: hash(bytes), buffer: bytes };
}
async function bindCurrent(workspace, rows) {
  const current = new Map();
  for (const [relative, row] of rows) {
    const actual = await currentFile(workspace, relative);
    if (actual.state !== row.state || actual.state === 'file' && (actual.bytes !== row.bytes || actual.sha256 !== row.sha256))
      throw failure('ARTIFACT_DRIFT', 'Current bytes differ from settled artifact evidence: ' + relative);
    current.set(relative, actual);
  }
  return current;
}
function utf8(actual) {
  if (actual?.state !== 'file') return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(actual.buffer); }
  catch { return null; }
}
async function transferCheck(workspace, oracle, scratchRoot) {
  const parent = scratchRoot ?? os.tmpdir();
  if (!path.isAbsolute(parent) || contained(workspace, parent)) throw failure('SCRATCH_INVALID', 'Transfer scratch must be an absolute directory outside the task workspace.');
  const stat = await fs.stat(parent);
  if (!stat.isDirectory()) throw failure('SCRATCH_INVALID', 'Transfer scratch parent is not a directory.');
  const scratch = await fs.mkdtemp(path.join(parent, 'blackice-calibration-check-'));
  try {
    const input = path.join(scratch, 'transfer-input.csv'), output = path.join(scratch, 'transfer-output.csv');
    await fs.writeFile(input, oracle.transferInputCsv, { flag: 'wx' });
    let exitCode = 0, errorCode = null, timedOut = false;
    try { await execute(process.execPath, [path.join(workspace, 'summary.mjs'), input, output], { cwd: scratch, timeout: 5000, maxBuffer: MAX_FILE, windowsHide: true }); }
    catch (error) { exitCode = typeof error.code === 'number' ? error.code : null; errorCode = typeof error.code === 'string' ? error.code : null; timedOut = error.killed === true; }
    const originalInput = Buffer.from(oracle.transferInputCsv);
    const actualInput = await fs.readFile(input).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    const actualOutput = await currentFile(scratch, 'transfer-output.csv');
    const outputText = utf8(actualOutput);
    const inputUnchanged = actualInput !== null && actualInput.equals(originalInput);
    const correctOutput = outputText !== null && csvEqual(outputText, oracle.transferExpectedCsv);
    return { exitCode, errorCode, timedOut, inputUnchanged, correctOutput,
      inputSha256: hash(originalInput), outputSha256: actualOutput.sha256 ?? null,
      status: exitCode === 0 && errorCode === null && !timedOut && inputUnchanged && correctOutput ? 'pass' : 'fail' };
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

export async function verifyLocalCase({ caseFile, workspace, beforeFile, afterFile, scratchRoot }) {
  if (![caseFile, workspace, beforeFile, afterFile].every(value => typeof value === 'string' && path.isAbsolute(value)))
    throw failure('CONFIG_INVALID', 'Case, workspace and observation paths must be explicit absolute paths.');
  workspace = path.resolve(workspace);
  if ([caseFile, beforeFile, afterFile, fileURLToPath(import.meta.url)].some(file => contained(workspace, path.resolve(file))))
    throw failure('CONFIG_INVALID', 'Case, checker and evidence must remain outside the model task workspace.');
  const { bytes: caseBytes, value: definition } = await readJson(caseFile, 65536);
  if (definition?.schema !== 'blackice.calibration.case.v1' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(definition.id || '')
      || Object.keys(definition).some(key => !['schema', 'id', 'task', 'artifacts'].includes(key))
      || typeof definition.task !== 'string' || !definition.task.trim() || Buffer.byteLength(definition.task) > 16384
      || !Array.isArray(definition.artifacts) || definition.artifacts.length > 16 || new Set(definition.artifacts).size !== definition.artifacts.length
      || !definition.artifacts.every(canonical))
    throw failure('CASE_INVALID', 'Unsupported local calibration case shape.');
  const { value: oracles } = await readJson(path.join(here, 'oracles.json'), 65536);
  const specification = oracles.cases[definition.id];
  if (!specification) throw failure('CASE_INVALID', 'This checker handles only the three declared local cases.');
  const frozenCase = await fs.readFile(path.join(here, 'cases', definition.id + '.json'));
  if (!caseBytes.equals(frozenCase)) throw failure('CASE_INVALID', 'Case bytes differ from the frozen local case.');
  const caseSha256 = hash(caseBytes);
  const { value: before } = await readJson(beforeFile, 8388608);
  const { value: after } = await readJson(afterFile, 8388608);
  const initial = mapRows(before, definition, caseSha256, workspace, 'before');
  const final = mapRows(after, definition, caseSha256, workspace, 'after');
  if (Date.parse(before.observedAtUTC) > Date.parse(after.observedAtUTC)) throw failure('EVIDENCE_INVALID', 'Observation times are reversed.');
  for (const relative of definition.artifacts) {
    const seed = await currentFile(path.join(here, 'fixtures', specification.fixture), relative);
    const row = initial.get(relative);
    if (seed.state !== row.state || seed.state === 'file' && (seed.bytes !== row.bytes || seed.sha256 !== row.sha256))
      throw failure('FIXTURE_MISMATCH', 'Before evidence is not a fresh copy of this seed: ' + relative);
  }
  const current = await bindCurrent(workspace, final);
  const checks = [];
  for (const relative of specification.protected) {
    const a = initial.get(relative), b = final.get(relative);
    checks.push(check('protected:' + relative, a.state === 'file' && b.state === 'file' && a.sha256 === b.sha256 && a.bytes === b.bytes, 'Compare recorded before/after raw bytes.'));
  }
  const output = current.get(specification.output), outputText = utf8(output);
  checks.push(check('output:' + specification.output, outputText !== null && outputText.trim().length > 0, 'A nonempty UTF-8 artifact is present and bound to settled evidence.'));
  let transfer = null;
  if (definition.id === 'repair-summary') {
    checks.push(check('primary-summary', outputText !== null && csvEqual(outputText, oracles.summary.primaryExpectedCsv), 'All original records contribute to their project totals.'));
    if (current.get('summary.mjs')?.state === 'file') {
      transfer = await transferCheck(workspace, oracles.summary, scratchRoot);
      checks.push(check('transfer-summary', transfer.status === 'pass', 'The resulting generator also processes a separate input in evaluator scratch.'));
      await bindCurrent(workspace, final);
    } else checks.push(check('transfer-summary', false, 'The resulting generator is absent or not a regular file.'));
  }
  return {
    schema: 'blackice.calibration.local-check.v1', caseId: definition.id, caseSha256, runId: after.runId, workspace,
    evidence: { beforeSha256: hash(await fs.readFile(beforeFile)), afterSha256: hash(await fs.readFile(afterFile)), freshSeedMatched: true },
    checks, transfer,
    redactedArtifacts: after.files.filter(row => row.redacted === true).map(row => row.path),
    nativeRunJoin: 'The reported runId is UUID-shape-checked only; root must join it to the exact settled native attempt.',
    manualReviewRequired: ['Join reported runId to the exact native attempt and verify settlement and complete public capture.', 'Score public questions and actual user scope.', 'Assess task-specific substantive quality under the frozen rubric.', 'Check truthful reporting and absence of intervention/oracle access.'],
    conclusion: 'Mechanical observations only; no model-behavior, calibration or external-application verdict.'
  };
}

function parseArgs(args) {
  const names = { '--case-file': 'caseFile', '--workspace': 'workspace', '--before': 'beforeFile', '--after': 'afterFile', '--scratch': 'scratchRoot' };
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]];
    if (!key || Object.hasOwn(result, key) || !args[i + 1]) throw failure('CONFIG_INVALID', 'Use distinct named path arguments.');
    result[key] = args[i + 1];
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await verifyLocalCase(parseArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.checks.some(row => row.status === 'fail') ? 1 : 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: error.code || 'CHECK_ERROR', message: error.message }) + '\n');
    process.exitCode = 2;
  }
}
