import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { BrowserProtection, PROTECTION_SOURCES, decodeProtectionBundle, protectionOrigin } from '../lib/browser-protection.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const rules = ['[Adblock Plus 2.0]', '||ads.fixture.test^$script', '@@||ads.fixture.test/allowed.js$script', '||tracker.fixture.test^'];
function bundle(texts = [rules.join('\n'), '[Adblock Plus 2.0]\n||metrics.fixture.test^']) {
  const bytes = Buffer.from(texts.join('\n'));
  return { schema: 1, encoding: 'gzip-base64', fetchedAt: '2026-10-19T00:00:00.000Z', sources: PROTECTION_SOURCES.map((source, index) => ({ ...source, bytes: Buffer.byteLength(texts[index]), sha256: sha(texts[index]) })), sha256: sha(bytes), bytes: bytes.length, data: gzipSync(bytes).toString('base64') };
}
async function fixture(t, { bundled = false, saved, cache, ...options } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-browser-protection-')), bundledFile = path.join(directory, 'owned-bundle.json');
  await writeFile(bundledFile, JSON.stringify(bundle()));
  if (saved !== undefined) await writeFile(path.join(directory, 'browser-protection.json'), typeof saved === 'string' ? saved : JSON.stringify(saved));
  if (cache !== undefined) await writeFile(path.join(directory, 'browser-protection-filters.json'), typeof cache === 'string' ? cache : JSON.stringify(cache));
  const protection = new BrowserProtection({ dataDir: directory, ...(bundled ? {} : { bundledFile, minimumRules: 1 }), ...options });
  t.after(async () => { await protection.close(); assert.match(path.basename(directory), /^blackice-browser-protection-/); await rm(directory, { recursive: true, force: true }); });
  await protection.init(); return { protection, directory, bundledFile };
}
const ad = (protection, extra = {}) => protection.match({ url: 'https://ads.fixture.test/ad.js', sourceUrl: 'https://article.fixture.test/story', type: 'script', tabId: 'observed', ...extra });
const textResponse = text => new Response(text, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

test('the pinned production Ghostery engine loads bundled network rules and blocks real ad and tracker URLs', async t => {
  let requests = 0;
  const { protection } = await fixture(t, { bundled: true, fetch: () => { requests++; assert.fail('Startup must use the verified bundled filters without network access.'); } });
  const status = protection.status(); assert.equal(status.ready, true); assert.equal(status.engineVersion, '2.20.1'); assert.equal(status.mode, 'network-only'); assert.ok(status.filterCount > 100000); assert.equal(status.source, 'bundled'); assert.equal(requests, 0);
  for (const url of ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'https://www.google-analytics.com/analytics.js']) assert.equal(protection.match({ url, sourceUrl: 'https://example.com/article', type: 'script', tabId: 'real-rules' }).cancel, true, url);
  assert.equal(protection.match({ url: 'https://example.com/article.png', sourceUrl: 'https://example.com/article', type: 'image', tabId: 'real-rules' }).cancel, false);
  assert.equal(protection.tabStatus('real-rules', 'https://example.com/article').blockedRequests, 2);
});

test('actual network matching respects request types and filter exceptions without logging destinations', async t => {
  const { protection } = await fixture(t);
  assert.equal(ad(protection).cancel, true); assert.equal(ad(protection, { type: 'image' }).cancel, false); assert.equal(ad(protection, { url: 'https://ads.fixture.test/allowed.js' }).cancel, false);
  assert.equal(ad(protection, { url: 'wss://tracker.fixture.test/socket', type: 'webSocket' }).cancel, true);
  assert.equal(protection.status().blockedRequests, 2); assert.equal(protection.tabStatus('observed', 'https://article.fixture.test/story').blockedRequests, 2);
  assert.doesNotMatch(JSON.stringify(protection.status()), /ad\.js|article\.fixture|tracker\.fixture/);
  protection.forgetTab('observed'); assert.equal(protection.tabStatus('observed', 'https://article.fixture.test/').blockedRequests, 0); assert.equal(protection.status().blockedRequests, 2);
});

