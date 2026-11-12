import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';

test('a reviewer cannot certify completeness by modifying an existing passing smoke test',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'sd-review-integrity-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const repo=path.join(cwd,'repo');
 await mkdir(path.join(repo,'src'),{recursive:true});
 await mkdir(path.join(repo,'tests'),{recursive:true});
 await writeFile(path.join(repo,'package.json'),JSON.stringify({type:'module'}));
 await writeFile(path.join(repo,'src','logic.mjs'),'export function score(n){return n;}\n');
 const oldTest="import test from 'node:test';import assert from 'node:assert/strict';import {score} from '../src/logic.mjs';test('positive smoke',()=>assert.equal(score(42),42));";
 await writeFile(path.join(repo,'tests','smoke.test.mjs'),oldTest);
 const task='Implement and validate repository score(n). Valid inputs must be nonnegative integers, including zero; return them without loss. All negative inputs, fractions, strings, NaN, Infinity and null must throw TypeError. Preserve existing public exports, side-effect-free behavior, immutability of inputs, and deterministic output. A passing simple smoke check must never be treated as exhaustive evidence. Do not edit tests or coverage mappings; correct missing implementation instead.';
 const phases=[];
 const runtime={async runAgent(opts){
   const v=JSON.parse(opts.prompt.split('CURRENT_DIRECTORY:\n')[1].split(/\nREPOSITORY (?:MODE|SYNTHESIS):/)[0]);
   phases.push(v.label);
   if(v.label==='decompose')return {output:'{"atomic":true}'};
   if(v.label==='work')return {output:'{"finding":"No source change"}'};
   if(v.label==='repository-review'){
     const changed=await opts.onToolCall({name:'relay_workspace',arguments:{
       action:'patch',path:'tests/smoke.test.mjs',
       oldText:"test('positive smoke',()=>assert.equal(score(42),42));",
       newText:"test('positive smoke',()=>{assert.equal(score(42),42);assert.equal(score(-1),-1)});"
     }});
     assert.equal(changed.success,true,JSON.stringify(changed));
     return {output:'{"finding":"Changed the test instead of fixing the source"}'};
   }
   throw Error('Unexpected model phase '+v.label);
 }};
 const engine=new ShadowdancerDirectory({cwd,conversationId:'compromised',runId:'compromised',
   runtime,model:'remote::test'});
 const result=await engine.run('/directory '+task+'\nREPOSITORY_ROOT: '+repo);
 assert.deepEqual(phases,['decompose','work','repository-review']);
 assert.equal(result.stats.contractReview.sourceChanged,true); // The inventory now includes test assets as well as implementation files.
 assert.equal(result.stats.contractReview.testsChanged,true);
 assert.equal(result.stats.reviewReverified,true);
 assert.equal(result.stats.verificationStatus,'passed');
 assert.equal(result.stats.testIntegrity,'preexisting_tests_modified');
 const root=path.join(cwd,'.shadowdancer','compromised','runs','compromised');
 const final=JSON.parse(await readFile(result.finalPath,'utf8'));
 assert.equal(final.status,'preexisting_tests_modified');
 assert.match(final.answer,/pre-existing tests changed or were removed/i);
 const oldReceipt=JSON.parse(await readFile(path.join(root,'verification','round-001.json'),'utf8'));
 const nextReceipt=JSON.parse(await readFile(path.join(root,'verification','round-002.json'),'utf8'));
 assert.notEqual(oldReceipt.testSuiteSha256,nextReceipt.testSuiteSha256);
 const integrity=JSON.parse(await readFile(path.join(root,'verification','test-integrity.json'),'utf8'));
 assert.equal(integrity.compromised,true);
 assert.deepEqual(integrity.mutatedExisting,['tests/smoke.test.mjs']);
});
