# BLACKICE field-aware skills retrieval: isolated experiment

Date: November 25, 2026
Branch: experiment/skill-field-retrieval-20261125
Status: source prototype and tests; NOT merged or installed. No job-search goal changed.

## Question and data

Evaluate a local field-aware sparse first stage while preserving BLACKICE's general skill applicability and authority boundaries. The test corpus is the pinned SkillRet v1.1-review public split, Hugging Face revision 2952a620e1ed7cd7037934d96ac918f44da03e1e: 6,006 skills, 4,392 queries and 7,187 relevance labels.

The new 200-query holdout excluded the previously inspected first 25, spaced 25, and earlier 200 random queries (seed 0x51AF). This run used seed 0xC0FFEE. Retrieval did not inspect labels before ranking. Raw files and results are under C:/Users/user/Documents/BLACKICE-backups/skill-system-20261125/.

## Holdout results (200 previously unused queries)

| Method | Recall@8 | nDCG@8 | Complete@8 | Mean query time |
| --- | ---: | ---: | ---: | ---: |
| Field-aware title/description TF-IDF alone | 52.1% | 0.445 | 38.0% | 1.7 ms |
| Field-aware + inert rerank over 50 | 62.3% | 0.549 | 49.0% | 13.3 ms |
| Field-aware + inert rerank over 100 | 66.2% | 0.582 | 54.0% | 25.4 ms |
| Combined legacy/facet/sparse top eight | 49.5% | 0.386 | 36.0% | 72.4 ms |
| Combined router + inert rerank over 100 | **69.6%** | **0.597** | **57.5%** | 94.7 ms |

Initial indexing of 6,006 skills took approximately 137–144 ms and increased observed heap use by 19.7 MB. Automatic loading of public dataset skills is prohibited. The index reads only capped title/description fields, not untrusted bodies.

Paired bootstrap across those same 200:
- Sparse metadata to sparse+body100: +14.1 percentage points Recall@8, exploratory 95% interval +8.5 to +19.4.
- Sparse+body100 to combined router+body100: +3.4 percentage points Recall@8, interval +1.2 to +6.1. nDCG gain ~0.015, interval +0.002 to +0.030.

The previous exhaustive BLACKICE router was run on 20 of exactly these 200 queries because of its high cost: legacy top-eight Recall@8 22.5%, legacy body100 52.5%, with ~3.35 seconds per query. Re-evaluating direct sparse on these SAME 20 yielded 47.5% and direct sparse+body100 62.5%. Do not compare the legacy 20-query means with the 200-query means as if they were matched.

## Critical counterexample

Against 16 manually labeled requests and the actual effective 40-skill BLACKICE catalog, sparse alone found 13 expected skills; the earlier router found 14. Long-Term Judgment on a request to prioritize engineering fixes under a deadline was among sparse-only misses. This method belongs to a declared resource-allocation facet. Therefore sparse retrieval must supplement rather than replace task applicability.

The source checkout was two activation declarations behind the installed bundle for Task decomposition and Structured analytic techniques. Both source declarations were reconciled in this experiment; the owner-edit inheritance behavior is verified with portable temporary test data, not by copying private user skill files.

Some SkillRet labels are noisy or weakly related to their query, e.g. a generic cloud-storage method labeled relevant to a spec-driven workflow. Do not optimize solely against these anomalies.

## Prototype design

The new in-memory SkillFieldIndex maintains separate TF-IDF fields for title and short description, is cache-invalidated by skill identity/source/revision, supports C++/C#/Go tokens, never indexes bodies, and does not authorize or auto-load skills.

In the experimental task router, large catalogs (128+ skills) use a top-100 sparse pool for optional discovery. It preserves existing declared task-facet activation, owner-sourced methods, curated aliases, and the six-method automatic-loading budget. Smaller catalogs retain the current router. A bounded inert body reranker then works on the resulting candidates.

The skill selector and evaluation code are in lib/skill-field-retrieval.mjs, lib/task-skill-discovery.mjs and scripts/evaluate-field-skill-retrieval.mjs. Tests cover cache invalidation, owner-edited activation inheritance, large/small catalog behavior, query bounds, and lack of body leakage. The broader isolated regression suite passed 170/170.

## Interpretation and next gate

These are retrieval outcomes, not successful tasks. The current installed BLACKICE is untouched. Before promotion, compare actual task completion, correctness, tool failures, time, tokens, and owner-imposed constraint adherence under incumbent and field-aware selection. Compare on fresh tasks without changing hard user requirements or adding screening gates. If the additional gain fails task-level verification, retain the simpler system.
