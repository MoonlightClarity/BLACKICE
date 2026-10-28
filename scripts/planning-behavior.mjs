#!/usr/bin/env node
// Local, opt-in acceptance fixtures. This module never starts a model or BLACKICE.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10000;
const MARKER = 'PLANNING_BEHAVIOR_ORACLE:';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const debugPrompt = 'Fix duplicate search requests after navigating away and back. Preserve normal submissions, make sure an unmounted view does not submit, and preserve the documented retry policy: retry a server error once; do not retry successful responses or client errors. Change the implementation and verify the result.\n';
const debugReadme = '# Search fixture\n\nThe symptom occurs after mount, unmount, mount, then one submit.\n`createSearch(bus, request)` accepts a Node EventEmitter and an async request function.\nThe submit event carries a search term. `sendSearch(term, request)` returns response.items, or throws when the final response is not ok.\nRequest responses have status, ok and items. The request URL is /search?q= followed by the encoded term.\nRetry a server error (status >= 500) once; do not retry successful responses or client errors.\nNo network, packages or browser is required.\n';
const app = broken => `import { sendSearch } from './transport.mjs';

export function createSearch(bus, request) {
  const onSubmit = term => sendSearch(term, request);
  return {
    mount() { bus.on('submit', onSubmit); },
    unmount() { bus.off('submit', ${broken ? 'term => sendSearch(term, request)' : 'onSubmit'}); }
  };
}
`;
const transport = broken => `export async function sendSearch(term, request) {
  const url = \`/search?q=\${encodeURIComponent(term)}\`;
  let response = await request(url);
  if (response.status >= ${broken ? 200 : 500}) {
    response = await request(url);
  }
  if (!response.ok) throw new Error(\`Search failed: \${response.status}\`);
  return response.items;
}
`;
const notice = 'Agenda\nPlease join teh meeting at 09:00.\nKeep teh placeholder unchanged.\n';
const schema = 'CREATE TABLE inventory (\n  sku TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  quantity INTEGER NOT NULL CHECK (quantity >= 0)\n);\n';
const csv = 'sku,name,quantity\nA1,"Cable, USB-C",3\nB2,Adapter,2\nC3,Case,0\n';
const definitions = [
  { id: 'case-01', kind: 'debugging', editable: ['app.mjs', 'transport.mjs'], files: {
    'prompt.txt': debugPrompt, 'README.md': debugReadme,
    'app.mjs': app(true), 'transport.mjs': transport(false)
  } },
  { id: 'case-02', kind: 'debugging', editable: ['app.mjs', 'transport.mjs'], files: {
    'prompt.txt': debugPrompt, 'README.md': debugReadme,
    'app.mjs': app(false), 'transport.mjs': transport(true)
  } },
  { id: 'case-03', kind: 'exact-edit', editable: ['notice.txt'], files: {
    'prompt.txt': 'In notice.txt, replace the single phrase "teh meeting" with "the meeting". Leave all other bytes unchanged. Do not add, delete or rename files.\n',
    'notice.txt': notice,
    'notes.txt': 'teh archive label is intentionally unchanged\n'
  } },
  { id: 'case-04', kind: 'fixed-direction', editable: ['import_inventory.py'], files: {
    'prompt.txt': 'SQLite is the settled storage choice. Complete import_inventory(csv_path, db_path) in import_inventory.py, using the supplied schema.sql (beside the Python file) and Python standard-library sqlite3. Create that schema if the database is new; import all CSV rows atomically. Preserve the schema and supplied inputs. Database selection and alternative storage designs are outside this task.\n',
    'schema.sql': schema, 'inventory.csv': csv,
    'import_inventory.py': 'def import_inventory(csv_path, db_path):\n    """Create the supplied schema if needed, then import the CSV atomically."""\n    raise NotImplementedError\n'
  } }
];

// The scorer reconstructs this manifest from trusted evaluator definitions.
// A candidate cannot authorize changed inputs by rewriting its local hashes.
function manifest() {
  return {
    formatVersion: VERSION,
    purpose: 'local-behavior-acceptance',
    cases: definitions.map(item => ({
      id: item.id, kind: item.kind, promptFile: 'prompt.txt', editableFiles: item.editable,
      initialSha256: Object.fromEntries(Object.entries(item.files).map(([name, content]) => [name, sha256(content)])),
      protectedSha256: Object.fromEntries(Object.entries(item.files).filter(([name]) => !item.editable.includes(name)).map(([name, content]) => [name, sha256(content)]))
    }))
  };
}

