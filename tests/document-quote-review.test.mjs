import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentQuoteReview} from '../lib/document-quote-review.mjs';
const a='Audited and coached twenty reviewers', b='Designed weighted rubrics';
const valid='Page 1: "'+a+'" supports review experience.\n\nPage 2: "'+b+'" establishes rubric design.';
function fixture(){const r=createDocumentQuoteReview();r.observe({pages:[{page:1,text:a},{page:2,text:b}]});return r}
test('accepts exact source passages with locations',()=>assert.equal(fixture().beforeFinal({output:valid}),null));
for(const [label,output] of Object.entries({generic:'Strong analytical skills',invented:valid+' "This fabricated sentence is nowhere in the attachment."',wrongPage:valid+' Page 4 has education.',ratio:valid+' GPA was 3.92/3.0.'})){
  test('requires correction for '+label,()=>{const review=fixture();assert.equal(review.beforeFinal({output}).continue,true);assert.equal(review.beforeFinal({output:valid}),null)});
}
