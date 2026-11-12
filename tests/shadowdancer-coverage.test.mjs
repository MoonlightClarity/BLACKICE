import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {extractRequirements,verifyRepository,testSuiteSnapshot,classifyRequirements} from '../lib/shadowdancer-verification.mjs';
import {readCoverageEvidence,applyCoverageEvidence} from '../lib/shadowdancer-coverage.mjs';

async function fixture(t) {
 const cwd=await mkdtemp(path.join(os.tmpdir(),'shadowdancer-coverage-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 await mkdir(path.join(cwd,'src'),{recursive:true});
 await mkdir(path.join(cwd,'tests'),{recursive:true});
 await writeFile(path.join(cwd,'package.json'),JSON.stringify({type:'module'}));
 await writeFile(path.join(cwd,'src','logic.mjs'),
   'export function score(x){if(x<0)throw RangeError("negative");return x;}\n');
 await writeFile(path.join(cwd,'tests','logic.test.mjs'),
   'import test from "node:test";import assert from "node:assert/strict";import {score} from "../src/logic.mjs";\n'+
   'test("rejects negative values",()=>assert.throws(()=>score(-1),RangeError));\n'+
   'test("returns requested value",()=>assert.equal(score(2),2));\n');
 const requirements=extractRequirements('Reject negative values. Return requested value.');
 const verify=async()=>verifyRepository({repoRoot:cwd,task:'Check source',executable:process.execPath,
   receiptFile:path.join(cwd,'test-receipt.json')});
 const map=async mappings=>writeFile(path.join(cwd,'tests','requirement-coverage.json'),
   JSON.stringify({version:1,mappings},null,2));
 return {cwd,requirements,verify,map};
}
test('lexical similarity alone can NEVER certify passing requirement',async t=>{
 const f=await fixture(t);
 const receipt=await f.verify();
 assert.equal(receipt.status,'passed');
 assert.equal(receipt.passed,2);
 assert.equal(receipt.testSourceFiles.length,1);
 const legacy=classifyRequirements(f.requirements,{testReceipt:receipt});
 assert.equal(legacy.verifiedCount,0);
 assert.ok(legacy.requirements.every(x=>x.state==='unknown'));
 const absent=await readCoverageEvidence(f.cwd,f.requirements,receipt);
 assert.equal(absent.status,'absent');
 const applied=applyCoverageEvidence(f.requirements,receipt,absent);
 assert.equal(applied.verifiedCount,0);
 assert.equal(applied.unknownCount,2);
});
test('exact named cases from executed unchanged tests are auditable evidence',async t=>{
 const f=await fixture(t);
 await f.map([
  {requirementId:'R001',testFile:'tests/logic.test.mjs',case:'rejects negative values',rationale:'Checks input rejection'},
  {requirementId:'R002',testFile:'tests/logic.test.mjs',case:'returns requested value',rationale:'Checks value'}
 ]);
 const receipt=await f.verify();
 assert.equal(receipt.status,'passed');
 const map=await readCoverageEvidence(f.cwd,f.requirements,receipt);
 assert.equal(map.status,'validated',JSON.stringify(map));
 assert.equal(map.accepted.length,2);
 assert.equal(map.rejected.length,0);
 const updated=applyCoverageEvidence(f.requirements,receipt,map);
 assert.equal(updated.verifiedCount,2);
 assert.equal(updated.unknownCount,0);
 assert.equal(updated.status,'test-evidence-coverage-declared');
 assert.ok(updated.requirements.every(x=>x.evidence[0].testFileSha256?.length===64));
});
test('fabricated titles, nonexistent and unexecuted files, unknown ids get rejected',async t=>{
 const f=await fixture(t);
 await f.map([
  {requirementId:'R001',testFile:'tests/logic.test.mjs',case:'some other passing test'},
  {requirementId:'R002',testFile:'tests/not-run.test.mjs',case:'returns requested value'},
  {requirementId:'R999',testFile:'tests/logic.test.mjs',case:'returns requested value'},
  {requirementId:'R001',testFile:'tests/../secret.test.mjs',case:'rejects negative values'},
 ]);
 const receipt=await f.verify();
 const evidence=await readCoverageEvidence(f.cwd,f.requirements,receipt);
 assert.equal(evidence.status,'partially_invalid');
 assert.equal(evidence.accepted.length,0);
 assert.equal(evidence.rejected.length,4);
 const ledger=applyCoverageEvidence(f.requirements,receipt,evidence);
 assert.equal(ledger.verifiedCount,0);
 assert.equal(ledger.unknownCount,2);
 assert.equal(ledger.coverageRejectedCount,4);
});
test('test and coverage mapping edits invalidate evidence from earlier test run',async t=>{
 const f=await fixture(t);
 await f.map([{requirementId:'R001',testFile:'tests/logic.test.mjs',case:'rejects negative values'}]);
 const receipt=await f.verify();
 const before=await testSuiteSnapshot(f.cwd);
 assert.equal(before.testSuiteSha256,receipt.testSuiteSha256);
 await writeFile(path.join(f.cwd,'tests','logic.test.mjs'),
   (await readFile(path.join(f.cwd,'tests','logic.test.mjs'),'utf8'))+'\n// changed after test run\n');
 const evidence=await readCoverageEvidence(f.cwd,f.requirements,receipt);
 assert.equal(evidence.accepted.length,0);
 assert.equal(evidence.rejected[0].reason,'test_file_changed_after_execution');
 assert.notEqual((await testSuiteSnapshot(f.cwd)).testSuiteSha256,receipt.testSuiteSha256);
});
test('workflow/environment instructions are preserved but not counted as code requirements',()=>{
 const task='Provide source implementation. Reject unknown IDs. Run the repository tests and repair failures. There is no Node executable path supplied in this request. Use BLACKICE built-in verification. Work within this repository only.';
 const ledger=extractRequirements(task);
 assert.equal(ledger.fullTask,task);
 assert.equal(ledger.requirements.length,2);
 assert.equal(ledger.proceduralConstraints.length,4);
});