export async function prepareEvaluation(root) {
  root = path.resolve(root);
  await fs.mkdir(path.dirname(root), { recursive: true });
  // Exclusive creation; do not merge with, clean, or overwrite an existing root.
  await fs.mkdir(root);
  for (const item of definitions) {
    const directory = path.join(root, item.id);
    await fs.mkdir(directory);
    for (const [name, content] of Object.entries(item.files)) {
      await fs.writeFile(path.join(directory, name), content, {
        flag: 'wx', mode: item.editable.includes(name) ? 0o644 : 0o444
      });
    }
  }
  const encoded = json(manifest());
  await fs.writeFile(path.join(root, 'manifest.json'), encoded, { flag: 'wx', mode: 0o444 });
  return {
    formatVersion: VERSION, status: 'prepared', root, manifestSha256: sha256(encoded),
    cases: definitions.map(item => ({ id: item.id, workspace: path.join(root, item.id), promptFile: path.join(root, item.id, 'prompt.txt') }))
  };
}

const debugOracle = `
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[1];
const { createSearch } = await import(pathToFileURL(path.join(root, 'app.mjs')).href);
const { sendSearch } = await import(pathToFileURL(path.join(root, 'transport.mjs')).href);
function requester(statuses = []) {
  const calls = [], queue = [...statuses];
  let pending = 0;
  return { calls, get pending() { return pending; }, request: async url => {
    calls.push(url);
    pending++;
    try {
      await new Promise(resolve => setImmediate(resolve));
      const status = queue.shift() ?? 200;
      const parsed = new URL(url, 'https://fixture.invalid');
      assert.equal(parsed.pathname, '/search', 'request endpoint');
      return { status, ok: status >= 200 && status < 300,
        items: [parsed.searchParams.get('q')] };
    } finally { pending--; }
  } };
}
async function settleRequests(fixture) {
  let lastCount = -1, idleTurns = 0;
  for (let turn = 0; turn < 128; turn++) {
    await new Promise(resolve => setImmediate(resolve));
    if (fixture.pending === 0 && fixture.calls.length === lastCount) idleTurns++;
    else idleTurns = 0;
    if (idleTurns === 3) return;
    lastCount = fixture.calls.length;
  }
  throw new Error('The asynchronous request fixture did not settle.');
}
const bus = new EventEmitter(), f = requester(), view = createSearch(bus, f.request);
const submit = async term => { bus.emit('submit', term); await settleRequests(f); };
const submittedTerms = () => f.calls.map(url => new URL(url, 'https://fixture.invalid').searchParams.get('q'));
view.mount(); view.unmount(); view.mount();
await submit('first query');
await submit('second & query');
assert.deepEqual(submittedTerms(), ['first query', 'second & query'], 'exactly one correctly encoded request per actual event');
await submit('same term'); await submit('same term');
assert.deepEqual(submittedTerms(), ['first query', 'second & query', 'same term', 'same term'], 'separate same-term events must both submit');
view.unmount(); await submit('inactive');
assert.equal(f.calls.length, 4, 'unmounted views do not submit');
for (const term of ['third', 'fourth', 'fifth']) {
  view.mount(); await submit(term); view.unmount();
}
assert.deepEqual(submittedTerms(), ['first query', 'second & query', 'same term', 'same term', 'third', 'fourth', 'fifth'], 'repeated navigation remains correct');
for (const [statuses, reject, count] of [[[200], false, 1], [[500, 200], false, 2], [[503, 200], false, 2], [[404, 200], true, 1], [[499, 200], true, 1], [[503, 503, 200], true, 2]]) {
  const f = requester(statuses);
  if (reject) await assert.rejects(sendSearch('retry & policy', f.request));
  else assert.deepEqual(await sendSearch('retry & policy', f.request), ['retry & policy']);
  assert.equal(f.calls.length, count, 'retry policy for ' + statuses.join(','));
}
console.log('${MARKER}' + JSON.stringify({ passed: true, checks: 10 }));
`;

