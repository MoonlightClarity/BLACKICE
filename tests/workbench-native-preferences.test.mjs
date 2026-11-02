import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkbenchControlPreferences} from '../desktop/workbench-native-controls.mjs';
async function fixture(t){
  const root=await fs.mkdtemp(path.join(tmpdir(),'blackice-native-prefs-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)).toLowerCase(),path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('blackice-native-prefs-'));await fs.rm(root,{recursive:true,force:true})});
  const file=path.join(root,'workbench-native-controls.json');return {root,file,store:createWorkbenchControlPreferences(file)};
}
test('fresh defaults are on while an explicit Off survives a new process/store instance',async t=>{
  const f=await fixture(t);assert.deepEqual(await f.store.load(),{clipboardEnabled:true,resolutionEnabled:true});
  assert.deepEqual(await fs.readdir(f.root),[]);
  await f.store.save({clipboardEnabled:false,resolutionEnabled:false});
  assert.deepEqual(await createWorkbenchControlPreferences(f.file).load(),{clipboardEnabled:false,resolutionEnabled:false});
  assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),{version:1,clipboardEnabled:false,resolutionEnabled:false});
});
test('malformed, oversized or token-bearing preference files are rejected without rewriting original bytes',async t=>{
  const f=await fixture(t);
  for(const bytes of [Buffer.from('{broken'),Buffer.from('x'.repeat(2049)),Buffer.from([0xc3,0x28]),
    Buffer.from(JSON.stringify({version:2,clipboardEnabled:true,resolutionEnabled:true})),
    Buffer.from(JSON.stringify({version:1,clipboardEnabled:true,resolutionEnabled:true,controlToken:'must-not-load'}))]){
    await fs.writeFile(f.file,bytes);await assert.rejects(f.store.load(),{code:'WORKBENCH_NATIVE_PREFERENCES'});
    assert.deepEqual(await fs.readFile(f.file),bytes);
  }
});
test('save accepts only two booleans, never persists a control token or clipboard payload, and serializes atomic writes',async t=>{
  const f=await fixture(t);await f.store.save({clipboardEnabled:false,resolutionEnabled:true});
  const before=await fs.readFile(f.file);
  for(const value of [{clipboardEnabled:true,resolutionEnabled:true,controlToken:'never-save-token'},
    {clipboardEnabled:true,resolutionEnabled:true,text:'never-save-clipboard'},
    {clipboardEnabled:'false',resolutionEnabled:true}]){
    assert.throws(()=>f.store.save(value),{code:'WORKBENCH_NATIVE_PREFERENCES'});assert.deepEqual(await fs.readFile(f.file),before);
  }
  await Promise.all([f.store.save({clipboardEnabled:true,resolutionEnabled:true}),f.store.save({clipboardEnabled:true,resolutionEnabled:false}),
    f.store.save({clipboardEnabled:false,resolutionEnabled:true})]);
  assert.deepEqual(await f.store.load(),{clipboardEnabled:false,resolutionEnabled:true});
  assert.deepEqual(await fs.readdir(f.root),['workbench-native-controls.json']);
  assert.doesNotMatch(await fs.readFile(f.file,'utf8'),/token|clipboard payload|never-save/i);
});
