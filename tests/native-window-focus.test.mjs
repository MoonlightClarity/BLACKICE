import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const implementation = await readFile(new URL('../desktop/native-window-host.cs', import.meta.url), 'utf8');
const smoke = await readFile(new URL('./native-app-smoke.mjs', import.meta.url), 'utf8');
const fixture = await readFile(new URL('./fixture-native-window.ps1', import.meta.url), 'utf8');

test('automatic app window transitions never activate unrelated foreground applications', () => {
  assert.doesNotMatch(implementation, /ShowWindow\(\s*(?:appWindow|popup)\s*,\s*5\s*\)/, 'SW_SHOW activates and can change the foreground app.');
  assert.match(implementation, /ShowWindow\(appWindow,\s*show\s*\?\s*8\s*:\s*0\)/, 'SW_SHOWNA is non-activating.');
  assert.match(implementation, /SetWindowPos\(appWindow,[\s\S]*?0x0004\s*\|\s*0x0010\s*\|\s*0x0020/, 'Detach must use SWP_NOACTIVATE.');
  assert.match(implementation, /ShowWindow\(appWindow,\s*8\)/);
});

test('real GUI tests cannot unexpectedly open new Windows windows in routine test runs', () => {
  assert.match(smoke, /BLACKICE_INTERACTIVE_GUI_TEST/);
  assert.match(smoke, /process\.exit\(0\)/);
  assert.match(fixture, /ShowWithoutActivation/);
  assert.doesNotMatch(fixture, /MessageBox\]::Show/);
});
