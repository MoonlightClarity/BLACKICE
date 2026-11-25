import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSourceClaims} from '../lib/source-claim-review.mjs';
const src=[
 {id:1,text:'The team shipped a public API and published a repository at https://example.org/repository.'},
 {id:2,text:'Three projects were described in detail, including tests and a migration.'},
 {id:3,text:'There are no independent production benchmarks for system latency.'},
 {id:4,text:'The report quotes: “Project Zebra reached staging in June”.'}
];
test('direct source absence conflicts are candidates, not falsely certified contradictions',()=>{
 const report=reviewSourceClaims({answer:'There is no repository. The report provides no project examples.',units:src});
 assert.equal(report.semanticVerification,'not-established');
 assert.equal(report.status,'inspected');
 assert.ok(report.flags.some(f=>f.kind==='possible-absence-conflict'&&f.sourceRefs.includes(1)));
 assert.ok(report.flags.some(f=>f.kind==='possible-absence-conflict'&&f.sourceRefs.includes(2)));
 assert.ok(report.flags.every(f=>f.status==='candidate-review-only'));
});
test('qualified absences must not be conflated with weaker literal presence',()=>{
 const report=reviewSourceClaims({answer:'There are no independent production benchmarks. The source reports no latency benchmark.',units:src});
 assert.ok(!report.flags.some(f=>f.kind==='possible-absence-conflict'));
});
test('literal quotations are checked against exact source text, not invented evidence',()=>{
 const report=reviewSourceClaims({answer:'The source says “Project Zebra reached staging in June” but nowhere says “Every customer got a completed installation”.',units:src});
 assert.ok(!report.flags.some(f=>f.kind==='unmatched-literal-quotation'&&f.quote.startsWith('Project Zebra')));
 assert.ok(report.flags.some(f=>f.kind==='unmatched-literal-quotation'&&f.quote.startsWith('Every customer')));
});
test('an unrelated source domain receives the same checks without a resume-specific ontology',()=>{
 const source=[{id:9,text:'The laboratory collected 112 samples and documented the measured concentrations.'}];
 const flags=reviewSourceClaims({answer:'The study collected no samples. The data proves no scientific findings.',units:source});
 assert.ok(flags.flags.some(f=>f.sourceRefs.includes(9)));
});
test('a missing source, short quotes, and proper source negation do not masquerade as semantic verification',()=>{
 assert.equal(reviewSourceClaims({answer:'No projects.',units:[]}).status,'unavailable');
 const r=reviewSourceClaims({answer:'The memo says “no repository” and reported that no repository exists.',units:[{id:4,text:'The memo says no repository was established.'}]});
 assert.ok(!r.flags.some(f=>f.kind==='possible-absence-conflict'));
 assert.equal(r.semanticVerification,'not-established');
});

test('the reviewer does not flag common partial-term overlaps as contradictions',()=>{
 const src=[{id:1,text:'Structured analysis of expert work is documented.'},{id:2,text:'No simple answer key existed, so analysts compared interpretations.'},{id:3,text:'Project details were summarized for the customer.'}];
 const a=reviewSourceClaims({answer:'The résumé does not provide work samples. The project was completed without a simple answer key.',units:src});
 assert.ok(!a.flags.some(f=>f.kind==='possible-absence-conflict'),JSON.stringify(a.flags));
});

test('separate bullet lines retain independent negative-claim boundaries',()=>{
 const src=[{id:1,text:'Repository: https://example.org/repository'}, {id:2,text:'No independent benchmarks are available.'}];
 const r=reviewSourceClaims({answer:'- No repository.\n- No independent benchmarks.',units:src});
 assert.equal(r.checked,2);
 assert.ok(r.flags.some(f=>f.kind==='possible-absence-conflict'&&f.sourceRefs.includes(1)));
 assert.ok(!r.flags.some(f=>f.kind==='possible-absence-conflict'&&f.sourceRefs.includes(2)));
});