test('a site exception is bound to the observed current origin and never borrowed by another origin or unattributed worker', async t => {
  const { protection } = await fixture(t), origin = 'https://article.fixture.test';
  await protection.configure({ action: 'site', tabId: 'observed', origin, enabled: false }, { currentOrigin: id => id === 'observed' ? origin : null });
  assert.equal(ad(protection).cancel, false); assert.equal(ad(protection, { sourceUrl: 'http://article.fixture.test/story' }).cancel, true); assert.equal(ad(protection, { sourceUrl: 'https://article.fixture.test:8443/story' }).cancel, true);
  assert.equal(ad(protection, { tabId: undefined }).cancel, true); assert.equal(ad(protection, { type: 'mainFrame', url: 'https://tracker.fixture.test/new-page' }).cancel, true);
  assert.equal(protection.status().blockedRequests, 4);
  assert.deepEqual(protection.tabStatus('observed', 'about:blank'), { available: true, ready: true, origin: null, siteExempt: false, enabled: true, enforced: true, blockedRequests: 3 });
  const status = protection.tabStatus('observed', origin); assert.equal(status.available, true); assert.equal(status.origin, origin); assert.equal(status.siteExempt, true); assert.equal(status.enabled, false);
});

test('global and exact-site choices persist and disabling globally retains truthful site metadata', async t => {
  const { protection, directory, bundledFile } = await fixture(t), origin = 'https://article.fixture.test';
  await protection.configure({ action: 'site', tabId: 'observed', origin, enabled: false }, { currentOrigin: () => origin }); await protection.configure({ action: 'global', enabled: false });
  assert.equal(ad(protection, { sourceUrl: 'https://other.fixture.test/' }).cancel, false);
  const before = protection.tabStatus('observed', origin); assert.equal(before.available, true); assert.equal(before.siteExempt, true); assert.equal(before.origin, origin); assert.equal(before.enabled, false);
  const restored = new BrowserProtection({ dataDir: directory, bundledFile, minimumRules: 1 }); t.after(() => restored.close()); await restored.init();
  assert.equal(restored.status().enabled, false); assert.deepEqual(restored.status().exemptOrigins, [origin]);
  await restored.configure({ action: 'global', enabled: true }); assert.equal(ad(restored).cancel, false); assert.equal(ad(restored, { sourceUrl: 'https://other.fixture.test/' }).cancel, true);
  await restored.configure({ action: 'site', tabId: 'observed', origin, enabled: true }, { currentOrigin: () => origin }); assert.equal(ad(restored).cancel, true);
  const saved = JSON.parse(await readFile(path.join(directory, 'browser-protection.json'), 'utf8')); assert.deepEqual(saved, { schema: 1, enabled: true, exemptOrigins: [] });
});

test('navigation between preparation and durable commit rejects an exemption and preserves the saved choices', async t => {
  const { protection, directory } = await fixture(t); await protection.configure({ action: 'global', enabled: true });
  const file = path.join(directory, 'browser-protection.json'), before = await readFile(file, 'utf8'); let observations = 0;
  await assert.rejects(protection.configure({ action: 'site', tabId: 'observed', origin: 'https://article.fixture.test', enabled: false }, { currentOrigin: () => ++observations === 1 ? 'https://article.fixture.test' : 'https://new.fixture.test' }), { code: 'BROWSER_PROTECTION_STALE_TAB', status: 409 });
  assert.equal(observations, 2); assert.equal(await readFile(file, 'utf8'), before); assert.deepEqual(protection.status().exemptOrigins, []); assert.equal(ad(protection).cancel, true);
});

