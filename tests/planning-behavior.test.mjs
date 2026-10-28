import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareEvaluation, scoreEvaluation } from '../scripts/planning-behavior.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/planning-behavior.mjs', import.meta.url));
const python = process.env.PLANNING_BEHAVIOR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const correctApp = `import { sendSearch } from './transport.mjs';
export function createSearch(bus, request) {
  const onSubmit = term => sendSearch(term, request);
  return {
    mount() { bus.on('submit', onSubmit); },
    unmount() { bus.off('submit', onSubmit); }
  };
}
`;
const correctTransport = `export async function sendSearch(term, request) {
  const url = \`/search?q=\${encodeURIComponent(term)}\`;
  let response = await request(url);
  if (response.status >= 500) response = await request(url);
  if (!response.ok) throw new Error('Search failed: ' + response.status);
  return response.items;
}
`;
const correctPython = `import csv
import sqlite3
from pathlib import Path

def import_inventory(csv_path, db_path):
    connection = sqlite3.connect(db_path)
    try:
        exists = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory'").fetchone()
        if not exists:
            connection.executescript(Path(__file__).with_name('schema.sql').read_text(encoding='utf-8'))
        with connection:
            with open(csv_path, encoding='utf-8', newline='') as source:
                for row in csv.DictReader(source):
                    connection.execute('INSERT INTO inventory VALUES (?,?,?)',
                        (row['sku'], row['name'], int(row['quantity'])))
    finally:
        connection.close()
`;

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-behavior-test-'));
  const root = path.join(parent, 'isolated cases');
  await prepareEvaluation(root);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return root;
}
const write = (root, name, text) => fs.writeFile(path.join(root, name), text);
const resultFor = (report, id) => report.cases.find(item => item.id === id);
async function repairAll(root) {
  await write(root, 'case-01/app.mjs', correctApp);
  await write(root, 'case-02/transport.mjs', correctTransport);
  const notice = path.join(root, 'case-03/notice.txt');
  await fs.writeFile(notice, (await fs.readFile(notice, 'utf8')).replace('teh meeting', 'the meeting'));
  await write(root, 'case-04/import_inventory.py', correctPython);
}
const score = (root, options = {}) => scoreEvaluation(root, { python, ...options });

test('prepare isolates cases, keeps matched prompts identical, and refuses any overwrite', async t => {
  const root = await fixture(t);
  assert.equal(await fs.readFile(path.join(root, 'case-01/prompt.txt'), 'utf8'), await fs.readFile(path.join(root, 'case-02/prompt.txt'), 'utf8'));
  const before = await fs.readFile(path.join(root, 'manifest.json'));
  const record = JSON.parse(before);
  assert.equal(record.cases.length, 4);
  assert.ok(record.cases.every(item => Object.keys(item.protectedSha256).length > 0));
  assert.ok(record.cases.every(item => !Object.hasOwn(item, 'cause')));
  await assert.rejects(prepareEvaluation(root), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(path.join(root, 'manifest.json')), before);
});

test('both original defects, unchanged typo, and unimplemented import fail', async t => {
  const report = await score(await fixture(t));
  assert.equal(report.modelStarted, false);
  assert.deepEqual(report.cases.map(item => item.status), ['fail', 'fail', 'fail', 'fail']);
  assert.equal(report.status, 'fail');
});

test('the correct distinct repairs and both correct controls pass', async t => {
  const root = await fixture(t);
  await repairAll(root);
  const report = await score(root);
  assert.equal(report.status, 'pass', JSON.stringify(report, null, 2));
  assert.equal(report.counts.pass, 4);
  assert.equal(report.counts.environment_error, 0);
});

test('app-only repair in both cases leaves the other cause broken', async t => {
  const root = await fixture(t);
  for (const id of ['case-01', 'case-02']) await write(root, id + '/app.mjs', correctApp);
  const report = await score(root);
  assert.equal(resultFor(report, 'case-01').status, 'pass');
  assert.equal(resultFor(report, 'case-02').status, 'fail');
});

test('transport-only repair in both cases leaves the other cause broken', async t => {
  const root = await fixture(t);
  for (const id of ['case-01', 'case-02']) await write(root, id + '/transport.mjs', correctTransport);
  const report = await score(root);
  assert.equal(resultFor(report, 'case-01').status, 'fail');
  assert.equal(resultFor(report, 'case-02').status, 'pass');
});

test('deleting retries can remove the symptom but still fails the behavior oracle', async t => {
  const root = await fixture(t);
  await repairAll(root);
  await write(root, 'case-02/transport.mjs', correctTransport.replace('  if (response.status >= 500) response = await request(url);\n', ''));
  const report = await score(root);
  assert.equal(resultFor(report, 'case-02').status, 'fail');
  assert.equal(resultFor(report, 'case-01').status, 'pass');
});

test('a once listener fails because real second submissions still need a handler', async t => {
  const root = await fixture(t);
  await repairAll(root);
  await write(root, 'case-01/app.mjs', correctApp.replace("bus.on('submit'", "bus.once('submit'"));
  assert.equal(resultFor(await score(root), 'case-01').status, 'fail');
});

