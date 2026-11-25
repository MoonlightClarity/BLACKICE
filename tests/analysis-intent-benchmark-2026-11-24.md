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

## Additional ablation: compact full-source analysis and true continuation

The previous 14-stage route was compared against shorter alternatives on the same two-page original résumé with the same local MiniCPM-V-4.7-1B-heretic-Q4_K_S model.

- One-pass source analysis with a direct hiring-side task returned in **16.3 seconds** (1,199 characters); an alternative consequential-questions prompt returned in **17.4 seconds** (1,888 characters). Both carried more source material than the previous long pipeline but still overclaimed technical ability or failed to produce genuinely competing interpretations.
- Two per-page neutral passes followed by analysis consumed about **72.8 seconds**. Both neutral outputs ended at their generation limits, and one attributed a repository reference to the wrong organization. The final analysis repeated the same unsupported leadership/engineering framing. This **did not** validate adding neutral-summary stages.
- A new isolated branch route now handles **one fully read document with no more than 80 structural units and 8,000 source characters**, unless the user explicitly requests the detailed working/outline. It retains the exact host source inventory, observed literal hierarchy where available, and original text. It uses **one fresh read-only model response**, not eleven independent model-generated summaries plus initial, challenge, and final schema calls. Longer or explicit working requests retain the existing staged route. The limits are transport/context bounds, **not quality scores or evidence of comprehension**.
- The first real isolated engine run used one model turn (about **33 seconds**, 2,685 output characters) and completed a same-task "analyze it" follow-up (about **33 seconds**, 2,262 output characters). The current task, requested hiring-side viewpoint, same-source identity, and literal outline were preserved. But the follow-up **repeated** role summaries, added remote-work hiring heuristics, and did not deeply analyze.
- The follow-up route was then revised to include the prior answer, explicitly **as fallible previous work rather than original evidence**, and request correction/advancement. A second real isolated engine run completed in about **22 seconds** (1,641 characters), then "analyze it" completed in about **29 seconds** (1,973 characters). The previous source outline was reused. Nevertheless MiniCPM again largely repeated the prior interpretation and confidently asserted technical depth/trustworthiness the résumé could not establish.
- The selected source-method frontmatter is identified for **routing**, but the compact turn intentionally does not inject the whole long skill texts. The receipt explicitly distinguishes route selection from provider delivery; it must never be read as a claim that all selected skills were delivered or that the model fulfilled their full semantic requirements.

**Decision:** Retain the compact approach in this isolated branch as an **efficiency/continuity experiment**, not a fix for substantive analysis. Model capability and source-evidence interpretation remain unresolved; successful execution cannot be used as a proxy for reliable inference. The benchmark concerns the selected local model, not a general judgment about all small models.

The full isolated regression suite after the compact implementation passed **147 tests, zero failures**, and focused tests passed after clarifying routing-only skill receipts. Neither the installed BLACKICE app nor main was modified. The local user source and full model outputs remain in untracked local receipts, not in this committed report.

Source fidelity refinement: the compact prompt now reads the original page strings from the verified attachment record, checks each page against its source hash, and preserves line breaks and blank lines rather than concatenating inspection units. The expanded suite passed 147 tests after the change. This is exact-text transport verification, not semantic verification.

## Instruction-layer and counterfactual controls

The actual compact prompt was reconstructed directly from the isolated source-analysis entrypoint and tested with MiniCPM-V-4.7-1B-heretic-Q4_K_S on an isolated local llama.cpp server. Temperature was fixed at zero. The three conditions changed only instruction delivery:

| Condition | System instruction text | Additional method text | Latency | Observed behavior |
|---|---:|---:|---:|---|
| Minimal analytical authority | 119 characters | None | 27.2 s | Multiple source sections covered, but claimed self-reported work *validated* expertise |
| BLACKICE standard execution authority | 3,570 characters | None | 37.3 s | More verbose; conflated described architecture and team coordination with independently established engineering rigor |
| Standard authority plus structured-analysis method | 3,570 characters | 2,500 characters | 20.2 s | Shorter, but shifted to generic role fit and mistook problems investigated in an agent platform for evidence of candidate unreliability |

These are single-run deterministic-prompt observations, **not a statistically controlled estimate** of instruction-effect size. None supported the hypothesis that adding longer instructions or the selected structured-analysis skill, by itself, repairs the actual inferential failures. Method selection and prompt delivery remain distinct, inspectable facts.

A separate **six-pair / twelve-case synthetic counterfactual probe** used short text about who identified unsupported conclusions, whether a repository link appeared, whether all participants improved, whether a causal effect was established, personal implementation versus coordination, and line management versus review. The local MiniCPM model chose the evidence-consistent option in **all twelve** cases. This shows the model can resolve these *explicit, local distinctions*; it does not prove it can select the right questions or synthesize them over a longer document.

The same model then received **seven explicit source-specific checks on the original résumé**, once with relevant source excerpts preceding the proposed conclusion and once with the conclusion first. It answered **13/14** in the expected direction: **7/7 source-first**, **6/7 claim-first**. With the conclusion placed first, it incorrectly accepted that approximately 3,000 assessments had been independently certified accurate. This is a concrete anchoring failure despite successful local evidence interpretation under the opposite ordering.

Finally, a continuation test held the exact original résumé, previous answer, current user follow-up, selected model, system instructions and generation budget constant, and changed only the order of (a) the previous fallible answer and (b) the original source. Neither ordering produced a genuine substantive challenge. The replies repeated unsupported technical-leadership and capability claims. **Reordering the context alone is not a fix.**

A reusable local-only CLI benchmark is now included in `scripts/semantic-contrast-benchmark.mjs` with synthetic cases in `tests/semantic-contrast-fixtures.mjs`. It records decisions and explanations, detects incomplete observations, and explicitly labels results **diagnostic, not semantic verification**. To run it against an existing local server:

```
node scripts/semantic-contrast-benchmark.mjs --model MODEL_ID --url http://127.0.0.1:8080/v1 --output local-contrast-results.json
```

**Implication for development:** The current bottleneck is not simply tokenizer budget, refusal, skill-registration failures, or a complete inability to compare evidence. It includes **selecting salient inferential questions and holding the source above attractive prior conclusions during long-context synthesis**. A possible next experiment is model-generated answer candidates subjected to narrow, localized evidence questions *before* synthesis, but those checks should not automatically rewrite an answer or declare it verified until end-to-end source-fidelity tests demonstrate a real quality improvement. Do not silently substitute models or overwrite the user's selected provider.
