import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

const assetPath = '/assets/blackice-field.svg';
const stylePath = '/blackice-material.css';
const layoutPath = '/conversation-layout.css';
const local = pathname => readFile(new URL('../public' + pathname, import.meta.url));

test('the active ice scene is compact editable vector geometry with locally resolved materials', async () => {
  const bytes = await local(assetPath), svg = bytes.toString('utf8');
  assert.ok(bytes.length < 80_000, 'the quiet scene should not need thousands of texture objects');
  assert.match(svg, /<svg\b[^>]*viewBox="0 0 1920 1200"/);
  assert.match(svg, /<title\b[^>]*>BLACKICE/);
  assert.match(svg, /<desc\b/);
  assert.match(svg, /<path\b/);
  assert.match(svg, /inkscape:groupmode="layer"/,'named geometry layers are editable in vector tools');
  assert.doesNotMatch(svg, /<image\b|<script\b|<foreignObject\b|\bhref\s*=|data:|@import/i,'the SVG must not wrap a raster or load active/remote content');
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'gradient and editing-layer identifiers remain unambiguous');
  for (const reference of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(reference[1]), `unresolved SVG paint ${reference[1]}`);
  assert.ok(svg.trim().endsWith('</svg>'));
});

test('the entry document preloads the exact local scene and orders material before chat geometry', async () => {
  const html = (await local('/index.html')).toString('utf8');
  const styleLinks = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map(match => match[1]);
  assert.deepEqual(styleLinks.slice(-2), [stylePath, layoutPath], 'shared materials follow components, then chat geometry owns its responsive layout');
  const imagePreloads = [...html.matchAll(/<link\b[^>]*rel="preload"[^>]*as="image"[^>]*href="([^"]+)"[^>]*>/g)].map(match => match[1]);
  assert.deepEqual(imagePreloads, [assetPath], 'one shared scene is fetched for the initial view');
  const css = (await local(stylePath)).toString('utf8');
  const media = [...css.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(media)], [assetPath]);
  assert.ok(!/@import\b/i.test(css), 'the theme must work without remote CSS');
});

test('the running application serves the editable scene intact with SVG MIME and HEAD semantics', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-material-'));
  class Runtime extends EventEmitter {
    status() { return {connected: false, authenticated: false, models: [], defaultModel: 'fixture'}; }
    async start() { return this.status(); }
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
  const page = await fetch(new URL('/', address));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes(`href="${stylePath}"`) && html.includes(`href="${assetPath}"`) && html.includes(`href="${layoutPath}"`));
  const [scene, style, head, layout] = await Promise.all([
    fetch(new URL(assetPath, address)),
    fetch(new URL(stylePath, address)),
    fetch(new URL(assetPath, address), {method: 'HEAD'}),
    fetch(new URL(layoutPath, address)),
  ]);
  assert.equal(scene.status, 200);
  assert.equal(scene.headers.get('content-type'), 'image/svg+xml');
  assert.deepEqual(Buffer.from(await scene.arrayBuffer()), await local(assetPath));
  assert.equal(style.status, 200);
  assert.match(style.headers.get('content-type'), /^text\/css/);
  assert.deepEqual(Buffer.from(await style.arrayBuffer()), await local(stylePath));
  assert.equal(layout.status, 200);
  assert.match(layout.headers.get('content-type'), /^text\/css/);
  assert.deepEqual(Buffer.from(await layout.arrayBuffer()), await local(layoutPath));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'image/svg+xml');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const missing = await fetch(new URL('/assets/blackice-unregistered.svg', address));
  assert.equal(missing.status, 404, 'adding the scene must not expose arbitrary files');
});
