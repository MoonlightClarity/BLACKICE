import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodingVerificationCoverage} from '../lib/coding-verification-coverage.mjs';

const receipt=(id,{success=true,state='returned'}={})=>({id,success,state});
const call=(action,path,command)=>({name:'relay_workspace',arguments:{action,...(path?{path}:{}),...(command?{command}:{})}});
const observe=(ledger,value,rec,testReceipt)=>ledger.observe({call:value,result:{success:true},receipt:receipt(rec),verifiedTest:testReceipt});

test('a confirmed edit followed by confirmed test permits one bounded review, with no actions executed by the helper',()=>{
 const tracker=createCodingVerificationCoverage();
 observe(tracker,call('write','C:\\example\\src\\ledger.mjs'),'receipt-1');
 observe(tracker,call('run',null,'node --test'),'receipt-2',{command:'node --test'});
 const first=tracker.review({directoryReady:true,unknownEffects:0,input:'Fix the code and run tests.'});
 assert.match(first,/ONE-TIME CODING VERIFICATION REVIEW/);
 assert.match(first,/receipt-1/);
 assert.match(first,/receipt-2/);
 assert.match(first,/boundary inputs/);
 assert.match(first,/missing collaborator methods/);
 assert.match(first,/restored-state uniqueness and ordering/);
 assert.match(first,/success-implying operations/);
 assert.match(first,/no conflicting retry occurs/);
 assert.match(first,/without guessing hidden code labels/);
 assert.match(first,/do not edit the provided tests/i);
 assert.equal(tracker.review({directoryReady:true}),null,'The review is one-time even if the model returns immediately.');
 assert.equal(tracker.summary().issued,true);
 assert.equal(tracker.summary().editCount,1);
 assert.equal(tracker.summary().testCount,1);
});

test('a test before the last source edit is stale and receives one bounded warning',()=>{
 const tracker=createCodingVerificationCoverage();
 observe(tracker,call('write','src/a.mjs'),'receipt-1');
 observe(tracker,call('run',null,'node --test'),'receipt-2',{command:'node --test'});
 observe(tracker,call('patch','src/a.mjs'),'receipt-3');
 const warning=tracker.review({directoryReady:true});
 assert.match(warning,/STALE-TEST WARNING/);
 assert.match(warning,/receipt-3/);
 assert(!warning.includes('publicTestReceipts'));
 assert.equal(tracker.review({directoryReady:true}),null);
 const fresh=createCodingVerificationCoverage();
 observe(fresh,call('write','src/a.mjs'),'receipt-1');
 observe(fresh,call('run',null,'node --test'),'receipt-2',{command:'node --test'});
 observe(fresh,call('patch','src/a.mjs'),'receipt-3');
 observe(fresh,call('run',null,'node --test'),'receipt-4',{command:'node --test'});
 assert.match(fresh.review({directoryReady:true}),/receipt-4/);
});

test('failed writes, suspicious tool results and non-code file edits do not trigger coverage review',()=>{
 const tracker=createCodingVerificationCoverage();
 tracker.observe({call:call('write','src/a.mjs'),result:{success:false},receipt:receipt('receipt-failed',{success:false})});
 tracker.observe({call:call('write','src/b.mjs'),result:{success:true},receipt:receipt('receipt-unknown',{state:'unknown'})});
 tracker.observe({call:call('write','README.md'),result:{success:true},receipt:receipt('receipt-readme')});
 tracker.observe({call:{name:'relay_workspace',namespace:'foreign',arguments:{action:'write',path:'src/x.mjs'}},result:{success:true},receipt:receipt('receipt-ns')});
 observe(tracker,call('run',null,'node --test'),'receipt-test',{command:'node --test'});
 assert.equal(tracker.summary().editCount,0);
 assert.equal(tracker.review({directoryReady:true}),null);
});

test('no user gate: reject review when work is unfinished, uncertain, cancelled or explicitly scoped',()=>{
 const cases=[
  {directoryReady:false},{unknownEffects:1},{remainingSteps:2},{candidateIncomplete:true},{signalAborted:true},
  {runSettled:true},{hasPendingDirections:true},{hasSteer:true},{scopedWorker:true},{benchmark:true},{hasGoal:true},
  {input:'Please do not run additional tests.'},
 ];
 for(const params of cases){
  const tracker=createCodingVerificationCoverage();
  observe(tracker,call('write','src/worker.ts'),'receipt-1');
  observe(tracker,call('run',null,'node --test'),'receipt-2',{command:'node --test'});
  assert.equal(tracker.review({directoryReady:true,...params}),null,JSON.stringify(params));
  assert.equal(tracker.summary().issued,false);
 }
});

test('the review is bounded when a long coding task performs many writes and tests',()=>{
 const tracker=createCodingVerificationCoverage();
 for(let i=0;i<80;i++){
  observe(tracker,call('write','src/module-'+i+'.js'),'edit-'+i);
  observe(tracker,call('run',null,'node --test'),'test-'+i,{command:'node --test'});
 }
 const prompt=tracker.review({directoryReady:true});
 assert(prompt.length<4000,'Reviewer prompt unexpectedly grew to '+prompt.length);
 assert.match(prompt,/edit-79/);
 assert.match(prompt,/test-79/);
 assert(!prompt.includes('edit-1"'));
});
