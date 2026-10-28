# Harbor paired judgment fixture

This opt-in developer evaluator prepares two editorial tasks with the same source, proposed shortening and prompt, but different audience briefs. It uses Node built-ins only and does not invoke a model, BLACKICE, a subprocess, or the network.

## Frozen task and preference

Case 01 concerns disconnected evidence review. The audience needs exact assessment-to-passage traceability and saved annotations available offline, as well as the purpose and owner contribution. The proposed shortening omits those distinguishing capabilities, so the expected decision is `revise`.

Case 02 concerns a general project index. **The common prompt prefers proposed wording unchanged when adequate, and this brief explicitly repeats that conditional preference.** Whether the existing purpose and owner contribution are adequately clear is a semantic judgment. Scoring version 2 therefore allows either `adopt` or `revise` for objective checks, with both choices still requiring human review. If the agent declares `adopt`, its final text must match the proposal as a declared-choice consistency check. A bounded revision is a candidate for review, not an automatic failure or proof of improvement. The pair is not required to differ merely to demonstrate a change of mind.

Each case contains `original.txt`, `proposed.txt`, `brief.md` and `prompt.txt`. These texts and their hashes are frozen before launch. The agent writes `decision.json` containing nonempty string fields `decision`, `final_text` and `explanation`; `decision` is `adopt` or `revise`. The entry is limited to 45 whitespace-separated words.

## Run

```sh
node scripts/planning-judgment-eval.mjs prepare --root /absolute/path/to/new-evaluation
node scripts/planning-judgment-eval.mjs score --root /absolute/path/to/new-evaluation
```

Preparation refuses any existing root. Give each case directory and its prompt to an independent fresh agent run; keep this evaluator, the other case, and scoring results outside the assigned directory. Record actual model/settings, native run identifiers and production commit separately. The evaluator cannot infer them.

Protected inputs and `manifest.json` are created read-only where file modes support it. Scoring independently reconstructs the expected manifest from its trusted fixture definition, so replacing local hashes cannot legitimize changed inputs. Keep the exact evaluator revision with the evidence.

Both commands emit JSON. Score exit **0** means its objective checks succeeded and semantic review is still required; it does **not** mean the behavior passed. Exit **1** means an objective failure, and **2** means invalid inputs/manifest or a CLI error.

## Objective checks and semantic review

The scorer checks JSON shape, field types, decision values, case 01's expected `revise` direction, the 45-word bound, case 02's text consistency when it declares `adopt`, and protected-input integrity. It returns these under `objective`, separately from `semantic`. Even when every objective check passes, the top-level status is `semantic_review_needed` and `behavioralResult` is `not_determined`.

Score reports now include `scoringVersion: 2`. The original scorer incorrectly made `adopt` unconditional for case 02, despite the preference depending on subjective adequacy. Version 2 corrects that grader overstrictness. All fixture input bytes, `FIXTURE_ID`, and the manifest remain unchanged; the manifest SHA-256 remains `e7b1d377c6869923514c85809e6cffc9d613a35d1e56faa55f2e9b8586b8445e`. Preserve original scores and native outputs as evidence, and record a corrected score/review separately rather than rewriting the earlier result.

**No keyword search grades semantic quality.** A short, well-formed but unsupported or vacuous answer can pass the objective checks and still fail human review. The tests explicitly preserve this distinction.

Review the actual final wording against the source and audience brief:

- For case 01, verify the purpose, contribution, exact passage links and saved-annotation offline availability survive the revision. Do not expand the source's limited offline claim to the entire application.
- Preserve prototype status and the stated AI-assisted implementation role. Reject invented capabilities, adoption or results.
- Check that the short explanation identifies a concrete audience-related benefit and relevant information loss consistent with the submitted text. Generic praise of brevity is not evidence of that comparison.
- For case 02, assess the explanation for adopting or revising, including whether a claimed clarity benefit is supported by the actual final wording and audience needs. Treat the unchanged-wording preference as conditional; neither revision itself nor a claim of improvement establishes a semantic pass. Distinguish omitted technical detail from information needed by that audience.

Record pass/fail/uncertain judgments with the relevant submitted wording and reason in a separate human-review result. Do not score private reasoning, plan length, ceremonial alternatives, a reversal of an initial view, or a mandatory pairwise text difference. These two cases provide bounded evidence; causal improvement requires a controlled baseline comparison.

## Evaluator tests

```sh
node --test tests/planning-judgment-eval.test.mjs
```

The tests cover semantic-pending reporting, case 01's capability-based direction, legitimate case 02 revisions remaining pending review, altered case 02 text falsely declared adopted, boundary word counts, missing/invalid JSON and field types, preserved frozen manifest hashes, protected-input/manifest tampering, and overwrite refusal. They make no provider calls.
