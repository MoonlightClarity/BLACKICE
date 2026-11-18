import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkspaceToolHandler, WORKSPACE_TOOL } from '../lib/workspace-tools.mjs';
import { createFileSearch } from '../lib/workspace-file-search.mjs';

const call = args => ({ name: 'relay_workspace', arguments: JSON.stringify(args) });
const decoded = result => JSON.parse(result.contentItems[0].text);
const read = result => { assert.equal(result.success, true, result.contentItems[0].text); return decoded(result); };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-find-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'), outside = path.join(root, 'outside docs');
  await mkdir(cwd); await mkdir(outside);
  return { root, cwd, outside, scope: randomUUID() };
}
const handler = f => createWorkspaceToolHandler({ cwd: f.cwd, fileSearchScope: f.scope });
async function drain(f, initial, pages = []) {
  let next = initial;
  for (let i = 0; i < 500; i++) {
    const result = await handler(f)(call(next));
    assert.ok(result.contentItems[0].text.length <= 40000);
    const page = read(result); pages.push(page);
    if (!page.cursor) return pages;
    next = { action: 'find', cursor: page.cursor, limit: initial.limit ?? 100, timeoutMs: 10000 };
  }
  assert.fail('Search did not finish within 500 pages');
}
async function files(directory, count, prefix = 'Item') {
  for (let i = 0; i < count; i += 100) await Promise.all(Array.from({ length: Math.min(100, count - i) }, (_, n) => writeFile(path.join(directory, `${prefix}${String(i + n).padStart(5, '0')}.txt`), 'fixture')));
}

test('find locates filename beyond a large outside-workspace listing with a blank profile', async t => {
  const f = await fixture(t); await writeFile(path.join(f.cwd, 'USER.md'), '');
  await files(f.outside, 1300, 'A-unrelated-');
  const wanted = path.join(f.outside, 'Z Résumé final draft.PDF'); await writeFile(wanted, 'synthetic');
  const listed = read(await handler(f)(call({ action: 'list', path: f.outside, limit: 100 })));
  assert.equal(listed.truncated, true); assert.ok(!listed.entries.some(x => x.path === wanted));
  const started = performance.now();
  const pages = await drain(f, { action: 'find', path: f.outside, query: 'résumé', extensions: ['PDF'], timeoutMs: 10000 });
  assert.deepEqual(pages.flatMap(x => x.matches.map(y => y.path)), [wanted]);
  assert.equal(pages.at(-1).searchComplete, true); assert.equal(pages.at(-1).scannedEntries, 1301);
  const scanMs = performance.now() - started;
  t.diagnostic(JSON.stringify({ scanMs: Number(scanMs.toFixed(2)), entries: pages.at(-1).scannedEntries, results: pages.flatMap(x => x.matches).length, pages: pages.length }));
  assert.ok(scanMs < 15000, '1301-entry fixture should complete within 15 seconds');
  assert.ok(WORKSPACE_TOOL.inputSchema.properties.action.enum.includes('find'));
});

test('find pages survive handler recreation, replay is stable, and continuation has no gaps or duplicates', async t => {
  const f = await fixture(t); await files(f.outside, 105);
  const first = read(await handler(f)(call({ action: 'find', path: f.outside, query: 'Item', limit: 7 })));
  assert.equal(first.matches.length, 7); assert.equal(first.searchComplete, false); assert.ok(first.cursor);
  const second = read(await handler(f)(call({ action: 'find', cursor: first.cursor, limit: 7 })));
  const repeated = read(await handler(f)(call({ action: 'find', cursor: first.cursor, limit: 7 })));
  assert.deepEqual(repeated, second);
  const pages = [first, second];
  await drain(f, { action: 'find', cursor: second.cursor, limit: 7 }, pages);
  const matches = pages.flatMap(x => x.matches.map(y => y.path));
  assert.equal(matches.length, 105); assert.equal(new Set(matches).size, 105);
  assert.equal(pages.at(-1).scanComplete, true); assert.equal(pages.at(-1).searchComplete, true);
  const stale = await handler(f)(call({ action: 'find', cursor: first.cursor }));
  assert.equal(stale.success, false); assert.equal(decoded(stale).code, 'FILE_SEARCH_CURSOR_STALE');
});

test('find rejects malformed, foreign and changed-filter cursors without advancing', async t => {
  const f = await fixture(t); await files(f.outside, 5);
  const first = read(await handler(f)(call({ action: 'find', path: f.outside, query: 'Item', limit: 1 })));
  const foreign = await handler({ ...f, scope: randomUUID() })(call({ action: 'find', cursor: first.cursor }));
  assert.equal(foreign.success, false); assert.equal(decoded(foreign).code, 'FILE_SEARCH_CURSOR_EXPIRED');
  const changed = await handler(f)(call({ action: 'find', cursor: first.cursor, query: 'different' }));
  assert.equal(changed.success, false);
  const malformed = await handler(f)(call({ action: 'find', cursor: 'bad' }));
  assert.equal(malformed.success, false); assert.equal(decoded(malformed).code, 'FILE_SEARCH_CURSOR_INVALID');
  const pages = await drain(f, { action: 'find', cursor: first.cursor });
  assert.equal(pages.flatMap(x => x.matches).length, 4);
});