test('unobserved, ambiguous, wildcard and extra-field site requests cannot change protection', async t => {
  const { protection } = await fixture(t);
  const invalid = [
    { action: 'site', origin: 'https://article.fixture.test', enabled: false },
    { action: 'site', tabId: 'unobserved', origin: 'https://article.fixture.test', enabled: false },
    { action: 'site', tabId: 'observed', origin: 'https://article.fixture.test/', enabled: false },
    { action: 'site', tabId: 'observed', origin: '*.fixture.test', enabled: false },
    { action: 'site', tabId: 'observed', origin: 'https://user:password@article.fixture.test', enabled: false },
    { action: 'site', tabId: 'observed', origin: 'file:///C:/private', enabled: false },
    { action: 'global', enabled: 'false' }, { action: 'global', enabled: false, source: 'agent' }, { action: 'refresh', url: 'https://elsewhere.test/list' },
  ];
  for (const value of invalid) await assert.rejects(protection.configure(value, { currentOrigin: () => null }));
  assert.equal(protection.status().enabled, true); assert.deepEqual(protection.status().exemptOrigins, []);
  assert.equal(protectionOrigin('https://example.test/a?q=secret'), 'https://example.test'); assert.equal(protectionOrigin('data:text/html,example'), null);
});

test('unreadable settings are preserved with protection enabled and cannot be silently overwritten', async t => {
  const original = '{"schema":1,"enabled":false,"exemptOrigins":["*"]}', { protection, directory } = await fixture(t, { saved: original });
  assert.equal(protection.status().settingsHealthy, false); assert.equal(protection.status().enabled, true); assert.equal(ad(protection).cancel, true);
  await assert.rejects(protection.configure({ action: 'global', enabled: false }), { code: 'BROWSER_PROTECTION_SETTINGS_UNREADABLE' });
  assert.equal(await readFile(path.join(directory, 'browser-protection.json'), 'utf8'), original);
});

test('a corrupt saved update falls back to the bundled rules and retains the original update for recovery', async t => {
  const { protection, directory } = await fixture(t, { cache: '{invalid' });
  assert.equal(protection.status().ready, true); assert.equal(protection.status().source, 'bundled'); assert.equal(protection.status().error.code, 'BROWSER_PROTECTION_CACHE_UNREADABLE'); assert.equal(ad(protection).cancel, true);
  assert.equal(await readFile(path.join(directory, 'browser-protection-filters.json'), 'utf8'), '{invalid');
});

test('missing filters visibly fail closed until a person explicitly disables protection', async t => {
  const { protection } = await fixture(t, { compile: async () => { throw new Error('Invalid fixture rules'); } });
  assert.equal(protection.status().ready, false); assert.equal(protection.status().error.code, 'BROWSER_PROTECTION_FILTERS_UNAVAILABLE'); assert.equal(ad(protection).reason, 'filters-unavailable');
  await protection.configure({ action: 'global', enabled: false }); assert.equal(ad(protection).cancel, false); assert.equal(protection.status().ready, false);
});

test('filter bundle integrity, bounded sizes and fixed source identities are verified before compilation', () => {
  const original = bundle(); assert.match(decodeProtectionBundle(original).text, /ads\.fixture/);
  for (const change of [value => { value.sha256 = 'a'.repeat(64); }, value => { value.bytes++; }, value => { value.data = 'AAAA'; }, value => { value.bytes = 17 * 1024 * 1024; }, value => { value.sources[0].url = 'http://easylist.to/easylist/easylist.txt'; }, value => { value.sources.push(value.sources[0]); }, value => { value.fetchedAt = 'invalid'; }]) {
    const value = structuredClone(original); change(value); assert.throws(() => decodeProtectionBundle(value), { code: 'BROWSER_PROTECTION_FILTERS_INVALID' });
  }
});

