import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { classifySourceSkips } from '../scripts/release-request.mjs';
import { parseSourceSuiteSkips } from '../scripts/source-suite-skip-parser.mjs';

test('canonical TAP classification preserves explicit unexecuted frozen benchmark evidence', async () => {
  const name='Historical MiniCPM native-control benchmark requires original pinned 2026-11-20 snapshot';
  const reason='Historical frozen source absent; no benchmark assertions executed or credited.';
  const tap=['TAP version 13', `ok 1 - ${name} # SKIP ${reason}`, 'ok 2 - unrelated passing test',
    'not ok 3 - a failing assertion', 'ok 4 - ordinary passing assertion'].join('\r\n')+'\r\n';
  const skips=parseSourceSuiteSkips(tap);
  assert.deepEqual(skips,[{name,reason,assertionsRan:false}]);
  assert.deepEqual(classifySourceSkips(skips),{capability:[],unexpectedSkips:[]});
  assert.deepEqual(classifySourceSkips([{name,reason}]).unexpectedSkips,[{name,reason}],
    'Unverified skip objects must not receive credit outside canonical TAP parsing');
  assert.throws(()=>parseSourceSuiteSkips(null),TypeError);
  const canonical=await fs.readFile(new URL('../scripts/source-suite-receipt.mjs',import.meta.url),'utf8');
  assert.match(canonical,/const skips=parseSourceSuiteSkips\(log\)/);
});

test('source suite uses current canonical opt-in classification rather than a historical receipt', async () => {
  const skips=[
    'native live informational alert releases without focus or effect replay',
    'native offscreen informational alert releases without focus or effect replay',
    'real packaged desktop main reaches ready with UIA retired and no launcher window',
  ].map(name=>({name,reason:'explicit opt-in fixture'}));
  assert.deepEqual(classifySourceSkips(skips),{capability:[],unexpectedSkips:[]});
  const source=await fs.readFile(new URL('../scripts/source-suite-receipt.mjs',import.meta.url),'utf8');
  assert.match(source,/classifySourceSkips\(skips\)/);
  assert.doesNotMatch(source,/windows-2\.39\.94\.json|prior\.optionalSkips/);
  assert.match(source,/skipDetails:skips\.map\(s=>\(\{\.\.\.s,assertionsRan:false\}\)\)/);
});

test('frozen MiniCPM benchmark skip requires exact absent-source disclosure and no assertions', () => {
  const names = [
    'Historical MiniCPM native-control benchmark requires original pinned 2026-11-20 snapshot',
    'Historical MiniCPM execution-delivery benchmark requires original pinned 2026-11-20 snapshot',
    'Historical MiniCPM execution-evidence benchmark requires original pinned 2026-11-20 snapshot',
  ];
  const reason = 'Historical frozen source absent; no benchmark assertions executed or credited.';
  const skips = names.map(name => ({name,reason,assertionsRan:false}));
  assert.deepEqual(classifySourceSkips(skips), {capability:[],unexpectedSkips:[]});
  for (const item of [
    {...skips[0],reason:'Benchmarks passed'},
    {...skips[0],assertionsRan:true},
    {...skips[0],name:skips[0].name+' (changed)'},
    {...skips[0],reason:undefined},
  ]) assert.deepEqual(classifySourceSkips([item]).unexpectedSkips,[item]);
  assert.deepEqual(classifySourceSkips([skips[0],skips[0]]).unexpectedSkips,[skips[0],skips[0]]);
});

test('source skip classifier preserves exact Windows file-symlink capability evidence', () => {
  for(const [name,file] of [
    ['symlinked source is rejected where file symlink creation is available','tests/application-history.test.mjs'],
    ['unsafe filesystem links cannot be queued or cleared','tests/storage-management.test.mjs'],
  ])for(const errorCode of ['EPERM','EACCES']){
    const item={name,reason:'File symlink fixture creation failed: '+errorCode};
    assert.deepEqual(classifySourceSkips([item]),{capability:[{
      ...item,file,platform:'win32',operation:'create file symlink fixture',errorCode,assertionsRan:false,
    }],unexpectedSkips:[]});
  }
});

test('unknown, duplicate, missing and malformed capability skips remain required skips', () => {
  const name='symlinked source is rejected where file symlink creation is available';
  for(const reason of [null,undefined,'File symlink fixture creation failed: EIO','other EPERM','File symlink fixture creation failed: EPERM extra']){
    const item={name,reason};assert.deepEqual(classifySourceSkips([item]).unexpectedSkips,[item]);
  }
  for(const item of [{name:'unexpected required assertion',reason:'disabled'}, {name:'native live informational alert releases without focus or effect replay (changed)',reason:null},null,{}])
    assert.deepEqual(classifySourceSkips([item]).unexpectedSkips,[item]);
  const item={name:'native live informational alert releases without focus or effect replay',reason:null};
  assert.deepEqual(classifySourceSkips([item,item]).unexpectedSkips,[item,item]);
  const capability={name,reason:'File symlink fixture creation failed: EPERM'};
  assert.deepEqual(classifySourceSkips([capability,capability]).unexpectedSkips,[capability,capability]);
  assert.deepEqual(classifySourceSkips([]),{capability:[],unexpectedSkips:[]});
});
