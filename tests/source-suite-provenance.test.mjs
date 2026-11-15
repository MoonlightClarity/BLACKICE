import test from 'node:test';import assert from 'node:assert/strict';
import {sourceSuiteIdentity} from '../scripts/source-suite-provenance.mjs';
test('a diverged workflow controller cannot replace the actual checkout identity',()=>{
 const source='a'.repeat(40),controller='b'.repeat(40);
 assert.deepEqual(sourceSuiteIdentity('unused',{readHead:()=>source,controllerCommit:controller}),{sourceCommit:source,workflowControllerCommit:controller,sourceCommitOrigin:'git-rev-parse-HEAD'});
});
test('missing or failed checkout identity never falls back to the workflow SHA',()=>{
 for(const value of ['',undefined,'HEAD','a'.repeat(7)])assert.throws(()=>sourceSuiteIdentity('unused',{readHead:()=>value,controllerCommit:'b'.repeat(40)}),/checkout identity/);
 assert.throws(()=>sourceSuiteIdentity('unused',{readHead:()=>{throw Error('git unavailable');},controllerCommit:'b'.repeat(40)}),/git unavailable/);
});
test('checkout changes remain observable even when workflow identity stays fixed',()=>{
 const options={controllerCommit:'b'.repeat(40),readHead:()=>head};let head='a'.repeat(40);
 const before=sourceSuiteIdentity('unused',options);head='c'.repeat(40);const after=sourceSuiteIdentity('unused',options);
 assert.notEqual(before.sourceCommit,after.sourceCommit);assert.equal(before.workflowControllerCommit,after.workflowControllerCommit);
});
