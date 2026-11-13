import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCoverageEvidence,requirementCoverageScope} from '../lib/shadowdancer-coverage.mjs';
import {modularReviewPrompt} from '../lib/modular-completion.mjs';

test('absent explicit mappings remain unknown without manufacturing failed behavior or completion',()=>{
 const original={requirements:[{id:'R1',statement:'Return a value'}]};
 const receipt={status:'passed',sourceSha256:'source',testSuiteSha256:'suite',file:'receipt'};
 const ledger=applyCoverageEvidence(original,receipt,{status:'absent',accepted:[]});
 const scope=requirementCoverageScope(ledger);
 assert.equal(scope.unmapped,1);assert.equal(scope.mappedFailed,0);
 assert.equal(scope.outcome,'not_assessed_by_mapping');
 assert.equal(ledger.requirements[0].state,'unknown');
 assert.equal(ledger.sourceSha256,'source');
 assert.match(scope.interpretation,/Missing mappings never establish completion/);
 assert.match(scope.interpretation,/not a count of failed or unobserved behaviors/);
 assert.equal(original.requirements[0].state,undefined);
});

test('failed mapped observations and rejected mappings retain failure and uncertainty',()=>{
 const ledger=applyCoverageEvidence({requirements:[{id:'R1'},{id:'R2'}]},
  {status:'failed',sourceSha256:'source'},
  {status:'partially_invalid',accepted:[{requirementId:'R1',outcome:'failed',case:'actual failing test'}],rejected:[{reason:'test_file_changed_after_execution'}]});
 assert.equal(ledger.status,'tests-failed');assert.equal(ledger.coverageRejectedCount,1);
 const scope=requirementCoverageScope(ledger);
 assert.equal(scope.mappedFailed,1);assert.equal(scope.unmapped,1);
 assert.equal(scope.outcome,'not_assessed_by_mapping');
 assert.equal(ledger.requirements[0].state,'failed');
});

test('reviewer separates missing mapping from actual outcome and retains evidence safeguards',()=>{
 const prompt=modularReviewPrompt({request:{id:'user-request',text:'Fix the function'},evidence:{records:[]}}, {output:'Host test receipt passed; mappings absent'});
 assert.match(prompt,/absent or partial mapping does not erase source reads or observed tests/);
 assert.match(prompt,/private benchmark grades never establish the whole outcome/);
 assert.match(prompt,/preserve actual failures, stale evidence, test tampering, and genuine unknowns/);
 assert.match(prompt,/candidate claim is not independent evidence/);
});
