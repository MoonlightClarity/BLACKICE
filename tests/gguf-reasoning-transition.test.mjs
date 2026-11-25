import test from 'node:test';import assert from 'node:assert/strict';
import {extractReasoningTransition} from '../scripts/gguf-reasoning-transition.mjs';
test('finds final answer logits after reasoning without mistaking reasoning-token logits for the answer',()=>{
 const parts=[{token:'Let me check'},{token:'</think>'},{token:'\n\n'},{token:'B',logprob:-0.1,top_logprobs:[{token:'B',logprob:-0.1},{token:'A',logprob:-2.1}]},{token:') No.'}];
 const r=extractReasoningTransition({completion_probabilities:parts});
 assert.equal(r.status,'answer-transition-located');
 assert.equal(r.answerChoice,'B');
 assert.equal(r.answerTokenIndex,3);
 assert.equal(r.logOddsAOverB,-2);
 assert.ok(r.reasoningChars>0);
});
test('does not claim a source-grounded choice when the reasoning finalizer or answer is missing',()=>{
 assert.equal(extractReasoningTransition({}).status,'missing-token-probabilities');
 assert.equal(extractReasoningTransition({completion_probabilities:[{token:'Okay'}]}).status,'missing-reasoning-finalizer');
 assert.equal(extractReasoningTransition({completion_probabilities:[{token:'Reasoning</think>\n\nMaybe'}]}).status,'no-final-answer-choice');
});
