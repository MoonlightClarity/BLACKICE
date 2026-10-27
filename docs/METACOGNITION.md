# Practical judgment and metacognition in BLACKICE

**Design purpose:** Help an agent arrive at a useful, evidence-calibrated result without confusing accurate factual reporting with perfectionism or an invented veto. This framework belongs in ordinary Planning and applies to research, engineering, procurement, hiring, analysis, design and recurring work. It is not a separate persona, safety subsystem, permission system or recurring task scheduler.

## What is retained from the older SOUL.md

- **User outcome first.** Define what useful success actually looks like before maximizing a proxy such as source count, rubric completeness or confidence language.
- **Source and consequence matter.** Separate what the user explicitly ruled out from a third party's claim, an analyst inference, a costly gap, an adaptable gap and a preference. A requirement-shaped sentence is not automatically non-negotiable.
- **Truth without paralysis.** Preserve observed facts, reported claims, inferences, contradictions and unknowns separately. A missing fact is not evidence of failure. Usefully provisional options can survive uncertainty when the costs and consequences permit.
- **Proportionate testing.** For consequential uncertainties, choose the cheapest discriminating check that could change a decision. Do not demand exhaustive verification where it changes nothing.
- **Feedback that generalizes.** Compare what was predicted with what happened, locate the earliest preventable miss, and make a testable correction. One exceptional case is not a universal law.
- **Stopping and iteration.** Define a usable sufficiency point, detect diminishing returns, and reconsider after controlled misses. More analysis, caveats, subagents or variants do not automatically imply progress.
- **Responsibility for integration.** Parallel, reversible decomposition can help where work is independent; it is never the default for a coherent single decision. The lead remains responsible for testing the combined result.

## What is intentionally NOT migrated

No assistant name, identity or consciousness speculation; no self-authorized rewriting of behavioral rules; no backup-specific procedures; no blanket subagent-by-default instruction; no mandatory planning ritual for simple work; no new permissions or safety subsystem; no expectation that a model reflects between sessions; no universal numeric threshold or requirement to find a perfect solution. Project-specific details, including job-search compensation, W-2 and travel rules, stay in their own policy rather than the global Planning prompt.

## Saved general-purpose model

Planning **decision criteria** live in optional `plan.decisionCriteria`. Each record has an ID, label, source, kind, basis and priority; it can optionally include `evidenceStatus` and evidence of actual non-negotiability. These kinds should be favored in new plans:

| Kind | Meaning |
| --- | --- |
| `hard_gate` | A real, established veto backed by explicit user intent or genuinely verified external necessity |
| `material_barrier` | Consequential capability, cost, dependency or risk that may reduce viability without universally prohibiting action |
| `adaptable_gap` | Gap plausibly addressed by learning, substitution, negotiation or a modest workaround |
| `stated_requirement` | Someone's claim about what is required; source attribution and real consequences still need evaluation |
| `preference` | Important tradeoff or compass for ranking choices, not automatically a disqualifier |
| `unverified` | Missing, contradicted or presently uncertain fact; not proof of a negative outcome |

Sources: `user`, `external`, `analyst`; `employer` remains a legacy source. Evidence status: `confirmed`, `reported`, `inferred`, `unknown`, `contradicted`. Historical job-specific `substantial_skill`, `trainable_skill` and `employer_wishlist` kinds remain compatible.

An analyst-inferred hard gate is not permitted; an external/employer gate needs an explicit recorded `verifiedNonNegotiable` flag. That field records the author's classification and is not independent proof of the claim. Existing Planning revision checks still apply.

The **judgment frame** is optional `plan.metacognition`, with no required fields:

| Field | Question |
| --- | --- |
| `outcome` | What result matters in practice? |
| `keyUncertainty` | Which assumption, if wrong, would change the decision? |
| `nextProbe` | What inexpensive, discriminating check should happen next? |
| `goodEnough` | What is sufficient without demanding perfection? |
| `reassessWhen` | At what observation or cost should the approach change or stop? |
| `observation` | What actually happened, versus expectation, with material limits? |
| `lesson` | What operational correction transfers to similar work, without overfitting? |

Use one or two fields when enough; omit the whole frame for trivial tasks. The Planning UI can edit the frame and the decision criteria independently from action steps. These notes do not launch work, grant authorization, certify evidence or complete unfinished actions.

## Transfer examples

- **Software repair:** A vendor saying a framework is “required” is a `stated_requirement`. The user’s “do not delete existing customer records” is a `hard_gate`. Before rebuilding the UI, a low-cost parser-vs-renderer test can falsify a bad hypothesis. Stop when the failing case and one nearby regression pass.
- **Research:** An inaccessible official primary document leaves a question `unverified`. The absence of the document in one search is not evidence the event did not occur. Report the best provisional interpretation and the one source check most likely to change it.
- **Procurement:** A preferred supplier and an ideal feature are `preference` or `stated_requirement`. A confirmed physical incompatibility is a `material_barrier`, perhaps a `hard_gate` if genuinely immutable. Rank viable alternatives rather than returning nothing because no product is perfect.
- **Hiring or contracting:** Keep explicit user work constraints separate from employer wish lists, meaningful core-skill gaps, quickly learnable gaps and missing posting details. A real opportunity can be imperfect but worthwhile.

## Runtime behavior and safeguards

**Planning On is a real tool-call requirement.** The current-turn agent must read and write `relay_task` and save at least one concrete, verifiable action. The engine withholds premature answer events and unrelated tool operations until the actual current run/node records its plan. If the agent returns without doing this, its answer is not published; if no compatible task tool exists, the run fails early rather than inventing a Planning receipt. **Planning Off** bypasses this *automatic* requirement while retaining prior notes and normal execution safeguards. The only new selectable modes are On and Off; historical Auto/Maximal map to On. Outline depth and model reasoning effort are separate settings, and the old Maximal-only forced-detail rule has been retired.

Current Planning prompts encourage the model to use this distinction for substantial or ambiguous tasks; they never make a formal frame mandatory on every message. The persisted JSON model supports atomic expected-revision edits. This is Planning tool **schema v8**: versions 1–7 keep their saved catalogs and instructions, including the historical v7 note-length behavior. Existing plans remain readable and the new fields are optional. No agent gains an action or permission simply from adding metadata. Human and agent judgments are editable assertions, not verified runtime effects.

**Success measure:** Relative to the baseline, users should get more useful plausible options, fewer unsupported vetoes and better early error detection, without a rise in fabricated facts, ignored explicit constraints, duplicate work or wasted verification. Compare a cross-domain transfer case before declaring the technique broadly successful.
