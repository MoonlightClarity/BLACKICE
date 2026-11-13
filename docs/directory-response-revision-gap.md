# Repository response-only revision: unresolved publication boundary

Status: bounded host-fact report revision implemented; general semantic report synthesis remains unresolved.

The repository/no-page route now passes responseInstructions to a read-only
section-selection inference. Its output can only select typed host fact sections
(changes, exact test receipt, mapping scope, reference index). Publication renders
those from host-owned values, keeping mandatory warnings and completion status.
The revision regression exercises reviseAnswer, verifies prior-report retention,
additional exact receipt details, no repeated work, and rejection of fabricated
claims/citations. Repeated unchanged selection still returns the same candidate;
no counter or random text manufactures progress.

This fixes dropped instructions for requests within those host-fact sections.
It does NOT establish arbitrary behavioral outcomes or publish free-form semantic
corrections. Such cases still need the evidence-bound interpretation interface
below. Do not claim that this bounded change resolves the live benchmark stall.

The reproduction below describes the original boundary before this change.

Commit 054e485 clarifies that absent explicit requirement-to-test mappings
are neither failed behavior nor proof of completion. Its 17 focused passing
tests do not establish that repository response revision works.

## Reproduced root cause

In lib/shadowdancer-directory.mjs:

1. reviseAnswer(prompt) preserves previous-final.json, records the revision,
   then calls finishRun(await integrate({responseInstructions:prompt})).
2. integrate() takes the repository/no-page shortcut to
   integrateRepositoryEvidence(activeRefs,supersededRefs,requiredTerms).
   responseInstructions is not passed to that method.
3. integrateRepositoryEvidence() creates a deterministic host reference index
   and audit candidate. It cannot perform a response revision.
4. finishRun() replaces repository synthesis with host-owned source/test audit
   text. This intentionally prevents fabricated tests and file-change claims.
   Even disabling the shortcut alone would not publish corrected synthesis.
5. runShadowdancerDirectory() sends this candidate back to onBeforeFinal.
   Repeated responseOnly requests can therefore receive the same candidate,
   without any new evidence. The no-progress guard is valid, not the root bug.
6. The existing exact-reviewed atomic candidate path is deliberately limited
   by atomicReviewEligible = !repoRoot ... . Do not simply enable it for
   repositories: it does not replace repository hash/integrity validation.

An isolated executable fixture called the actual integrate() method with one
verification ref, mocked only its terminal index writer, then called it again
with responseInstructions. Observed result:
{"sameAnswer":true,"instructionPassed":false,"hostIndexCalls":2}

Reproduction (Node from repository root):

```js
import {ShadowdancerDirectory} from './lib/shadowdancer-directory.mjs';
const r=Object.create(ShadowdancerDirectory.prototype);
r.allRefs=[{kind:'verification',ref:'verification:final'}];
r.repoRoot='fixture';r.request='Fix source';
const calls=[];
r.integrateRepositoryEvidence=async(...args)=>{
 calls.push(args);return {answer:'same host audit',finalPath:'fixture'};
};
const a=await r.integrate();
const b=await r.integrate({responseInstructions:'Correct report only from receipts'});
console.log({sameAnswer:a.answer===b.answer,
 instructionPassed:calls[1].includes('Correct report only from receipts'),
 hostIndexCalls:calls.length});
```

## Required interface, not a prose-only bypass

Introduce a host-owned repository report/evidence envelope shared by integration,
revision, publication, and outcome review. Each fact needs:
- immutable factId, fact type, source receipt and content hash;
- sourceSha256 and testSuiteSha256, current/stale state and integrity state;
- exact host-observed value and scope (changed file, test case/result,
  declared mapping, or observed tool readback), not model conclusions;
- model interpretation separately typed and never promoted to observed fact.

Response revision consumes the current envelope and responseInstructions under
read-only tools. It may select/reorder exact fact IDs and propose an interpretation
citing admitted receipts. Publication revalidates the referenced hashes and all
mandatory failure/integrity warnings. Arbitrary text cannot override a fact,
convert unknown to success, or certify an outcome. Any semantic interpretation
requires an exact-candidate/evidence-bound outcome assessment, kept separate from
host factual assertions. Persist that boundary before returning the revised
report. Do not confuse the outcome reviewer's judgment with independent proof.

A selector that merely rearranges identical facts, adds a revision counter, or
echoes instructions is not sufficient. That would evade the no-progress check
without addressing the requested correction. Likewise, publishing unvalidated
model synthesis would regress the reason finishRun suppresses it.

## Acceptance regressions before integration

- A repository revision receives the exact response instruction, uses actual
  observed source/test receipts, changes a genuinely incorrect report, and
  reaches a reviewed outcome without replaying work/tools.
- Prior candidate, instruction, evidence snapshot and exact revised candidate
  remain saved; no repeated source effects.
- Fabricated test success, fabricated edits, arbitrary citation IDs and private
  benchmark grades cannot enter host facts or establish completion.
- Source/test changes after verification, modified pre-existing tests, failed
  tests and unmapped requirements retain their exact warning/uncertainty scope.
- Missing mapping alone cannot manufacture unfinished user work; independently
  missing behavioral evidence must still remain unresolved.
- Unchanged, unsupported revision still trips the real no-progress guard.
- Non-repository receipt/report repair and repository host-index tests remain
  passing.

No live benchmark/runtime/release was modified during this investigation.
