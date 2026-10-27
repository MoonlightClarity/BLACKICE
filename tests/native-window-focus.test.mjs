import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const implementation = await readFile(new URL('../desktop/native-window-host.cs', import.meta.url), 'utf8');
const smoke = await readFile(new URL('./native-app-smoke.mjs', import.meta.url), 'utf8');
const fixture = await readFile(new URL('./fixture-native-window.ps1', import.meta.url), 'utf8');

test('retired native focus helper is not an exposed application foreground route', async () => {
  const main = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(implementation, /SetForegroundWindow\(blackiceWindow\)/);
  assert.match(main, /nativeWindows:null/);
  assert.doesNotMatch(preload, /relay:native-apps/);
});
test('real GUI tests cannot unexpectedly open new Windows windows in routine test runs', () => {
  assert.match(smoke, /BLACKICE_INTERACTIVE_GUI_TEST/);
  assert.match(smoke, /process\.exit\(0\)/);
  assert.match(fixture, /ShowWithoutActivation/);
  assert.doesNotMatch(fixture, /MessageBox\]::Show/);
});
