import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureOutcomeReview, finishFixtureCandidate } from './fixture-modular-provider.mjs';
import { modularReviewPrompt, MODULAR_OUTCOME_SCHEMA } from '../lib/modular-completion.mjs';
test('synthetic provider invokes the final gate and does not discard continuation or rejection', async () => {
 let calls=0; const candidate={output:'Checked fixture result.'};
 assert.equal(await finishFixtureCandidate({onBeforeFinal:async value=>{calls++;assert.equal(value,candidate);return null;}},candidate),candidate);
 assert.equal(calls,1);
 await assert.rejects(finishFixtureCandidate({onBeforeFinal:async()=>({continue:true,prompt:'Do remaining work.'})},candidate), /must not discard/);
 await assert.rejects(finishFixtureCandidate({onBeforeFinal:async()=>{throw Error('Rejected outcome');}},candidate), /Rejected outcome/);
});
test('synthetic review recognizes only isolated modular assessment and preserves supplied evidence IDs', () => {
 assert.equal(fixtureOutcomeReview({responseOnly:true,prompt:'An unrelated optional analysis.'}),null);
 const snapshot={evidence:{records:[{id:'actual-receipt'}]}},candidate={output:'Checked fixture result.'};
 const options={responseOnly:true,sandbox:'read-only',outputSchema:MODULAR_OUTCOME_SCHEMA,prompt:modularReviewPrompt(snapshot,candidate)};
 assert.deepEqual(JSON.parse(fixtureOutcomeReview(options).output).evidenceRefs,['actual-receipt']);
 assert.throws(()=>fixtureOutcomeReview({...options,sandbox:'workspace-write'}));
 assert.throws(()=>fixtureOutcomeReview({...options,outputSchema:{}}));
});
