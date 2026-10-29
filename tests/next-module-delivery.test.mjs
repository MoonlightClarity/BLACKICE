import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

class FixtureRuntime extends EventEmitter {
  status() { return { connected: true, authenticated: true, models: [], activeTurns: 0 }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { assert.fail('Static module delivery must never start a model.'); }
}
class FixtureDesktop extends EventEmitter {
  status() { return { available: false, enabled: false }; }
  async setEnabled() { return this.status(); }
}

test('every reachable V2 browser import is actually served over HTTP, including lazy Tasks and Planning modules', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-module-delivery-'));
  let app;
  t.after(async () => {
    await app?.close();
    assert.match(path.basename(directory), /^blackice-module-delivery-/);
    await rm(directory, { recursive: true, force: true });
  });
  app = await createHarnessServer({ port: 0, dataDir: path.join(directory, 'data'),
    defaultCwd: path.join(directory, 'workspace'), runtime: new FixtureRuntime(),
    desktop: new FixtureDesktop(), autoAttachDesktop: false });
  await app.learning.updateSettings({ mode: 'off' });
  const origin = new URL(await app.listen());
  const queue = [{ route: '/next/app.mjs', importer: 'workspace entry point' }], visited = new Set();
  for (let index = 0; index < queue.length; index++) {
    const { route, importer } = queue[index];
    if (visited.has(route)) continue;
    assert.ok(visited.size < 256, 'Unexpectedly large frontend import graph.');
    visited.add(route);
    const response = await fetch(new URL(route, origin), { signal: AbortSignal.timeout(5000) });
    const source = await response.text();
    assert.equal(response.status, 200, `${importer} imports ${route}, but HTTP returned ${response.status}: ${source.slice(0, 160)}`);
    assert.match(response.headers.get('content-type') || '', /javascript/, route + ' must be a JavaScript response, not a fallback page.');
    assert.equal(response.headers.get('cache-control'), 'no-store', route + ' must not retain stale module contents.');
    const checkedIn = await readFile(new URL('../public' + route, import.meta.url), 'utf8');
    assert.equal(source, checkedIn, route + ' must serve its actual source bytes.');
    // Includes static imports/re-exports, side-effect imports and literal dynamic imports.
    // Browsers resolve these as URLs; filesystem existence alone does not establish delivery.
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)(['"])([./][^'"\r\n]+)\1/g)) {
      const target = new URL(match[2], new URL(route, origin));
      if (!/\.(?:mjs|js)$/.test(target.pathname)) continue;
      assert.equal(target.origin, origin.origin, 'Local modules must not silently change origin.');
      queue.push({ route: target.pathname + target.search, importer: route });
    }
  }
  for (const required of ['/next/workspaces/tasks.mjs', '/next/workspaces/planning.mjs',
    '/next/workspaces/schedule-inspection-model.mjs', '/next/chat/planning-timeline.mjs']) {
    assert.ok(visited.has(required), 'The actual browser import graph must cover ' + required);
  }
  t.diagnostic(`Verified ${visited.size} browser modules through the real HTTP server.`);
});