test('explicit refresh coalesces, fetches only fixed HTTPS text lists and atomically loads the updated engine', async t => {
  const calls = [], texts = ['[Adblock Plus 2.0]\n||new-ads.fixture.test^', '[Adblock Plus 2.0]\n||new-tracker.fixture.test^'];
  const { protection, directory, bundledFile } = await fixture(t, { fetch: async (url, options) => { calls.push({ url, options }); return textResponse(texts[calls.length - 1]); } });
  assert.equal(calls.length, 0); const first = protection.refresh(), second = protection.refresh(); assert.equal(first, second); assert.equal(protection.status().refreshing, true); await first;
  assert.deepEqual(calls.map(call => call.url), PROTECTION_SOURCES.map(source => source.url)); for (const call of calls) { assert.equal(call.options.redirect, 'error'); assert.equal(call.options.headers.Accept, 'text/plain'); assert.ok(call.options.signal instanceof AbortSignal); }
  assert.equal(protection.status().refreshing, false); assert.equal(protection.status().source, 'updated'); assert.equal(protection.status().error, null); assert.equal(protection.match({ url: 'https://new-ads.fixture.test/a.js', type: 'script', sourceUrl: 'https://example.test/' }).cancel, true);
  const cached = JSON.parse(await readFile(path.join(directory, 'browser-protection-filters.json'), 'utf8')); assert.equal(decodeProtectionBundle(cached).metadata.sha256, sha(texts.join('\n')));
  await writeFile(bundledFile, '{invalid'); const restored = new BrowserProtection({ dataDir: directory, bundledFile, minimumRules: 1 }); t.after(() => restored.close()); await restored.init(); assert.equal(restored.status().source, 'updated'); assert.equal(restored.status().ready, true);
});

test('failed, redirected, oversized or non-text refreshes retain the last working engine and saved cache', async t => {
  let mode = 'valid'; const valid = '[Adblock Plus 2.0]\n||ads.fixture.test^';
  const { protection, directory } = await fixture(t, { fetch: async () => {
    if (mode === 'failure') throw new Error('bounded fixture failure');
    if (mode === 'html') return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
    if (mode === 'oversized') return new Response(valid, { headers: { 'Content-Type': 'text/plain', 'Content-Length': String(9 * 1024 * 1024) } });
    if (mode === 'redirect') return { ok: true, url: 'https://foreign.fixture.test/list', headers: new Headers({ 'Content-Type': 'text/plain' }), body: new Response(valid).body };
    if (mode === 'empty') return textResponse('[Adblock Plus 2.0]\n! no usable network rules');
    return textResponse(valid);
  } });
  await protection.refresh(); const before = await readFile(path.join(directory, 'browser-protection-filters.json'), 'utf8'), count = protection.status().filterCount;
  for (mode of ['failure', 'html', 'oversized', 'redirect', 'empty']) {
    await assert.rejects(protection.refresh(), { code: 'BROWSER_PROTECTION_REFRESH_FAILED' }); assert.equal(protection.status().refreshing, false); assert.equal(protection.status().ready, true); assert.equal(protection.status().filterCount, count); assert.equal(ad(protection).cancel, true); assert.equal(await readFile(path.join(directory, 'browser-protection-filters.json'), 'utf8'), before);
  }
  mode = 'valid'; await protection.refresh(); assert.equal(protection.status().error, null);
});

test('shutdown aborts an in-flight refresh and prevents late filter or settings writes', async t => {
  let entered; const requested = new Promise(resolve => { entered = resolve; });
  const { protection, directory } = await fixture(t, { fetch: async (_url, { signal }) => { entered(); return new Promise((_resolve, reject) => { const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }); } });
  const refreshing = protection.refresh(), rejected = assert.rejects(refreshing, { code: 'BROWSER_PROTECTION_REFRESH_FAILED' }); await requested; await protection.close(); await rejected;
  await assert.rejects(access(path.join(directory, 'browser-protection-filters.json')), { code: 'ENOENT' }); assert.equal(protection.status().available, false); assert.equal(ad(protection).reason, 'closed'); await assert.rejects(protection.configure({ action: 'global', enabled: false }), { code: 'BROWSER_CLOSED' });
});

test('a pre-cancelled settings action never changes persisted protection', async t => {
  const { protection, directory } = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(protection.configure({ action: 'global', enabled: false }, { signal: controller.signal }), { code: 'ABORT_ERR' });
  assert.equal(protection.status().enabled, true); await assert.rejects(access(path.join(directory, 'browser-protection.json')), { code: 'ENOENT' });
});
