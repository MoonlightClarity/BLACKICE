import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

for (const mode of ['live', 'offscreen']) test(
  mode + ' contained input updates application state and delivers editing keys without OS focus',
  { skip: process.env.RELAY_LIVE_BROWSER_QA !== '1' && 'Set RELAY_LIVE_BROWSER_QA=1 for the isolated native fixture.', timeout: 50000 },
  async t => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-input-focus-' + mode + '-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    const require = createRequire(import.meta.url);
    const fixture = fileURLToPath(new URL('./fixtures/browser-input-focus-live.mjs', import.meta.url));
    const child = spawn(require('electron'), [fixture, '--fixture-data=' + directory, '--fixture-mode=' + mode],
      { env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-6000); });
    const timer = setTimeout(() => child.kill(), 45000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
    const report = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
    assert.equal(code, 0, report.error || output);
    assert.equal(report.ok, true, report.error);
    assert.equal(report.liveProfileAccessed, false);
    assert.equal(report.onlyLoopback, true);
    assert.ok(report.checks.length >= 6);
  },
);
