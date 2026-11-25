# Analytical fidelity: isolated benchmark record

**Scope:** Isolated branch `fix/analysis-intent-continuity-1124`, based on `f36d06bc`, with implementation `5c27af2f`. This report does not authorize a production installation, merge, or model substitution. It excludes the underlying private source document, contact details, full prompts, and unredacted model transcripts.

## Demonstrated repair

The original two failure modes were (a) interpreting an evaluator persona as a property of the document's subject and (b) treating a subsequent request to finish analysis as a new opportunity to summarize. The isolated patch distinguishes subject, operation, and evaluator role; saves the original objective; reuses complete source-bound reconstruction for a same-task analytical follow-up; and renders a concise synthesis rather than all intermediate stages by default.

**Deterministic test result:** 132 passed, 0 failed after the implementation. The engine-level fixture specifically checks an employer-perspective request followed by "analyze it," with no repeat neutral-source pass. These tests establish routing, source identity, sequencing, and presentation behavior, not the semantic quality of model judgments.

## Live model comparisons on one two-page source

| Experiment | Input and model | Observed result | Quality interpretation |
|---|---|---|---|
| Existing multi-stage behavior | MiniCPM-V-4.7-1B-heretic-Q4_K_S, many individual neutral sections, then assessment | Source outline present, yet assessment focused on a few facts, misinterpreted the employer persona in some runs, and sometimes stopped with no substantive assessment | **Fail**. Phase receipts and nesting did not establish understanding |
| Reverse-section neutral prompt | MiniCPM, source sections presented backward | No visible neutral summary, despite spent generation tokens | **Fail**. Avoid this format |
| Plain-original neutral reconstruction | MiniCPM, original two-page text in one prompt | Completed in about 25 s, but changed a degree abbreviation and simplified a source organization name | **Incomplete fidelity**. Use original text rather than trusting the paraphrase |
| Plain neutral reconstruction followed by assessment | MiniCPM, original text plus fallible neutral summary | Two model calls about 47 s total; concise final answer, but inferred limitations from remote/contract work and incorrectly described project evidence as absent | **Fail semantic quality**, despite lower cost and less verbose output |
| Evidence-only work descriptions, then full-source assessment | MiniCPM, first pass withholding titles/dates/degrees, second pass restoring source | Around 30 s total; analysis better anchored to tasks, yet still introduced remote-work heuristics, conflated responsibilities between roles, and mishandled existing source references | **Fail semantic quality**. Useful ablation only, not suitable default |
| Exact compact-analysis user prompt control | GPT-6 Luna through authenticated Codex CLI, same 8,577-character source + neutral-summary prompt | Completed in about 12 s; connected evidence across positions, distinguished reported practice from proven outcomes, and treated missing evidence mainly as interview questions | **Better, not certified**. Some weaker claims and awkward chronology remain |

All tested model calls were read-only. MiniCPM used a temporary local llama.cpp server, then that server was explicitly stopped. Luna used a separate Codex CLI transport with subscription authentication, so the last row is **not a transport-controlled model-only ablation**. No paid API key was passed. Both source content and model responses remain in untracked private local receipts, not in the Git commit.

## Additional control: omit the neutral summary

A fresh GPT-6 Luna run used the same original text and analytical instruction as the compact comparison but omitted the separate neutral model summary. It completed in about 12 seconds and connected the reported analytical work, product responsibilities, and practical interview questions. It also leaned more heavily on contract duration when questioning leadership scope, without a vacancy requiring conventional tenure. The version with the neutral summary was somewhat better calibrated in this specific comparison, but one sample does not establish a causal effect.

The comparison also exposes a limitation of this experiment: the strong model used an authenticated Codex CLI transport with different hidden system context. The input source and user task were held constant, but provider transport and model changed. Do not treat the results as a controlled model-only estimate or a requirement to use a subscription.

## Conclusion and decision

The intent/continuation defect has isolated functional coverage. The remaining analytical deficit cannot be reliably repaired by changing the number of phases, forcing more nested lists, imposing a schema, or repeating anti-proxy warnings. A small model may reproduce the appearance of source-grounded reasoning without making supported interpretations. Repeating these interventions with no quality gain would be another form of proxy optimization.

**Do not replace the installed analytical pipeline with either experimental compact variant yet.** Retain the isolated intent/continuation patch for review. A follow-on implementation should evaluate actual cross-source interpretation, attribution, unsupported absences, and the implications of observations; it must not label mere source coverage or format compliance as semantic verification. Compare stronger and weaker models using the same authenticated transport where possible before assigning a causal explanation to model size alone.

**Status:** Worktree-only experiments, no main merge, no installation or published release.

## Follow-up: literal-source checks, real-engine execution, and bounded recovery

- The initial seven-claim MiniCPM self-audit was **rejected**. The model approved actor misattribution and false quantity/absence claims, produced malformed JSON, and did not reliably respect the requested seven independent decisions. Changing presentation order did not correct it. No model self-grading was introduced as a quality gate.
- A narrow host-side source consistency diagnostic was added. It records possible **direct absence/mention conflicts** and unmatched literal quotations, without automatically rewriting an answer or certifying semantic accuracy. It catches a historical false "no GitHub" claim. An initial loose matching rule also flagged legitimate source statements and was tightened before use; seven focused tests now cover polarity, qualified claims, partial-word overlap, multiple lines, and unrelated document domains. It **does not detect** most unsupported capability, stability, causality, attribution, or impact inferences.
- A first live run of the isolated real engine with MiniCPM failed the first structured neutral-summary phase. That probe used a generic compatible endpoint that **omitted** BLACKICE's verified managed-llama JSON-schema transport. This was a test configuration mismatch, **not a demonstrated production bug**.
- A corrected isolated transport explicitly enabled the verified JSON-schema response format supported by the same local llama.cpp binary. The real engine then executed its host outline, **11 neutral summaries**, initial assessment, challenge, and synthesis. It completed in roughly **five minutes** for a two-page résumé. The output was **not** a good analysis: it mostly rephrased model and platform capabilities, mistook asserted details for confirmed competence, and its automatic source footer included irrelevant contact-header line references. This distinguishes successful execution from true analytical work.
- The branch now rejects obvious **imperative task-instruction echoes** in the analytical claim and challenge fields unless that wording genuinely appears in the source text. This check is narrow and source-based, not a semantic quality score.
- If a strict intermediate artifact cannot be returned after its bounded retry, the branch attempts **one read-only plain-language source-grounded fallback** instead of ending with a formatting failure. That fallback remains labeled *not semantically verified*. The implementation and empty-result/failure boundaries were tested with an isolated engine fixture, **not demonstrated as an improvement to MiniCPM's substantive quality**.
- The default output no longer appends model-proposed source IDs as if they were verified supporting citations. References remain inspectable in the saved intermediate artifact, but their relevance must not be inferred merely from valid IDs.
- Final regression suite: **143 passed, 0 failed**, including the prior intent/continuation cases. The installed application, main branch, and existing provider settings remained unchanged. The only test runtime was the separately bound local loopback model, using a disposable isolated engine/profile copy.

**Assessment:** The intent and continuation repairs are supported by deterministic tests. The new receipt and fallback mechanisms improve observability and execution resilience but **do not solve semantic reasoning quality**. Further hard gates based on shallow counts, schema compliance, or the model's own agreement would repeat the original Goodhart failure. A viable production decision requires comparing source-aware actual judgments using the intended selected models and evaluating the substantive reasoning—not just task completion receipts.