test('find reports empty and missing-root coverage honestly, supports literal paths and file roots', async t => {
  const f = await fixture(t);
  const empty = read(await handler(f)(call({ action: 'find', path: f.outside, query: 'none' })));
  assert.equal(empty.searchComplete, true); assert.equal(empty.cursor, null); assert.deepEqual(empty.matches, []);
  const missing = read(await handler(f)(call({ action: 'find', path: path.join(f.root, 'missing'), query: 'none' })));
  assert.equal(missing.scanComplete, true); assert.equal(missing.searchComplete, false); assert.equal(missing.errorCount, 1); assert.equal(missing.errors[0].code, 'ENOENT');
  const document = path.join(f.outside, 'plain.txt'); await writeFile(document, 'not searched');
  const pathResult = read(await handler(f)(call({ action: 'find', path: document, query: 'outside docs', match: 'path' })));
  assert.equal(pathResult.matches[0].path, document); assert.equal(pathResult.searchComplete, true);
});

test('find cancellation rejects and invalidates the partial traversal cursor', async t => {
  const f = await fixture(t); await files(f.outside, 1300);
  const first = read(await handler(f)(call({ action: 'find', path: f.outside, query: 'Item', limit: 1 })));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1);
  try {
    await assert.rejects(handler(f)(call({ action: 'find', cursor: first.cursor, limit: 100, timeoutMs: 10000 }), { signal: controller.signal }), error => error.name === 'AbortError');
  } finally { clearTimeout(timer); }
  // Pre-dispatch cancellation may legitimately leave an unconsumed cursor intact;
  // an in-flight traversal must release it. Exercise explicit in-flight cancellation
  // using a callback signal that turns true only after filesystem traversal begins.
  let reads = 0;
  const signal = { get aborted() { return ++reads > 10; } };
  const initial = read(await handler(f)(call({ action: 'find', path: f.outside, query: 'Item', limit: 1 })));
  await assert.rejects(createWorkspaceToolHandler({ cwd: f.cwd, fileSearchScope: f.scope, signal })(call({ action: 'find', cursor: initial.cursor, limit: 100 })), error => error.name === 'AbortError');
  const resumed = await handler(f)(call({ action: 'find', cursor: initial.cursor }));
  assert.equal(resumed.success, false); assert.equal(decoded(resumed).code, 'FILE_SEARCH_CURSOR_EXPIRED');
});

test('find bounds long-path pages and returns every match through output-budget continuation', async t => {
  const f = await fixture(t);
  const deep = path.join(f.outside, 'a'.repeat(90)); await mkdir(deep);
  await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(path.join(deep, `match-${i}-${'b'.repeat(80)}.txt`), '')));
  const pages = await drain(f, { action: 'find', path: f.outside, query: 'match-', limit: 100, timeoutMs: 10000 });
  assert.ok(pages.length >= 2); assert.ok(pages.some(x => x.stopReason === 'output_budget'));
  assert.equal(pages.flatMap(x => x.matches).length, 100); assert.equal(pages.at(-1).searchComplete, true);
});

test('find identifies skipped symlinks instead of claiming exhaustive absence', async t => {
  const f = await fixture(t); const link = path.join(f.outside, 'linked');
  try { await symlink(f.cwd, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('Host does not allow creating a synthetic link'); return; } throw e; }
  const result = read(await handler(f)(call({ action: 'find', path: f.outside, query: 'missing' })));
  assert.equal(result.scanComplete, true); assert.equal(result.searchComplete, false);
  assert.equal(result.skippedCount, 1); assert.equal(result.errors[0].code, 'SYMLINK_NOT_FOLLOWED');
});


test('find normalizes repeated extension filters and removes overlapping roots', async t => {
  const f = await fixture(t); const nested = path.join(f.outside, 'nested'); await mkdir(nested);
  await files(nested, 12);
  const first = read(await handler(f)(call({ action: 'find', roots: [f.outside, nested], query: 'Item', extensions: ['.TXT'], limit: 2 })));
  const pages = [first]; await drain(f, { action: 'find', cursor: first.cursor, roots: [f.outside, nested], extensions: ['.TXT'], limit: 2 }, pages);
  const matches = pages.flatMap(x => x.matches.map(y => y.path));
  assert.equal(matches.length, 12); assert.equal(new Set(matches).size, 12);
});