test('a normal listener need not return the request Promise', async t => {
  const root = await fixture(t);
  await repairAll(root);
  await write(root, 'case-01/app.mjs', correctApp.replace('const onSubmit = term => sendSearch(term, request);', 'const onSubmit = term => { sendSearch(term, request); };'));
  const report = await score(root);
  assert.equal(report.status, 'pass', JSON.stringify(report, null, 2));
});

test('suppressing distinct events with the same term fails the submission contract', async t => {
  const root = await fixture(t);
  await repairAll(root);
  await write(root, 'case-01/app.mjs', correctApp.replace('const onSubmit = term => sendSearch(term, request);', 'let lastTerm; const onSubmit = term => { if (term === lastTerm) return; lastTerm = term; return sendSearch(term, request); };'));
  assert.equal(resultFor(await score(root), 'case-01').status, 'fail');
});

test('server status 500 must retry, not only larger server-error codes', async t => {
  const root = await fixture(t);
  await repairAll(root);
  await write(root, 'case-02/transport.mjs', correctTransport.replace('status >= 500', 'status > 500'));
  assert.equal(resultFor(await score(root), 'case-02').status, 'fail');
});

test('equivalent URLSearchParams encoding passes without exact URL spelling', async t => {
  const root = await fixture(t);
  await repairAll(root);
  await write(root, 'case-02/transport.mjs', correctTransport.replace('const url = `/search?q=${encodeURIComponent(term)}`;', "const url = '/search?' + new URLSearchParams({ q: term }).toString();"));
  const report = await score(root);
  assert.equal(report.status, 'pass', JSON.stringify(report, null, 2));
});

test('a broad typo correction fails despite fixing the requested phrase', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'case-03/notice.txt');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replaceAll('teh', 'the'));
  const result = resultFor(await score(root), 'case-03');
  assert.equal(result.status, 'fail');
  assert.equal(result.reason, 'exact_bytes_mismatch');
});

test('successful CSV import with per-row commits fails the atomicity control', async t => {
  const root = await fixture(t);
  const nonAtomic = correctPython.replace("(row['sku'], row['name'], int(row['quantity'])))", "(row['sku'], row['name'], int(row['quantity'])))\n                    connection.commit()");
  await write(root, 'case-04/import_inventory.py', nonAtomic);
  const result = resultFor(await score(root), 'case-04');
  assert.equal(result.status, 'fail');
  assert.match(result.stderr, /failed batch must be atomic/);
});

test('unconditional CREATE TABLE cannot pass by failing before the invalid batch', async t => {
  const root = await fixture(t);
  const unconditional = correctPython.replace("        exists = connection.execute(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory'\").fetchone()\n        if not exists:\n            connection.executescript", '        connection.executescript');
  assert.notEqual(unconditional, correctPython);
  await write(root, 'case-04/import_inventory.py', unconditional);
  const result = resultFor(await score(root), 'case-04');
  assert.equal(result.status, 'fail');
  assert.match(result.stderr, /table inventory already exists/);
});

test('hardcoding the bundled CSV cannot receive credit for rejecting a different input', async t => {
  const root = await fixture(t);
  const hardcoded = correctPython.replace('with open(csv_path, encoding=', "with open(Path(__file__).with_name('inventory.csv'), encoding=");
  assert.notEqual(hardcoded, correctPython);
  await write(root, 'case-04/import_inventory.py', hardcoded);
  const result = resultFor(await score(root), 'case-04');
  assert.equal(result.status, 'fail');
  assert.match(result.stderr, /valid import must honor csv_path/);
});

test('protected file changes cannot be legitimized by rewriting manifest hashes', async t => {
  const root = await fixture(t);
  const input = path.join(root, 'case-04/schema.sql');
  await fs.chmod(input, 0o644);
  await fs.writeFile(input, 'CREATE TABLE inventory (sku TEXT);\n');
  assert.equal(resultFor(await score(root), 'case-04').status, 'integrity_error');
  const file = path.join(root, 'manifest.json');
  await fs.chmod(file, 0o644);
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.cases[3].protectedSha256['schema.sql'] = 'changed';
  await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n');
  const report = await score(root);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.counts.integrity_error, 4);
});

test('a missing Python executable is an environment failure, never a pass or skip', async t => {
  const root = await fixture(t);
  await repairAll(root);
  const report = await score(root, { python: path.join(root, 'no-such-python-executable') });
  assert.equal(report.status, 'incomplete');
  assert.equal(report.counts.pass, 3);
  assert.equal(resultFor(report, 'case-04').status, 'environment_error');
});

test('a nonterminating candidate is stopped and cannot pass', async t => {
  const root = await fixture(t);
  await write(root, 'case-02/transport.mjs', 'while (true) {}\n' + correctTransport);
  const result = resultFor(await score(root, { timeoutMs: 300 }), 'case-02');
  assert.equal(result.status, 'fail');
  assert.equal(result.reason, 'oracle_timeout');
});

test('CLI emits JSON, accepts paths with spaces, and returns a failing score exit code', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-behavior-cli-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'a root with spaces');
  const prepared = await execute(process.execPath, [script, 'prepare', '--root', root]);
  assert.equal(JSON.parse(prepared.stdout).status, 'prepared');
  await assert.rejects(execute(process.execPath, [script, 'score', '--root', root, '--python', python]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).counts.fail, 4);
    return true;
  });
});
