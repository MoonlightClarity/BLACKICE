import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {ShadowdancerDirectory,shouldReviewRepository} from '../lib/shadowdancer-directory.mjs';

async function setup(t){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'sd-contract-review-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const repo=path.join(cwd,'repo');
 await mkdir(path.join(repo,'src'),{recursive:true});
 await mkdir(path.join(repo,'tests'),{recursive:true});
 await writeFile(path.join(repo,'package.json'),JSON.stringify({type:'module'}));
 await writeFile(path.join(repo,'src','count.mjs'),
  'export function count(n){return n;}\n');
 await writeFile(path.join(repo,'tests','smoke.test.mjs'),
  "import test from 'node:test';import assert from 'node:assert/strict';import {count} from '../src/count.mjs';test('valid integer count',()=>assert.equal(count(1),1));");
 return {cwd,repo};
}
const contract=repo=>'/directory Implement the repository contract in src/count.mjs. '+
 'For every valid nonnegative integer input, count(n) must return that integer unchanged, including zero and safe large values. '+
 'Reject negative numbers, fractional values, NaN, infinities, numeric strings, missing values, null and object arguments by throwing TypeError rather than returning a value. '+
 'Preserve all existing successful behavior and public exports. Invalid input cannot produce partial state changes. '+
 'Do not edit existing tests or unrelated files. Public smoke tests verify only positive input and do not establish the full behavioral contract.\nREPOSITORY_ROOT: '+repo;
function prompt(opts){
 const content=opts.prompt.split('CURRENT_DIRECTORY:\n')[1].split(/\nREPOSITORY (?:MODE|SYNTHESIS):/)[0];
 return JSON.parse(content);
}
const runRoot=(cwd,id)=>path.join(cwd,'.blackice','directory',id,'runs',id);

test('adversarial review triggers on complex under-tested contracts, not atomic or fully covered tasks',()=>{
 const long=contract('C:\\repo');
 assert.equal(shouldReviewRepository({request:long,
   receipt:{status:'passed'},requirements:{unknownCount:1}}),true);
 assert.equal(shouldReviewRepository({request:long,
   receipt:{status:'passed'},requirements:{unknownCount:0}}),false);
 assert.equal(shouldReviewRepository({request:long,
   receipt:{status:'failed'},requirements:{unknownCount:2}}),false);
 assert.equal(shouldReviewRepository({request:'Implement function score() returning 42.\nREPOSITORY_ROOT: C:\\long\\path\\with\\many\\segments',
   receipt:{status:'passed'},requirements:{unknownCount:1}}),false);
 assert.equal(shouldReviewRepository({request:'Inspect a missing-test repo',
   receipt:{status:'unavailable'},requirements:{unknownCount:1}}),true);
});

