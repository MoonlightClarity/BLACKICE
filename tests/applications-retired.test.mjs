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
  // Removed spaces must not return as replacement tabs or lazy routes.
  for (const space of ['chat','cronjobs','browser','skills','settings'])
    assert.match(html, new RegExp('data-space="' + space + '"'));
  assert.doesNotMatch(html, /data-space="planning"|data-space="workbench"|data-space="swarm"|data-space="knowledge"|data-space="todos"|data-space="userWorkflows"/);
});

 test('removed TODO and user workflow workspaces have no lazy entry points', () => {
  assert.doesNotMatch(text('public/next/app.mjs'), /createTodosWorkspace|createUserWorkflowsWorkspace|workspaces\/(?:todos|user-workflows)\.mjs/);
});
