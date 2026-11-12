import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
 extractRequirements,classifyRequirements,verifyRepository,sourceSnapshot,
 nodeExecutableFromRequest,
} from '../lib/shadowdancer-verification.mjs';

async function fixture(t,source='export const score = x => x;'){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'sd-requirements-'));
 t.after(async()=>rm(cwd,{recursive:true,force:true}));
 await mkdir(path.join(cwd,'src'),{recursive:true});
 await mkdir(path.join(cwd,'tests'),{recursive:true});
 await writeFile(path.join(cwd,'package.json'),JSON.stringify({type:'module'}));
 await writeFile(path.join(cwd,'src','logic.mjs'),source);
 return cwd;
}
test('requirement ledger persists original text, unknown status, and unique IDs',()=>{
 const text='Add exact rollback semantics. Reject unknown account balances. Preserve previous results after a failed update.';
 const ledger=extractRequirements(text);
 assert.equal(ledger.originalSha256.length,64);
 assert.deepEqual(ledger.requirements.map(r=>r.id),['R001','R002','R003']);
 assert.ok(ledger.requirements.every(r=>r.state==='unknown'));
 assert.equal(ledger.fullTask,text);
});
test('node executable is parsed from user-provided, absolute task context',()=>{
 const v='Repair example\nVERIFIED NODE BINARY: '+process.execPath+'\nREPOSITORY_ROOT: C:\\temp';
 assert.equal(nodeExecutableFromRequest(v),process.execPath);
});
test('failing tests create a durable evidence receipt, not completion',async t=>{
 const cwd=await fixture(t);
 const file=path.join(cwd,'tests','logic.test.mjs');
 await writeFile(file,"import test from 'node:test';import assert from 'node:assert/strict';import {score} from '../src/logic.mjs';test('reject invalid account',()=>assert.throws(()=>score('bad')));test('keep original behavior',()=>assert.equal(score(1),1));");
 const original=await sourceSnapshot(cwd);
 const receipt=await verifyRepository({
   repoRoot:cwd,task:'test',executable:process.execPath,receiptFile:path.join(cwd,'evidence','round1.json'),
 });
 assert.equal(receipt.status,'failed');
 assert.equal(receipt.tests,2,JSON.stringify(receipt));
 assert.equal(receipt.passed,1);
 assert.equal(receipt.failed,1);
 assert.equal(receipt.sourceSha256,original.sha256);
 assert.equal(receipt.failedCases.length,1);
 const fromDisk=JSON.parse(await readFile(path.join(cwd,'evidence','round1.json'),'utf8'));
 assert.deepEqual(fromDisk.failedCases,receipt.failedCases);
 const ledger=extractRequirements('Reject invalid account. Preserve other functionality.');
 const marked=classifyRequirements(ledger,{testReceipt:receipt});
 assert.equal(marked.status,'tests-failed');
 assert.equal(marked.failedCount,0,'test-title similarity cannot certify which requirement failed');
 assert.ok(marked.requirements.every(r=>r.state==='unknown'));
 assert.equal(marked.status,'tests-failed');
});
test('repair changes source hash, then fresh test succeeds',async t=>{
 const cwd=await fixture(t);
 await writeFile(path.join(cwd,'tests','logic.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {score} from '../src/logic.mjs';test('returns updated value',()=>assert.equal(score(1),42));");
 const first=await verifyRepository({repoRoot:cwd,task:'test',executable:process.execPath,receiptFile:path.join(cwd,'evidence','round1.json')});
 assert.equal(first.status,'failed');
 await writeFile(path.join(cwd,'src','logic.mjs'),'export const score = x => 42;');
 const second=await verifyRepository({repoRoot:cwd,task:'test',executable:process.execPath,receiptFile:path.join(cwd,'evidence','round2.json')});
 assert.equal(second.status,'passed');
 assert.notEqual(second.sourceSha256,first.sourceSha256);
 assert.deepEqual(second.failedCases,[]);
 assert.equal(second.passed,1);
});
test('Node verification works without a user-supplied binary when the host is Node',async t=>{
 const cwd=await fixture(t);
 await writeFile(path.join(cwd,'tests','basic.test.mjs'),
   "import test from 'node:test';import assert from 'node:assert/strict';test('identity works',()=>assert.equal(1,1));");
 const evidence=await verifyRepository({repoRoot:cwd,task:'Verify the source',receiptFile:path.join(cwd,'evidence','automatic.json')});
 assert.equal(evidence.status,'passed',JSON.stringify(evidence));
 assert.equal(evidence.executable,process.execPath);
 assert.equal(evidence.passed,1);
});
test('no test suite is an explicit unknown rather than success',async t=>{
 const cwd=await fixture(t);
 const receipt=await verifyRepository({repoRoot:cwd,task:'',executable:process.execPath,receiptFile:path.join(cwd,'evidence','none.json')});
 assert.equal(receipt.status,'unavailable');assert.equal(receipt.tests,null);
 const ledger=classifyRequirements(extractRequirements('Validate source values.'),
   {testReceipt:receipt});
 assert.equal(ledger.status,'verification-unavailable');
 assert.equal(ledger.unknownCount,1);
});

test('requirement audit bounds fail closed instead of silently dropping or truncating obligations',()=>{
 assert.throws(()=>extractRequirements(Array.from({length:31},(_,i)=>'Requirement '+i+' must remain independently checked.').join('\n\n')),{code:'DIRECTORY_REQUIREMENT_LIMIT'});
 assert.throws(()=>extractRequirements('The exact behavioral requirement '+ 'x'.repeat(4100)),{code:'DIRECTORY_REQUIREMENT_LIMIT'});
});
