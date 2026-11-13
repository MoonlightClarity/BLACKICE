import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
import {parseRepositoryReportSelection} from '../lib/repository-report-revision.mjs';

test('repository revision publishes exact selected evidence without replaying work or replacing host warnings',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'repo-revision-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const finalPath=path.join(dir,'final.json');
 const r=Object.create(ShadowdancerDirectory.prototype);
 Object.assign(r,{allRefs:[{kind:'verification',ref:'verification:final',path:'receipt.json'}],repoRoot:dir,request:'Fix function',stats:{},integrations:dir,turnRoot:dir,
 repoOriginalFiles:new Map([['src/a.mjs','old']]),requirements:{unknownCount:1},repoToolCalls:0,
 verification:{status:'failed',passed:1,failed:1,tests:2,file:'exact-test-receipt.json',sourceSha256:'source',testSuiteSha256:'suite'},
 testIntegrity:{compromised:true},summary:async()=>{},label:async()=>{},
 repositorySourceHashes:async()=>new Map([['src/a.mjs','new']])});
 let revisions=0,work=0;
 r.workLeaves=async()=>{work++;throw Error('No operational work during response revision');};
 r.integrateRepositoryEvidence=async refs=>{
   await writeFile(finalPath,JSON.stringify({integrationAuthority:'host_source_reference_index',status:'incomplete_or_unverified',referencedResults:refs}));
   return {answer:'host index',finalPath};
 };
 r.infer=async(label,module,payload)=>{
   revisions++;assert.equal(label,'integration');
   assert.equal(payload.responseInstructions,'Show exact test receipt and mapping uncertainty.');
   return {parsed:{answer:'["tests","mapping"]',used_refs:['verification:final'],inventedSuccess:'PRIVATE_GRADER_SAYS_COMPLETE'}};
 };
 const before=await r.finishRun(await r.integrate());
 const after=await r.reviseAnswer('Show exact test receipt and mapping uncertainty.');
 assert.equal(JSON.parse(await readFile(path.join(dir,'reports/revision-001/previous-final.json'),'utf8')).answer,before.answer,'previous report remains available');
 assert.equal(revisions,1);assert.equal(work,0);assert.notEqual(before.answer,after.answer);
 assert.match(after.answer,/exact-test-receipt.json/);
 assert.match(after.answer,/"failed":1/);
 assert.match(after.answer,/pre-existing tests changed or were removed/);
 assert.match(after.answer,/incomplete_or_unverified/);
 assert.match(after.answer,/"unmapped":1/);
 assert.doesNotMatch(after.answer,/PRIVATE_GRADER_SAYS_COMPLETE/);
 assert.equal(after.answer.split('\n\n')[0],before.answer.split('\n\n')[0]);
 const saved=JSON.parse(await readFile(finalPath,'utf8'));
 assert.equal(saved.reportRevision.authority,'host-facts-only');
 assert.equal(saved.status,'incomplete_or_unverified');
 const repeated=await r.finishRun(await r.integrate({responseInstructions:'Show exact test receipt and mapping uncertainty.'}));
 assert.equal(repeated.answer,after.answer,'Repeated unchanged selection must not fabricate progress');
});

test('fabricated prose, hidden-grade claims, unknown IDs and evidence substitutions are rejected',()=>{
 for(const p of [
  {answer:'All tests passed',used_refs:['v']},
  {answer:'["private-grader-success"]',used_refs:['v']},
  {answer:'["tests"]',used_refs:['fabricated']},
  {answer:'["tests"]',used_refs:['v','fabricated']},
  {answer:'["tests","tests"]',used_refs:['v']}
 ])assert.throws(()=>parseRepositoryReportSelection(p,['v']),{code:'DIRECTORY_REPORT_REVISION_INVALID'});
});