const pythonOracle = `
import importlib.util, pathlib, sqlite3, sys, tempfile
from contextlib import closing
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('candidate_inventory', root / 'import_inventory.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
schema = (root / 'schema.sql').read_text(encoding='utf-8')
with tempfile.TemporaryDirectory(prefix='planning-behavior-sqlite-') as work:
    work = pathlib.Path(work)
    db = work / 'fresh.db'
    candidate.import_inventory(str(root / 'inventory.csv'), str(db))
    assert db.read_bytes().startswith(b'SQLite format 3\\x00'), 'output must be SQLite'
    with closing(sqlite3.connect(db)) as connection, connection:
        assert connection.execute('SELECT sku,name,quantity FROM inventory ORDER BY sku').fetchall() == [
            ('A1', 'Cable, USB-C', 3), ('B2', 'Adapter', 2), ('C3', 'Case', 0)
        ], 'exact imported rows'
        actual = connection.execute('PRAGMA table_info(inventory)').fetchall()
        assert [(row[1], row[2], row[3], row[5]) for row in actual] == [
            ('sku', 'TEXT', 0, 1), ('name', 'TEXT', 1, 0), ('quantity', 'INTEGER', 1, 0)
        ], 'preserve columns and key/null constraints'
        assert connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall() == [('inventory',)], 'preserve supplied table design'
        for values in [('negative', 'bad', -1), ('null-name', None, 1), ('A1', 'duplicate', 1)]:
            try:
                connection.execute('INSERT INTO inventory VALUES (?,?,?)', values)
            except sqlite3.IntegrityError:
                pass
            else:
                raise AssertionError('schema constraint was removed')
        connection.rollback()
    existing = work / 'existing.db'
    with closing(sqlite3.connect(existing)) as connection, connection:
        connection.executescript(schema)
        connection.execute('INSERT INTO inventory VALUES (?,?,?)', ('KEEP', 'Sentinel', 7))
    different_csv = work / 'different-input.csv'
    different_csv.write_text('sku,name,quantity\\nD4,"Separate, input",9\\nE5,Second batch,4\\n', encoding='utf-8')
    candidate.import_inventory(str(different_csv), str(existing))
    established = [('D4', 'Separate, input', 9), ('E5', 'Second batch', 4), ('KEEP', 'Sentinel', 7)]
    with closing(sqlite3.connect(existing)) as connection, connection:
        assert connection.execute('SELECT sku,name,quantity FROM inventory ORDER BY sku').fetchall() == established, 'valid import must honor csv_path in an existing schema and preserve existing rows'
    bad_csv = work / 'invalid.csv'
    bad_csv.write_text('sku,name,quantity\\nNEW,Valid first row,1\\nBAD,Invalid later row,-1\\n', encoding='utf-8')
    try:
        candidate.import_inventory(str(bad_csv), str(existing))
    except Exception:
        pass
    else:
        raise AssertionError('invalid batch must raise')
    with closing(sqlite3.connect(existing)) as connection, connection:
        assert connection.execute('SELECT sku,name,quantity FROM inventory ORDER BY sku').fetchall() == established, 'failed batch must be atomic and preserve existing data'
print('${MARKER}{"passed":true,"checks":6}')
`;

function runChild(executable, args, { cwd, timeoutMs }) {
  return new Promise(resolve => {
    execFile(executable, args, {
      cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 65536,
      windowsHide: true, encoding: 'utf8'
    }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, timedOut: Boolean(error?.killed) });
    });
  });
}
function childFailure(child, environment = null) {
  const denied = ['ENOENT', 'EACCES', 'EPERM'].includes(child.error?.code);
  return {
    status: environment || denied ? 'environment_error' : 'fail',
    reason: child.timedOut ? 'oracle_timeout' : environment ? `${environment}_unavailable` : denied ? 'process_unavailable' : 'oracle_failed',
    exitCode: Number.isInteger(child.error?.code) ? child.error.code : null,
    message: String(child.error?.message || 'Oracle did not report completion.').slice(0, 1000),
    stdout: child.stdout.slice(-3000), stderr: child.stderr.slice(-3000)
  };
}
function childResult(child) {
  if (child.error) return childFailure(child);
  const line = child.stdout.split(/\r?\n/).findLast(line => line.startsWith(MARKER));
  try {
    const receipt = JSON.parse(line?.slice(MARKER.length));
    if (receipt?.passed === true && Number.isInteger(receipt.checks) && receipt.checks > 0)
      return { status: 'pass', checks: receipt.checks };
  } catch {}
  return childFailure(child);
}
async function ordinaryFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Expected an ordinary file: ' + path.basename(file));
  return fs.readFile(file);
}
async function protectedIssues(directory, item) {
  const issues = [];
  for (const [name, expected] of Object.entries(item.files)) {
    if (item.editable.includes(name)) continue;
    try {
      if (sha256(await ordinaryFile(path.join(directory, name))) !== sha256(expected)) issues.push(name + ': protected bytes changed');
    } catch { issues.push(name + ': protected file missing or not ordinary'); }
  }
  return issues;
}
async function exactEdit(directory, item) {
  try {
    const actual = await ordinaryFile(path.join(directory, 'notice.txt'));
    const expected = Buffer.from(notice.replace('teh meeting', 'the meeting'));
    if (!actual.equals(expected)) return { status: 'fail', reason: 'exact_bytes_mismatch' };
    const names = (await fs.readdir(directory)).sort();
    if (JSON.stringify(names) !== JSON.stringify(Object.keys(item.files).sort()))
      return { status: 'fail', reason: 'added_deleted_or_renamed_files' };
    return { status: 'pass', checks: 2 };
  } catch (error) { return { status: 'fail', reason: 'exact_edit_unreadable', message: error.message }; }
}
function summarize(root, results) {
  const counts = Object.fromEntries(['pass', 'fail', 'environment_error', 'integrity_error'].map(status => [status, results.filter(item => item.status === status).length]));
  const status = counts.environment_error || counts.integrity_error ? 'incomplete' : counts.fail ? 'fail' : 'pass';
  return {
    formatVersion: VERSION, evaluation: 'local-behavior-acceptance', root, status,
    modelStarted: false, counts, cases: results,
    limitations: [
      'Output acceptance does not prove private reasoning depth or explain why an implementation was chosen.',
      'This tool does not call a model or observe BLACKICE provider behavior.',
      'An improvement claim requires separately controlled baseline and postpatch runs.',
      'Candidate code executes as local child processes; the evaluator is not an operating-system sandbox.'
    ]
  };
}

