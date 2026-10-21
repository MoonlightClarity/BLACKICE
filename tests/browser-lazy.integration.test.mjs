import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
test('restored hidden browser tabs defer requests until used and never load closed or replaced pages', { skip: process.env.RELAY_LIVE_BROWSER_QA !== '1' && 'Set RELAY_LIVE_BROWSER_QA=1 for disposable Electron restoration.', timeout: 75000 }, async t => {
  const tempRoot = path.resolve(tmpdir()), dataDir = await mkdtemp(path.join(tempRoot, 'relay-browser-lazy-'));
  assert.ok(path.resolve(dataDir).startsWith(`${tempRoot}${path.sep}`)); assert.match(path.basename(dataDir), /^relay-browser-lazy-/);
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [fileURLToPath(new URL('./fixtures/browser-lazy-live.mjs', import.meta.url)), `--fixture-data=${dataDir}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-6000); });
  const timeout = setTimeout(() => child.kill(), 60000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timeout));
  let result; try { result = JSON.parse(await readFile(path.join(dataDir, 'result.json'), 'utf8')); } catch { assert.fail(`Disposable restoration fixture saved no result (exit ${code}). ${output}`); }
  assert.equal(code, 0, result.error || output); assert.equal(result.ok, true, result.error);
  for (const check of ['noStartupRequests', 'closedPageNeverLoaded', 'firstReadLoadsPage', 'navigateSkipsStaleURL', 'reloadLoadsOnce', 'hidden']) assert.equal(result[check], true, check);
});
