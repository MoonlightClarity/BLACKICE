import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../desktop/browser-driver.mjs', import.meta.url), 'utf8');
const elementSource = source.slice(source.indexOf('function elementAction('), source.indexOf('\nasync function elementActionResult('));

test('ordinary field fill prepares focused replacement without a native value setter or synthetic input', () => {
  const calls = [], field = { isConnected: true, tagName: 'INPUT', type: 'text', getAttribute: () => null, getRootNode: () => ({}), focus() { calls.push('focus'); context.document.activeElement = this; }, select() { calls.push('select'); }, dispatchEvent() { calls.push('synthetic event'); } };
  const context = vm.createContext({ fixture: { elements: new Map([['field', field]]) }, document: { activeElement: null }, HTMLInputElement: class {}, HTMLTextAreaElement: class {}, InputEvent: class {}, Event: class {} });
  const result = vm.runInContext(`(${elementSource})('fixture','field','fill',{text:'replacement'})`, context);
  assert.equal(result.needsTrustedTextInput, true); assert.ok(calls.includes('focus')); assert.equal(calls.includes('synthetic event'), false);
});

test('readonly and disabled fields fail before focus or replacement preparation', () => {
  for (const flags of [{ readOnly: true }, { disabled: true }]) {
    let focused = false; const field = { isConnected: true, tagName: 'INPUT', type: 'text', getAttribute: () => null, focus() { focused = true; }, ...flags };
    const context = vm.createContext({ fixture: { elements: new Map([['field', field]]) } });
    assert.throws(() => vm.runInContext(`(${elementSource})('fixture','field','fill',{text:'must not write'})`, context), /read only|disabled/); assert.equal(focused, false);
  }
});

test('non-text native controls fail before focus rather than claim a text fill', () => {
  for (const type of ['file', 'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'date', 'color', 'range', 'hidden']) {
    let focused = false; const field = { isConnected: true, tagName: 'INPUT', type, getAttribute: () => null, focus() { focused = true; } };
    const context = vm.createContext({ fixture: { elements: new Map([['field', field]]) } });
    assert.throws(() => vm.runInContext(`(${elementSource})('fixture','field','fill',{text:'must not write'})`, context), /editable text field/); assert.equal(focused, false);
  }
});

test('actual hidden Chromium fill commits trusted form state across replacement empty Unicode and iframe cases', { skip: process.env.RELAY_TRUSTED_FILL_QA !== '1' && 'Set RELAY_TRUSTED_FILL_QA=1 for the isolated native fixture.', timeout: 100000 }, async t => {
  const directory = process.env.BLACKICE_FILL_QA_OUTPUT ? path.resolve(process.env.BLACKICE_FILL_QA_OUTPUT) : await fs.mkdtemp(path.join(tmpdir(), 'blackice-trusted-fill-'));
  await fs.mkdir(directory, { recursive: true });
  if (!process.env.BLACKICE_FILL_QA_OUTPUT) t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const require = createRequire(import.meta.url), fixture = fileURLToPath(new URL('./fixtures/browser-trusted-fill-native.cjs', import.meta.url));
  const child = spawn(require('electron'), [fixture, `--fixture-data=${directory}`], { env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-6000); });
  const timer = setTimeout(() => child.kill(), 95000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  const report = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
  assert.equal(code, 0, report.error || output); assert.equal(report.ok, true, report.error); assert.equal(report.closedWindows, true); assert.ok(report.checks.length >= 10);
});