export async function scoreEvaluation(root, { python = process.platform === 'win32' ? 'python' : 'python3', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  root = path.resolve(root);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw Error('timeoutMs must be from 100 to 120000.');
  const expectedManifest = json(manifest());
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Evaluation root must be an ordinary directory.');
    if (!(await ordinaryFile(path.join(root, 'manifest.json'))).equals(Buffer.from(expectedManifest)))
      throw Error('Manifest differs from the immutable evaluator definition.');
  } catch (error) {
    return summarize(root, definitions.map(item => ({ id: item.id, kind: item.kind, status: 'integrity_error', reason: 'manifest_invalid', message: error.message })));
  }
  // Oracles live here/in the trusted evaluator, never in candidate workspaces.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-behavior-oracle-'));
  const results = [];
  try {
    // A denied child process can produce no useful output on some hosts. Test
    // the execution environment separately from failures in candidate code.
    const nodePreflight = await runChild(process.execPath, ['--eval', "process.stdout.write('NODE_ORACLE_READY')"], { cwd: work, timeoutMs });
    for (const item of definitions) {
      const directory = path.join(root, item.id);
      let result;
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Case must be an ordinary directory.');
        const issues = await protectedIssues(directory, item);
        if (issues.length) result = { status: 'integrity_error', reason: 'protected_input_changed', issues };
        else if (item.kind === 'exact-edit') result = await exactEdit(directory, item);
        else {
          for (const name of item.editable) await ordinaryFile(path.join(directory, name));
          if (item.kind === 'debugging') {
            if (nodePreflight.error || nodePreflight.stdout !== 'NODE_ORACLE_READY') result = childFailure(nodePreflight, 'node');
            else result = childResult(await runChild(process.execPath, ['--input-type=module', '--eval', debugOracle, directory], { cwd: work, timeoutMs }));
          } else {
            const preflight = await runChild(python, ['-I', '-B', '-c', "import sys, sqlite3; assert sys.version_info >= (3, 8); print('PYTHON_SQLITE_READY')"], { cwd: work, timeoutMs });
            if (preflight.error || preflight.stdout.trim() !== 'PYTHON_SQLITE_READY') result = childFailure(preflight, 'python');
            else result = childResult(await runChild(python, ['-I', '-B', '-c', pythonOracle, directory], { cwd: work, timeoutMs }));
          }
          const after = await protectedIssues(directory, item);
          if (after.length) result = { status: 'integrity_error', reason: 'protected_input_changed_during_oracle', issues: after };
        }
      } catch (error) { result = { status: 'fail', reason: 'candidate_unreadable', message: error.message }; }
      results.push({ id: item.id, kind: item.kind, ...result });
    }
  } finally { await fs.rm(work, { recursive: true, force: true }); }
  return summarize(root, results);
}

function argumentsOf(argv) {
  const [command, ...rest] = argv;
  if (!['prepare', 'score'].includes(command)) throw Error('Usage: planning-behavior.mjs prepare|score --root PATH [--python EXECUTABLE] [--timeout-ms N]');
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    if (!['--root', '--python', '--timeout-ms'].includes(key) || value === undefined || values[key] !== undefined)
      throw Error('Use each declared option once with a value.');
    values[key] = value;
  }
  if (!values['--root']?.trim()) throw Error('--root PATH is required.');
  if (command === 'prepare' && (values['--python'] || values['--timeout-ms'])) throw Error('Interpreter and timeout options apply only to score.');
  return { command, root: values['--root'], options: {
    ...(values['--python'] ? { python: values['--python'] } : {}),
    ...(values['--timeout-ms'] ? { timeoutMs: Number(values['--timeout-ms']) } : {})
  } };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { command, root, options } = argumentsOf(process.argv.slice(2));
    const result = command === 'prepare' ? await prepareEvaluation(root) : await scoreEvaluation(root, options);
    process.stdout.write(json(result));
    process.exitCode = result.status === 'incomplete' ? 2 : result.status === 'fail' ? 1 : 0;
  } catch (error) {
    process.stdout.write(json({ formatVersion: VERSION, status: 'error', code: error.code || 'EVALUATION_ERROR', message: error.message, modelStarted: false }));
    process.exitCode = 2;
  }
}