test('default discovery consumes resolved OS locations without USER.md or personal path guesses', async t => {
  const f = await fixture(t); await writeFile(path.join(f.outside, 'Résumé.pdf'), 'synthetic');
  let discoveries = 0;
  const search = createFileSearch({ cwd: f.cwd, scope: f.scope, resolveLocations: async cwd => {
    discoveries++; assert.equal(cwd, f.cwd);
    return { roots: [cwd, f.outside], errors: [] };
  } });
  const result = await search({ query: 'résumé' });
  assert.equal(discoveries, 1); assert.equal(result.matches[0].path, path.join(f.outside, 'Résumé.pdf'));
  assert.equal(result.searchComplete, true);
  const incomplete = createFileSearch({ cwd: f.cwd, scope: f.scope, resolveLocations: async cwd => ({ roots: [cwd], errors: [{ path: f.outside, code: 'COMMON_FOLDERS_UNAVAILABLE' }] }) });
  const missed = await incomplete({ query: 'résumé' });
  assert.equal(missed.scanComplete, true); assert.equal(missed.searchComplete, false); assert.equal(missed.errorCount, 1);
});

test('concurrent use of one continuation cannot consume a page twice', async t => {
  const f = await fixture(t); await files(f.outside, 150);
  const first = read(await handler(f)(call({ action: 'find', path: f.outside, query: 'Item', limit: 1 })));
  const [left, right] = await Promise.all([
    handler(f)(call({ action: 'find', cursor: first.cursor, limit: 100 })),
    handler(f)(call({ action: 'find', cursor: first.cursor, limit: 100 })),
  ]);
  const succeeded = [left, right].filter(x => x.success), failed = [left, right].filter(x => !x.success);
  assert.ok(succeeded.length >= 1);
  if (failed.length) assert.equal(decoded(failed[0]).code, 'FILE_SEARCH_BUSY');
  if (succeeded.length === 2) assert.deepEqual(read(succeeded[0]), read(succeeded[1]), 'late competing caller must receive replay, not next page');
  const second = read(succeeded[0]);
  const pages = [first, second]; await drain(f, { action: 'find', cursor: second.cursor }, pages);
  const all = pages.flatMap(x => x.matches.map(y => y.path));
  assert.equal(all.length, 150); assert.equal(new Set(all).size, 150);
});


test('an inaccessible child is reported without aborting readable sibling discovery', async t => {
  const f = await fixture(t); const blocked = path.join(f.outside, 'blocked');
  await mkdir(blocked); await writeFile(path.join(f.outside, 'Resume.txt'), 'synthetic');
  const opendir = fs.opendir;
  t.mock.method(fs, 'opendir', async (...args) => {
    if (String(args[0]) === blocked) throw Object.assign(new Error('Synthetic permission denial'), { code: 'EACCES' });
    return opendir(...args);
  });
  const pages = await drain(f, { action: 'find', path: f.outside, query: 'Resume' });
  assert.equal(pages.flatMap(x => x.matches).length, 1);
  assert.equal(pages.at(-1).scanComplete, true); assert.equal(pages.at(-1).searchComplete, false);
  assert.ok(pages.flatMap(x => x.errors).some(x => x.path === blocked && x.code === 'EACCES'));
});

test('filesystem mutations between pages remain live observations rather than a claimed snapshot', async t => {
  const f = await fixture(t); await files(f.outside, 3);
  const first = read(await handler(f)(call({ action: 'find', path: f.outside, query: 'Item', limit: 1 })));
  const original = Array.from({ length: 3 }, (_, i) => path.join(f.outside, `Item${String(i).padStart(5, '0')}.txt`));
  const remaining = original.filter(x => x !== first.matches[0].path), [deleted, changed] = remaining;
  await rm(deleted); await writeFile(changed, 'x'.repeat(42));
  const added = path.join(f.outside, 'Item-new.txt'); await writeFile(added, 'new');
  const pages = await drain(f, { action: 'find', cursor: first.cursor });
  const matches = pages.flatMap(x => x.matches);
  assert.ok(!matches.some(x => x.path === deleted));
  assert.equal(matches.find(x => x.path === changed)?.size, 42);
  assert.ok(pages.flatMap(x => x.errors).some(x => x.path === deleted && x.code === 'ENOENT'));
  assert.equal(pages.at(-1).searchComplete, false);
  for (const page of [first, ...pages]) assert.match(page.coverage, /Filesystem changes during pagination may affect results/);
  // The added entry may or may not appear in an already-open OS directory stream.
  // The contract promises current observations, not a stable filesystem snapshot.
  const fresh = await drain(f, { action: 'find', path: f.outside, query: 'Item-new' });
  assert.equal(fresh.flatMap(x => x.matches)[0].path, added);
});

test('escaped discovery error paths remain within serialized budgets and preserve coverage', async t => {
  const f = await fixture(t);
  const errorPath = '\\\"\r\n\t'.repeat(500);
  const search = createFileSearch({ cwd: f.cwd, scope: f.scope, resolveLocations: async cwd => ({
    roots: [cwd], errors: Array.from({ length: 30 }, () => ({ path: errorPath, code: 'EACCES' })),
  }) });
  const result = await search({ query: 'Resume' });
  assert.equal(result.errorCount, 30); assert.equal(result.errors.length, 12);
  assert.ok(result.errors.every(x => JSON.stringify(x).length <= 800));
  assert.ok(JSON.stringify(result).length <= 35000);
  assert.equal(result.searchComplete, false); assert.equal(result.scanComplete, true); assert.equal(result.cursor, null);
});
