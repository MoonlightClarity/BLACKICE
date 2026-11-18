import test from 'node:test';
import assert from 'node:assert/strict';
import { fileSearchLocations } from '../lib/workspace-file-search-locations.mjs';
const directory = { isDirectory: () => true };
test('Windows discovery keeps priority seeds plus every logical drive, including outside default folders', async () => {
  let script;
  const result = await fileSearchLocations('C:\\work', undefined, {
    platform: 'win32', home: 'C:\\Users\\person', fs: { stat: async () => directory },
    run: async (_, args) => { script = args.at(-1); return { stdout: JSON.stringify({ common: ['C:\\Users\\person\\Documents', 'D:\\Desktop'], drives: ['C:\\', 'D:\\', 'Z:\\'] }) }; }
  });
  assert.deepEqual(result.roots, ['C:\\Users\\person\\Documents', 'D:\\Desktop', 'C:\\Users\\person', 'C:\\work', 'C:\\', 'D:\\', 'Z:\\']);
  assert.deepEqual(result.errors, []);
  assert.match(script, /GetLogicalDrives/);
  assert.match(script, /HKCU:\\Software\\Microsoft/);
});
test('drive discovery failure reports incomplete coverage rather than claiming computer-wide absence', async () => {
  const result = await fileSearchLocations('C:\\work', undefined, {
    platform: 'win32', home: 'C:\\Users\\person', run: async () => { throw new Error('unavailable'); }
  });
  assert.ok(result.roots.includes('C:\\'));
  assert.equal(result.errors[0].code, 'FILESYSTEM_ROOT_DISCOVERY_FAILED');
});
test('POSIX discovery includes root and configured priority directory without hidden exclusions', async () => {
  const result = await fileSearchLocations('/work', undefined, {
    platform: 'linux', home: '/home/person', configHome: '/config',
    fs: { readFile: async () => 'XDG_DOCUMENTS_DIR="$HOME/Papers"\n', stat: async () => directory }
  });
  assert.ok(result.roots.includes('/'));
  assert.ok(result.roots.includes('/home/person/Papers'));
  assert.ok(result.roots.indexOf('/home/person/Papers') < result.roots.indexOf('/'));
});
test('inaccessible priority folders and cancellation are not silently swallowed', async () => {
  const dependencies = { platform: 'win32', home: 'C:\\user', run: async () => ({ stdout: JSON.stringify({ common: ['C:\\restricted'], drives: ['C:\\'] }) }), fs: { stat: async () => { throw Object.assign(new Error(), {code:'EACCES'}); } } };
  const result = await fileSearchLocations('C:\\work', undefined, dependencies);
  assert.deepEqual(result.errors, [{path:'C:\\restricted',code:'EACCES'}]);
  assert.ok(result.roots.includes('C:\\'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fileSearchLocations('C:\\work', controller.signal, dependencies), {name:'AbortError'});
});

test('Windows priority lookup failure is reported even when drive coverage is available', async () => {
 const result = await fileSearchLocations('C:\\work', undefined, { platform:'win32',home:'C:\\user',run:async()=>({stdout:JSON.stringify({common:[],drives:['C:\\'],commonError:true})}) });
 assert.ok(result.roots.includes('C:\\')); assert.equal(result.errors[0].code,'COMMON_FOLDERS_UNAVAILABLE');
});
