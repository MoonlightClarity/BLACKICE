import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {discoverTests,testSuiteSnapshot,verifyRepository,extractRequirements} from '../lib/shadowdancer-verification.mjs';
import {readCoverageEvidence} from '../lib/shadowdancer-coverage.mjs';
test('conventional named test layouts are discovered, executed and hash-bound together',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'test-layout-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files=['test/smoke.test.mjs','tests/nested/check.spec.mjs','root.test.mjs'];
 for(const file of files){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),"import test from 'node:test';test("+JSON.stringify(file)+",()=>{});");}
 await mkdir(path.join(root,'src'));await writeFile(path.join(root,'src/not-a-test.mjs'),'throw Error("not executable evidence");');
 await mkdir(path.join(root,'test/node_modules'));await writeFile(path.join(root,'test/node_modules/ignored.test.mjs'),'throw Error("excluded");');
 const found=await discoverTests(root);assert.deepEqual(found.map(f=>path.relative(root,f).replaceAll('\\','/')).sort(),files.sort());
 const snap=await testSuiteSnapshot(root);assert.equal(snap.testSourceFiles.length,3);
 await assert.rejects(testSuiteSnapshot(root,{testPaths:[found[0],found[0]]}),{code:'DIRECTORY_VERIFICATION_TEST_LIMIT'});
 await assert.rejects(testSuiteSnapshot(root,{testPaths:[path.join(root,'src/not-a-test.mjs')]}),{code:'DIRECTORY_VERIFICATION_TEST_PATH'});
 await assert.rejects(discoverTests(root,2),{code:'DIRECTORY_VERIFICATION_TEST_LIMIT'});
 const receipt=await verifyRepository({repoRoot:root,task:'Verify',receiptFile:path.join(root,'.blackice/receipt.json')});
 assert.equal(receipt.status,'passed');assert.equal(receipt.tests,3);assert.equal(receipt.testSuiteSha256,snap.testSuiteSha256);
 const ledger=extractRequirements('Preserve behavior.');
 await writeFile(path.join(root,'tests/requirement-coverage.json'),JSON.stringify({version:1,mappings:[{requirementId:'R001',testFile:'test/smoke.test.mjs',case:'test/smoke.test.mjs'}]}));
 const evidence=await readCoverageEvidence(root,ledger,receipt);assert.equal(evidence.accepted.length,1);
 await writeFile(path.join(root,'test/smoke.test.mjs'),'// changed');
 assert.notEqual((await testSuiteSnapshot(root)).testSuiteSha256,snap.testSuiteSha256);
 const changed=await readCoverageEvidence(root,ledger,receipt);assert.equal(changed.accepted.length,0);assert.equal(changed.rejected[0].reason,'test_file_changed_after_execution');
});

