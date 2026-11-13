import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {sourceSnapshot,discoverTests,testSuiteSnapshot,verifyRepository} from '../lib/shadowdancer-verification.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'directory-audit-boundary-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const put=async(relative,value='example')=>{const file=path.join(root,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,value);return file;};
 return {root,put};
}
test('source inventory covers lib, public, root configuration and arbitrary source assets',async t=>{
 const f=await fixture(t);
 const paths=['src/index.mjs','lib/engine.mjs','public/app.css','public/image.png','main.py','package.json','README.md','tests/app.test.mjs'];
 for(const name of paths)await f.put(name,name==='public/image.png'?Buffer.from([0,255,1,2]):name);
 const first=await sourceSnapshot(f.root);
 assert.deepEqual(first.files.map(x=>x.path),paths.sort((a,b)=>a.localeCompare(b)));
 assert.equal(first.coverage.completeWithinScope,true);
 assert.equal(first.coverage.fileCount,paths.length);
 for(const name of ['lib/engine.mjs','public/app.css','main.py','package.json']){
  const before=await sourceSnapshot(f.root);await f.put(name,'changed '+name);
  assert.notEqual((await sourceSnapshot(f.root)).sha256,before.sha256,name+' must affect freshness');
 }
});
test('known generated and private reasoning directories are excluded with explicit coverage',async t=>{
 const f=await fixture(t);await f.put('lib/app.mjs','source');
 const first=await sourceSnapshot(f.root);
 for(const name of ['.git','node_modules','.shadowdancer','.build','dist','coverage','.cache'])
  await f.put(name+'/generated.txt','ignored');
 const second=await sourceSnapshot(f.root);
 assert.equal(second.sha256,first.sha256);
 assert.equal(second.coverage.excludedPaths.length,7);
 assert.ok(second.coverage.excludedDirectoryNames.includes('.shadowdancer'));
 assert.deepEqual(second.files.map(x=>x.path),['lib/app.mjs']);
});
test('declared dependency junctions are excluded before traversal, while included links stay fail-closed',async t=>{
 const f=await fixture(t),outside=await fixture(t);
 await f.put('lib/app.mjs','source');await outside.put('private.test.mjs','dependency bytes');
 try{await symlink(outside.root,path.join(f.root,'node_modules'),process.platform==='win32'?'junction':'dir');}
 catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip('Host does not support disposable symbolic link fixture');return;}throw error;}
 const snapshot=await sourceSnapshot(f.root);
 assert.deepEqual(snapshot.files.map(x=>x.path),['lib/app.mjs']);
 assert.ok(snapshot.coverage.excludedPaths.includes('node_modules'));
 await mkdir(path.join(f.root,'tests'));
 await f.put('tests/owned.test.mjs','// test');
 await symlink(outside.root,path.join(f.root,'tests','node_modules'),process.platform==='win32'?'junction':'dir');
 assert.equal((await discoverTests(f.root)).length,1);
});
test('source inventory limits fail rather than returning an incomplete fingerprint',async t=>{
 const f=await fixture(t);await f.put('a.txt','123');await f.put('b.txt','456');
 await assert.rejects(sourceSnapshot(f.root,{maxFiles:1}),{code:'DIRECTORY_SNAPSHOT_LIMIT'});
 await assert.rejects(sourceSnapshot(f.root,{maxFileBytes:2}),{code:'DIRECTORY_SNAPSHOT_LIMIT'});
 await assert.rejects(sourceSnapshot(f.root,{maxBytes:5}),{code:'DIRECTORY_SNAPSHOT_LIMIT'});
 await f.put('deep/one/two/file.txt','deep');
 await assert.rejects(sourceSnapshot(f.root,{maxDepth:1}),{code:'DIRECTORY_SNAPSHOT_LIMIT'});
 await assert.rejects(sourceSnapshot(f.root,{maxEntries:1}),{code:'DIRECTORY_SNAPSHOT_LIMIT'});
});
test('test discovery includes more than the former 100-file cutoff and rejects actual overflow',async t=>{
 const f=await fixture(t);
 for(let i=0;i<101;i++)await f.put('tests/test-'+String(i).padStart(3,'0')+'.test.mjs','// test');
 const found=await discoverTests(f.root);
 assert.equal(found.length,101);
 const suite=await testSuiteSnapshot(f.root);assert.equal(suite.testSourceFiles.length,101);
 await assert.rejects(discoverTests(f.root,100),{code:'DIRECTORY_VERIFICATION_TEST_LIMIT'});
 await f.put('tests/a/b/c/d/e/f/deep.test.mjs','// deep');
 assert.equal((await discoverTests(f.root)).length,102);
 await assert.rejects(discoverTests(f.root,1000,{maxDepth:2}),{code:'DIRECTORY_VERIFICATION_TEST_LIMIT'});
});
test('explicit test lists reject duplicates, outside paths, and unsupported files',async t=>{
 const f=await fixture(t),inside=await f.put('tests/app.test.mjs','// test'),outside=await f.put('outside.test.mjs','// outside');
 const unsupported=await f.put('tests/readme.txt','not a test');
 await assert.rejects(testSuiteSnapshot(f.root,{testPaths:[inside,inside]}),{code:'DIRECTORY_VERIFICATION_TEST_LIMIT'});
 await assert.rejects(testSuiteSnapshot(f.root,{testPaths:[outside]}),{code:'DIRECTORY_VERIFICATION_TEST_PATH'});
 await assert.rejects(testSuiteSnapshot(f.root,{testPaths:[unsupported]}),{code:'DIRECTORY_VERIFICATION_TEST_PATH'});
});
test('linked source and test directories are rejected rather than skipped or followed',async t=>{
 const f=await fixture(t),outside=await fixture(t);
 await outside.put('private.test.mjs','// private');
 try{await symlink(outside.root,path.join(f.root,'linked'),process.platform==='win32'?'junction':'dir');}
 catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip('Host does not support disposable symbolic link fixture');return;}throw error;}
 await assert.rejects(sourceSnapshot(f.root),error=>/symbolic|junction/i.test(error.message));
 await mkdir(path.join(f.root,'tests'));
 await symlink(outside.root,path.join(f.root,'tests','linked'),process.platform==='win32'?'junction':'dir');
 await assert.rejects(discoverTests(f.root),error=>/symbolic|junction/i.test(error.message));
});
test('verification detects lib changes and keeps guarded receipt identity without running a real command',async t=>{
 const f=await fixture(t);await f.put('lib/app.mjs','before');await f.put('tests/app.test.mjs','// test');
 const file=path.join(f.root,'.blackice','directory','proof','receipt.json');let called=0;
 const result=await verifyRepository({repoRoot:f.root,task:'inspect',receiptFile:file,executable:process.execPath,
  executeTestCommand:async args=>{called++;assert.equal(args.receiptFile,file);await f.put('lib/app.mjs','after');
   return {exitCode:0,stdout:'TAP version 13\nok 1 - mock\n1..1\n# tests 1\n# pass 1\n# fail 0\n',stderr:'',timedOut:false,truncated:false};}});
 assert.equal(called,1);assert.equal(result.status,'stale');assert.equal(result.sourceChanged,true);
 assert.ok(result.sourceFiles.some(x=>x.path==='lib/app.mjs'));
 assert.equal(result.sourceCoverage.completeWithinScope,true);
 assert.equal(JSON.parse(await readFile(file,'utf8')).status,'stale');
});
test('verification detects a new test appearing during execution instead of claiming the old list is complete',async t=>{
 const f=await fixture(t);await f.put('lib/app.mjs','before');await f.put('tests/app.test.mjs','// test');
 const result=await verifyRepository({repoRoot:f.root,task:'inspect',receiptFile:path.join(f.root,'.blackice','directory','proof','receipt.json'),executable:process.execPath,
  executeTestCommand:async()=>{await f.put('tests/new.test.mjs','// newly added');
   return {exitCode:0,stdout:'TAP version 13\nok 1 - mock\n1..1\n# tests 1\n# pass 1\n# fail 0\n',stderr:'',timedOut:false,truncated:false};}});
 assert.equal(result.status,'stale');assert.equal(result.sourceChanged,true);
});
