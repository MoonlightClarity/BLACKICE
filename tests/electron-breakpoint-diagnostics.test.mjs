import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { electronExitReceipt } from '../desktop/electron-exit-diagnostics.mjs';

test('Electron native breakpoint and OOM failures record only process metadata', () => {
  const crash = electronExitReceipt('renderer', {
    reason:'crashed', exitCode:-2147483645,
    url:'https://private.example/account', input:'PRIVATE MESSAGE',
    name:'User document', extra:'tokens',
  }, 52);
  assert.deepEqual(crash,{
    component:'electron-process',event:'process_gone',level:'error',
    processType:'renderer',reason:'crashed',exitCode:-2147483645,webContentsId:52,
  });
  assert.doesNotMatch(JSON.stringify(crash),/private|tokens|account/i);
  assert.equal(electronExitReceipt('GPU',{reason:'oom',exitCode:9}).reason,'oom');
});
test('unexpected untrusted process names or native failure messages are never stored', () => {
  const result=electronExitReceipt('A browser URL https://secret.example',{reason:'https://secret.example',message:'Sensitive page text',exitCode:'oops'},-1);
  assert.equal(result.processType,'Unknown');
  assert.equal(result.reason,'unknown');
  assert.equal(result.exitCode,undefined);
  assert.equal(result.webContentsId,undefined);
  assert.doesNotMatch(JSON.stringify(result),/secret|Sensitive/);
});
test('desktop crash telemetry does not mutate Electron windows during native callbacks',async()=>{
  const main=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8');
  const browser=await readFile(new URL('../desktop/browser-driver.mjs',import.meta.url),'utf8');
  assert.match(main,/app\.on\('child-process-gone'/);
  assert.match(main,/app\.on\('render-process-gone'/);
  assert.match(main,/setImmediate\(\(\) => \{\s*try \{ void Promise\.resolve\(diagnostics\.record/);
  assert.match(browser,/setTimeout\(\(\) => \{\s*try \{ if \(!window\.isDestroyed\(\)\) window\.destroy\(\); \} catch \{\}\s*\}, 0\);/);
});