test('passing smoke tests trigger source correction, fresh host re-verification and preserved receipts',async t=>{
 const {cwd,repo}=await setup(t),phases=[];
 const runtime={async runAgent(opts){
  const view=prompt(opts);phases.push(view.label);
  if(view.label==='decompose')return {output:JSON.stringify({atomic:true})};
  if(view.label==='work')return {output:JSON.stringify({status:'complete',nextAction:'',finding:'No validation implemented yet'})};
  if(view.label==='repository-review'){
   assert.equal(view.payload.trigger,'complex_contract_undercovered');
   assert.equal(view.payload.hostVerification.status,'passed');
   assert.ok(view.payload.requirementLedger.requirements.length>0);
   assert.match(JSON.stringify(view.payload.explicitRequirementImport),/Reject negative numbers/);
   const changed=await opts.onToolCall({name:'relay_workspace',arguments:{
    action:'patch',path:'src/count.mjs',
    oldText:'export function count(n){return n;}',
    newText:'export function count(n){if(!Number.isSafeInteger(n)||n<0)throw new TypeError("count requires a nonnegative safe integer");return n;}'
   }});
   assert.equal(changed.success,true,JSON.stringify(changed));
   return {output:JSON.stringify({status:'complete',nextAction:'',finding:'Added boundary and input validation',uncertainty:'Host must recheck'})};
  }
  throw Error('No integration model call expected; got '+view.label);
 }};
 const runId='review-change';
 const controller=new ShadowdancerDirectory({cwd,conversationId:runId,runId,model:'remote::test',runtime});
 const result=await controller.run(contract(repo));
 assert.deepEqual(phases,['decompose','work','repository-review']);
 assert.equal(result.stats.verificationStatus,'passed');
 assert.equal(result.stats.contractReview?.trigger,'complex_contract_undercovered');
 assert.equal(result.stats.contractReview?.sourceChanged,true);
 assert.equal(result.stats.contractReview?.testsChanged,false);
 assert.equal(result.stats.reviewReverified,true);
 assert.equal(result.stats.testsPassed,1);
 assert.equal(result.stats.modelSynthesisCallsSkipped,1);
 const base=runRoot(cwd,runId);
 const first=JSON.parse(await readFile(path.join(base,'verification','round-001.json'),'utf8'));
 const second=JSON.parse(await readFile(path.join(base,'verification','round-002.json'),'utf8'));
 assert.equal(first.status,'passed');
 assert.equal(second.status,'passed');
 assert.notEqual(first.sourceSha256,second.sourceSha256);
 const oldModule=JSON.parse(await readFile(path.join(base,'modules','1','result.json'),'utf8'));
 assert.equal(oldModule.status,'superseded_by_review');
 const final=JSON.parse(await readFile(result.finalPath,'utf8'));
 assert.deepEqual(final.referencedResults.map(x=>x.ref),['review:repository','verification:final']);
 assert.deepEqual(final.supersededResults.map(x=>x.ref),['module:1']);
 assert.equal(final.integrationAuthority,'host_source_reference_index');
 const {count}=await import(pathToFileURL(path.join(repo,'src','count.mjs')).href+'?run='+Date.now());
 assert.equal(count(0),0);
 assert.equal(count(3),3);
 assert.throws(()=>count(-1),TypeError);
 assert.throws(()=>count(1.25),TypeError);
 assert.throws(()=>count('2'),TypeError);
 assert.throws(()=>count(null),TypeError);
});

test('review that does not change source preserves the original test receipt and honest unknown coverage',async t=>{
 const {cwd,repo}=await setup(t),phases=[];
 const runtime={async runAgent(opts){
  const view=prompt(opts);phases.push(view.label);
  if(view.label==='decompose')return {output:'{"atomic":true}'};
  if(view.label==='work')return {output:'{"status":"complete","nextAction":"","finding":"No implementation change"}'};
  if(view.label==='repository-review')return {output:JSON.stringify({
   status:'complete',nextAction:'',finding:'Observed missing validation but did not correct it',
   uncertainty:'Input rejection remains unverified'
  })};
  throw Error('Unexpected phase '+view.label);
 }};
 const id='review-nochange';
 const controller=new ShadowdancerDirectory({cwd,conversationId:id,runId:id,model:'remote::test',runtime});
 const result=await controller.run(contract(repo));
 assert.deepEqual(phases,['decompose','work','repository-review']);
 assert.equal(result.stats.contractReview?.sourceChanged,false);
 assert.equal(result.stats.contractReview?.testsChanged,false);
 assert.equal(result.stats.reviewReverified,undefined);
 assert.equal(result.stats.verificationStatus,'passed');
 const base=runRoot(cwd,id);
 const first=JSON.parse(await readFile(path.join(base,'verification','round-001.json'),'utf8'));
 assert.equal(first.status,'passed');
 await assert.rejects(()=>stat(path.join(base,'verification','round-002.json')),{code:'ENOENT'});
 const final=JSON.parse(await readFile(result.finalPath,'utf8'));
 assert.equal(final.modelSynthesis,null);
 assert.match(final.answer,/Unknown requirements/);
 assert.deepEqual(final.referencedResults.map(x=>x.ref),['module:1','verification:final','review:repository']);
 const existing=await import(pathToFileURL(path.join(repo,'src','count.mjs')).href+'?run='+Date.now());
 assert.equal(existing.count(-1),-1,'A review without an edit never proves the missing contract');
});
