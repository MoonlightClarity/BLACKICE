import test from 'node:test';
import assert from 'node:assert/strict';

import {ShadowdancerDirectory,shouldReviewRepository} from '../lib/shadowdancer-directory.mjs';


const contract=repo=>'/directory Implement the repository contract in src/count.mjs. '+
 'For every valid nonnegative integer input, count(n) must return that integer unchanged, including zero and safe large values. '+
 'Reject negative numbers, fractional values, NaN, infinities, numeric strings, missing values, null and object arguments by throwing TypeError rather than returning a value. '+
 'Preserve all existing successful behavior and public exports. Invalid input cannot produce partial state changes. '+
 'Do not edit existing tests or unrelated files. Public smoke tests verify only positive input and do not establish the full behavioral contract.\nREPOSITORY_ROOT: '+repo;

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
