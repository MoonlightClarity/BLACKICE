import test from 'node:test';
import assert from 'node:assert/strict';
import {modularReviewPrompt} from '../lib/modular-completion.mjs';

test('reviewer separates missing mapping from actual outcome and retains evidence safeguards',()=>{
 const prompt=modularReviewPrompt({request:{id:'user-request',text:'Fix the function'},evidence:{records:[]}}, {output:'Host test receipt passed; mappings absent'});
 assert.match(prompt,/absent or partial mapping does not erase source reads or observed tests/);
 assert.match(prompt,/private benchmark grades never establish the whole outcome/);
 assert.match(prompt,/preserve actual failures, stale evidence, test tampering, and genuine unknowns/);
 assert.match(prompt,/candidate claim is not independent evidence/);
});
