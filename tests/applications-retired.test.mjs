import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const text = relative => readFileSync(fileURLToPath(new URL('../' + relative, import.meta.url)), 'utf8');

test('Applications tab and lazy workspace route are absent', () => {
  assert.doesNotMatch(text('public/next/index.html'), /data-space="applications"/);
  assert.doesNotMatch(text('public/next/app.mjs'), /createApplicationsWorkspace|workspaces\/applications\.mjs|onNativeAppsReveal/);
});

test('no renderer or Electron IPC entry point can launch a native application', () => {
  assert.doesNotMatch(text('desktop/preload.cjs'), /relay:native-apps|nativeApps\s*:/);
  assert.doesNotMatch(text('desktop/main.mjs'), /import \{ NativeAppHost \}|new NativeAppWorkspace|ipcMain\.handle\('relay:native-apps'/);
});

test('unrelated workspace tabs stay registered', () => {
  const html = text('public/next/index.html');
  for (const space of ['chat','planning','tasks','browser','activity','knowledge','settings'])
    assert.match(html, new RegExp('data-space="' + space + '"'));
});
