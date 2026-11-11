import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HarnessEngine } from '../lib/engine.mjs';
import { approvedWindowsPackageFile } from '../scripts/windows-release-inputs.mjs';

const read = relative => readFileSync(fileURLToPath(new URL('../' + relative, import.meta.url)), 'utf8');

test('the Windows VM launcher and renderer IPC are removed from BLACKICE', () => {
  const index = read('public/next/index.html');
  const app = read('public/next/app.mjs');
  const preload = read('desktop/preload.cjs');
  const main = read('desktop/main.mjs');
  const server = read('server.mjs');
  assert.doesNotMatch(index, /data-space="workbench"|workbench\.css/);
  assert.doesNotMatch(app, /createWorkbenchWorkspace|workspaces\/workbench\.mjs/);
  assert.doesNotMatch(preload, /relay:vm-surface|relay:workbench-features/);
  assert.doesNotMatch(main, /WorkbenchNativeSurface|relay:vm-surface|bindWorkbench/);
  assert.doesNotMatch(server, /\/api\/workbench|new WindowsWorkbench|workbenchVideo/);
});

test('explicit retired VM control requests are rejected before task execution', () => {
  assert.throws(
    () => HarnessEngine.prototype.startRun.call({}, { workbench: true }),
    { code: 'WORKBENCH_RETIRED', status: 410 }
  );
});

test('retired virtual machine resources are not approved as Windows installer inputs', () => {
  for (const file of [
    'lib/windows-workbench.mjs',
    'lib/workbench-agent-tools.mjs',
    'desktop/workbench-native-runtime.mjs',
    'desktop/workbench-freerdp-host.mjs',
    'scripts/workbench-headless-broker.ps1',
    'scripts/package-workbench-freerdp.mjs',
    'resources/workbench-native/package.json',
    'resources/guest/workbench-guest-video.exe',
    'public/next/workbench.css',
    'public/next/workspaces/workbench.mjs',
  ]) assert.equal(approvedWindowsPackageFile(file, '2.39.60'), false, file);
});

test('retiring Workbench does not remove the existing browser and planning tabs', () => {
  const index = read('public/next/index.html');
  for (const space of ['chat','planning','tasks','browser','knowledge','settings'])
    assert.match(index, new RegExp('data-space="' + space + '"'));
});

test('Windows installer validation and release workflow do not require VM companions', () => {
  for (const file of [
    'scripts/package-public.mjs',
    'scripts/verify-windows-release.ps1',
    '.github/workflows/publish-windows-release.yml',
    'desktop/electron-builder.yml',
  ]) {
    const content=read(file);
    assert.doesNotMatch(content, /package-workbench|workbench-native|workbench-guest|release-native-source-assets|Native-Sources\.tar/i,file);
  }
});
