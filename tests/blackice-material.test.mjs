import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

const assetPath = '/assets/blackice-depth.png';
const retainedScenePath = '/assets/blackice-field.svg';
const materialPath = '/blackice-material.css';
const stylePath = '/blackice-information.css';
const layoutPath = '/conversation-layout.css';
const local = pathname => readFile(new URL('../public' + pathname, import.meta.url));

test('the local black ice photograph is a bounded PNG with a full scene resolution', async () => {
  const bytes = await local(assetPath);
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.ok(bytes.length < 4_000_000, 'the shared photograph remains bounded');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width >= 1200 && height >= 600 && width <= 4096 && height <= 4096);
});

test('the retained vector scene keeps editable geometry and locally resolved materials', async () => {
  const bytes = await local(retainedScenePath), svg = bytes.toString('utf8');
  assert.ok(bytes.length < 80_000);
  assert.match(svg, /<svg\b[^>]*viewBox="0 0 1920 1200"/);
  assert.match(svg, /<title\b[^>]*>BLACKICE/);
  assert.match(svg, /<desc\b/);
  assert.match(svg, /<path\b/);
  assert.match(svg, /inkscape:groupmode="layer"/, 'named geometry layers remain editable');
  assert.doesNotMatch(svg, /<image\b|<script\b|<foreignObject\b|\bhref\s*=|data:|@import/i);
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const reference of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(reference[1]), 'unresolved SVG paint ' + reference[1]);
  assert.ok(svg.trim().endsWith('</svg>'));
});

test('the entry document preloads the local photograph and applies information hierarchy after chat geometry', async () => {
  const html = (await local('/index.html')).toString('utf8');
  const styleLinks = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map(match => match[1]);
  assert.deepEqual(styleLinks.slice(-3), [materialPath, layoutPath, stylePath]);
  const preloads = [...html.matchAll(/<link\b[^>]*rel="preload"[^>]*as="image"[^>]*>/g)].map(match => match[0]);
  assert.equal(preloads.length, 1, 'one shared scene is preloaded');
  assert.match(preloads[0], /type="image\/png"/);
  assert.match(preloads[0], /href="\/assets\/blackice-depth\.png"/);
  const css = (await local(stylePath)).toString('utf8');
  const media = [...css.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(media)], [assetPath]);
  assert.doesNotMatch(css, /@import\b/i, 'the theme works without remote CSS');
  assert.ok((await local(materialPath)).toString('utf8').includes(retainedScenePath), 'the retained vector fallback is still checked explicitly');
});

test('the running application serves only registered theme resources intact with MIME and HEAD semantics', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-material-'));
  class Runtime extends EventEmitter {
    status() { return {connected: false, authenticated: false, models: [], defaultModel: 'fixture'}; }
    async start() { return this.status(); }
    async runAgent() { assert.fail('The theme HTTP fixture must not execute a model.'); }
    async close() {}
  }
  class Desktop extends EventEmitter {
    status() { return {enabled: false, available: false}; }
    async setEnabled() { return this.status(); }
    async close() {}
  }
  const app = await createHarnessServer({port: 0, dataDir: path.join(root, 'data'), defaultCwd: root, runtime: new Runtime(), desktop: new Desktop(), autoAttachDesktop: false, showBrowserOS: async () => ({shown: false, focused: false, started: false})});
  t.after(async () => { await app.close(); await rm(root, {recursive: true, force: true}); });
  const address = await app.listen();
  const legacy = await fetch(new URL('/legacy/', address), {redirect: 'manual'});
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), '/');
  const page = await fetch(new URL('/', address));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="next-app"/, 'legacy navigation reaches the current app shell');
  for (const [pathname, mime] of [[assetPath, 'image/png'], [retainedScenePath, 'image/svg+xml'], [stylePath, 'text/css; charset=utf-8'], [materialPath, 'text/css; charset=utf-8'], [layoutPath, 'text/css; charset=utf-8']]) {
    const [response, head] = await Promise.all([fetch(new URL(pathname, address)), fetch(new URL(pathname, address), {method: 'HEAD'})]);
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get('content-type'), mime, pathname);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await local(pathname), pathname + ' keeps the exact checked local bytes');
    assert.equal(head.status, 200, pathname);
    assert.equal(head.headers.get('content-type'), mime, pathname);
    assert.equal((await head.arrayBuffer()).byteLength, 0, pathname);
  }
  for (const pathname of ['/assets/blackice-unregistered.svg', '/assets/blackice-unregistered.png', '/blackice-unregistered.css']) {
    const missing = await fetch(new URL(pathname, address));
    assert.equal(missing.status, 404, 'registering theme resources must not expose arbitrary files');
  }
});
