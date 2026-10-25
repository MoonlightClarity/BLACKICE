import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeAppHost } from '../desktop/native-app-host.mjs';

if (process.platform !== 'win32') throw Error('Run this native window test on an interactive Windows desktop.');
if (process.env.BLACKICE_INTERACTIVE_GUI_TEST !== 'yes') {
  console.log('SKIPPED: live Win32 focus tests require explicit BLACKICE_INTERACTIVE_GUI_TEST=yes.');
  process.exit(0);
}
const root = await mkdtemp(path.join(tmpdir(), 'blackice-native-smoke-'));
const script = fileURLToPath(new URL('./fixture-native-window.ps1', import.meta.url));
const markerHost = path.join(root, 'host.txt');
const markerApp = path.join(root, 'app.txt');
const signal = path.join(root, 'open-dialog.flag');
const fixtures = [];
let manager;
const waitFor = async (action, label, timeout = 15000) => {
  const until = Date.now() + timeout;
  let lastError;
  while (Date.now() < until) {
    try { const result = await action(); if (result) return result; }
    catch (error) { lastError = error; }
    await delay(150);
  }
  throw new Error(label + ' timed out. ' + (lastError?.message || ''));
};
const createWindow = (role, marker) => {
  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden',
    '-File', script, '-Role', role, '-Marker', marker, '-Signal', signal,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  fixtures.push(child);
  return child;
};
try {
  createWindow('host', markerHost);
  createWindow('app', markerApp);
  const hostWindowId = await waitFor(async () => (await readFile(markerHost, 'utf8')).trim(), 'Host window');
  const applicationId = await waitFor(async () => (await readFile(markerApp, 'utf8')).trim(), 'Application window');
  const native = Buffer.alloc(8);
  native.writeBigUInt64LE(BigInt(hostWindowId));
  manager = new NativeAppHost({ getWindow: () => ({ getNativeWindowHandle: () => native }), ownerPid: process.pid, timeoutMs: 25000 });
  const windows = await manager.windows();
  assert.ok(windows.some(win => win.id === applicationId), 'The real application must be enumerable.');
  const state = await manager.attach(applicationId, { x: 20, y: 40, width: 470, height: 330 });
  assert.equal(state.attached, true);
  assert.equal(state.isolated, false);
  assert.equal((await manager.status()).windowId, applicationId);
  await manager.position({ x: 45, y: 70, width: 420, height: 300 });
  await writeFile(signal, 'open');
  const dialogs = await waitFor(async () => {
    const found = await manager.dialogs();
    return found.length ? found : null;
  }, 'Native application owned dialog', 8000);
  console.log('Observed native dialogs:', JSON.stringify(dialogs));
  console.log('All visible native windows:', JSON.stringify((await manager.windows()).filter(item => /BLACKICE/i.test(item.title))));
  console.log('Raw native owned windows:', JSON.stringify(await manager.dispatch('dialogs')));
  assert.ok(dialogs.some(item => /BLACKICE application dialog/.test(item.title)), 'The native application dialog must stay associated with the embedded app.');
  await manager.visibleState(false);
  assert.equal((await manager.status()).visible, false);
  await manager.visibleState(true);
  assert.equal((await manager.status()).visible, true);
  await manager.detach();
  assert.equal((await manager.status()).attached, false);
  for (const process of fixtures) assert.equal(process.exitCode, null, 'Detaching never terminates the existing application.');
  console.log('PASS: actual Win32 attach, resize, owned dialog, hide, show, detach; both native application processes survived detach.');
} finally {
  await manager?.close().catch(() => {});
  for (const child of fixtures) { try { child.kill(); } catch {} }
  await delay(200);
  await rm(root, { recursive: true, force: true });
}
