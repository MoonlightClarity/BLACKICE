# BLACKICE skills infrastructure: research and implementation

Date: 2026-11-25. Scope: general skill discovery, applicability, composition, provenance, and evaluation. Job search is an observed regression case, not a special qualification-filtering feature.

## Diagnosis grounded in overnight runs

- The active goal was exactly "apply for jobs"; user scope conditions remained separate from counterparty demands.
- The installed router recognized only the dependent-work facet. It selected Task decomposition but never activated Long-Term Judgment, although that skill already addresses effort, delay and marginal value.
- The optional method shortlist was a flat top eight, with no redundancy penalty; several similar methods could displace a complementary approach.
- Overnight evidence included many short discovery turns on inaccessible or redirected listings, and a later long application turn. A submitted application is not proof that the chosen route offered the best return on time.
- Direct hands-on capability, transferable skills, AI-assisted orchestration, plausible ability and missing evidence have distinct provenance. They may change expected execution or preparation cost; they are not automatic employer-qualification vetoes.

## External research and use

- SkillRet (arXiv 2605.05726; HF anonymous-ed-benchmark/SKILLRET) offers about 17,810 public agent skills, disjoint train/test skill sets, thousands of held-out synthetic queries and binary relevance labels. It measures retrieval, not task success or safety. Pin the precise revision because published dataset card snapshots show differing split counts.
  https://arxiv.org/abs/2605.05726
  https://huggingface.co/datasets/anonymous-ed-benchmark/SKILLRET
- SkillRouter (arXiv 2603.22455; HF pipizhao/SkillRouter-Eval-Core) finds full skill-body information important for disambiguating overlapping descriptions. Consider read-only bounded body-based reranking after cheap metadata retrieval. Do not inject untrusted full instructions into worker context.
  https://arxiv.org/abs/2603.22455
  https://huggingface.co/datasets/pipizhao/SkillRouter-Eval-Core
- AgentSkillOS (arXiv 2603.02176) reports gains from capability-tree retrieval and multi-skill DAG orchestration. Diversified shortlist presentation is not yet an executable DAG.
  https://arxiv.org/abs/2603.02176
- SkillsBench 1.1 uses paired with-skill/without-skill evaluation across 87 tasks in eight domains, including some negative skill lift. Skill usefulness requires verified task outcomes, not merely skill invocation counts.
  https://www.skillsbench.ai/blogs/skillsbench-1-1
  https://huggingface.co/datasets/benchflow/skillsbench
- Skill-Injection (arXiv 2602.20156) documents untrusted skill file attack surfaces. Public benchmark skill bodies are treated as inert data, with no automatic installation, elevation, or execution.
  https://arxiv.org/abs/2602.20156
- Carbonell and Goldstein (SIGIR 1998) introduced maximal marginal relevance, balancing relevance with novelty. BLACKICE now uses a transparent bounded approximation on candidate metadata.
  https://doi.org/10.1145/290941.291025
- TRACE-Router (arXiv 2607.22465) highlights the mismatch between per-step routing proxies and delayed task-level feedback. Future method ranking should use verified task outcomes, not model-reported progress, clicks, or speed alone.
  https://arxiv.org/abs/2607.22465

## Implemented in this change

1. Merged the richer installed selection code, applicability metadata, semantic routing, and decision trace into repository source without overwriting unrelated installed document-analysis code.
2. Added the general resource-allocation facet. Recurring, time-constrained, and competing-option tasks can activate it; specific one-off work and skill-maintenance requests do not activate it merely because a domain is mentioned.
3. Activated and revised Long-Term Judgment to distinguish owner scope, observed capability, transferable ability, assisted work, unknown evidence, and marginal opportunity cost. Compare a real alternative when useful; do not introduce qualification exclusions.
4. Added deterministic diversity-aware selection of optional skill candidates, retaining the leading relevant method and discounting near-duplicates.
5. Preserved existing selection and actual prompt-acceptance delivery receipts. Selection alone is not compliance.
6. Added multi-domain routing and selection tests.
7. Added a SkillRet-compatible offline evaluator for recall, precision, normalized DCG, MRR, completeness, and average automatic skill selections. It never executes public skill bodies.

## Reproducing retrieval evaluation

Export the pinned SkillRet test skills, queries, and qrels splits as JSONL (use the names skills.jsonl, queries.jsonl, and qrels.jsonl). Run from the repository:

    node scripts/evaluate-skill-routing.mjs --skills=PATH/skills.jsonl --queries=PATH/queries.jsonl --qrels=PATH/qrels.jsonl --limit=25 --top-k=8

The default sample is deliberately bounded. Record corpus, query count, dataset revision, and metrics before comparing variants. Public retrieval results do not by themselves prove improvement for BLACKICE's own installed skill set.

## Future phases not claimed as complete

- Body-aware reranking with source and authority separation; benchmark against metadata-only retrieval.
- Typed complement, dependency, specialization and conflict relations, with proposed links verified before activation.
- Paired no-skill, flat, diversified, and composed runs on matched tasks with checks for outcome, latency, tool failures, uncertainty and user-scope violations.
- Adaptive routing using only delayed, observed outcomes and a no-adaptation baseline; no reward for superficial progress or easy-to-count activity.
