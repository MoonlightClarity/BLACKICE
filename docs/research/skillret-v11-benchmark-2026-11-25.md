# SkillRet v1.1: measured general skill retrieval

Date: 2026-11-25. Scope: BLACKICE's general skills infrastructure, not job qualifications or application filters.

## Pinned public evidence

Hugging Face dataset: https://huggingface.co/datasets/anonymous-ed-benchmark/SKILLRET
Fixed revision: 2952a620e1ed7cd7037934d96ac918f44da03e1e (v1.1-review).
The local pinned test split contains 6,006 skills, 4,392 queries, and 7,187 relevance labels. All public skill bodies are inert benchmark data. They are never installed, executed, or promoted to developer/user instructions.

Saved source checksums:
- skills/test.jsonl: SHA-256 1960453e422e4ba01977197580934ca3c02b2ac302dfa9c0d074707d961b7c81
- queries/test.jsonl: SHA-256 4d07a35f40e597f8468c6dab480c95a1f9b40ecbde80274081ba2e7c643d0f6d
- qrels/test.jsonl: SHA-256 edbfae0b8109de460d54e27e6235b1b47316f34956744db0571ad1b4ddb860af

## Measured retrieval results

| Method | Queries | Recall@8 | nDCG@8 | Complete@8 | Mean automatic skill selections |
| --- | --- | ---: | ---: | ---: | ---: |
| Original, unbounded selector over public corpus | First 25 | 31.3% | 0.247 | 20% | 124.08 |
| Trusted-source selector, metadata only | First 25 | 32.7% | 0.273 | 20% | 0 |
| Trusted-source selector, metadata only | Evenly spaced 25 | 36.7% | 0.316 | 28% | 0 |
| Inert body rerank of top-100 candidates | First 25 | 59.3% | 0.558 | 44% | 0 |
| Inert body rerank of top-100 candidates | Evenly spaced 25 | 59.3% | 0.551 | 52% | 0 |

The original 124 automatic selections occurred in a benchmark harness that represented all public skills as candidate metadata. That was a routing policy defect, **not** 124 observed live provider skill loads. Runtime automatic activation now requires an effective installed user or bundled skill, has a maximum of six automatically chosen optional methods, and keeps over-budget candidates in metadata.

Body reranking took an additional average 20.7 ms per query in the first sample and 19.6 ms in the spaced sample. With top-100 stage-one candidates, the best achievable recall on those samples was only 63.3% and 68.7%. Improving first-stage coverage remains important. Metadata retrieval itself averaged about 2.3 seconds per query over the full 6,006-skill corpus, much larger than BLACKICE's live catalog.

The evaluation program initially exited successfully without output because it compared a Windows path alias with a different canonical module path. Both paths are now resolved before checking the command-line entrypoint. A subprocess regression verifies real JSON output.

## Product integration

- Public dataset skill bodies are never eligible for automatic provider injection.
- Automatic selection has a finite six-method budget; excess methods remain discoverable.
- Routing decision records include a bounded score to support diagnosis and experiments.
- Benchmark queries reuse a disposable local search index rather than rebuilding it unnecessarily.
- The runtime's second stage may inspect at most 64 effective locally registered candidate skills, with only the first 16,000 characters per body considered as lexical evidence.
- It verifies current metadata, skill identity, origin, and revision. Changed or missing skill bodies cannot be silently substituted.
- The model receives a small list of selected **metadata**, never the inspected body text. Reading the skill through the regular tool remains a separate action.
- Owner-imposed scope gates and host permissions are unchanged. Counterparty qualifications are not converted to prohibitions.

## Reproduction

Pinned local data is under:
C:/Users/user/Documents/BLACKICE-backups/skill-system-20261125/benchmark-data/2952a620e1ed7cd7037934d96ac918f44da03e1e/

Run the evaluator from the BLACKICE repository:

    node scripts/evaluate-skill-routing.mjs --skills=PATH/skills.jsonl --queries=PATH/queries.jsonl --qrels=PATH/qrels.jsonl --limit=25 --top-k=8 --sample=spaced --body-pool=100

The result describes retrieval, **not** observed improvement in actual delegated tasks. The user-selected goal's expired deadline was preserved.

## What remains uncertain

- The two sets of 25 synthetic queries are not sufficiently broad to establish long-term lift for every domain. Expand using fixed, version-pinned samples and compare confidence intervals.
- The runtime's body review uses up to 64 candidates rather than the experiment's 100; production usefulness is not certified by the public score.
- More retrieval skill matches or automatic activations do not establish task-level benefit. Measure matched with-skill/without-skill tasks, verified results, failure handling, time, and token cost.
- Typed complement, depends-on, specializes and conflicts relationships should be introduced only after the routing/provenance data shows which ones matter.
