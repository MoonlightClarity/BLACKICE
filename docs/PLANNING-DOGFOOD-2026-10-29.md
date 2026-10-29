# Planning dogfood observations — October 29, 2026

This public summary records what the planning trials established and where they fell short. It uses synthetic task descriptions and aggregate findings. Private installation receipts, machine paths, connection identifiers, raw API transcripts and provider reasoning are excluded.

The trials evaluated three separate properties: whether the model authored a sufficiently detailed plan, whether the runtime preserved chronological and conditional execution, and whether the interface represented that saved work accurately. A correct final answer by itself did not count as a complete planning pass.

## Schema 9: structured selection and revisiting

Five live trials used the same small release-selection policy. They were local synthetic exercises: no release was published and no network action was part of the model's task.

The policy preferred a primary candidate when its signature was verified, it was not revoked, and either its full tests or its canary check passed. Otherwise it selected a verified, unrevoked fallback whose version appeared in the permitted list; otherwise it recorded a hold. The task first used cached observations and then reconciled an authoritative refresh. Candidate files and catalogs were checked for unintended changes.

| Trial | Task shape | Observed planning behavior | Assessment |
| --- | --- | --- | --- |
| 1 | Original task | Produced the correct primary-to-fallback result and followed the prospective, sequential operation protocol, but authored a flat plan without structured choices, facts or revisit. | Correct output; insufficient planning structure. |
| 2 | Same task after initial instruction refinement | Again produced the correct result with sequential operations, but the plan remained flat. | The first instruction change did not solve structured authoring. |
| 3 | Same task after clarification at the planning tool | Authored actual choice groups, selected `IF` for the cached primary and `ELIF` for the refreshed fallback, and expanded the plan as observations arrived. Compound conditions were collapsed into model-computed eligibility flags. | Partial pass: executable choices, but the saved expressions did not preserve the full policy. |
| 4 | Targeted same-decision revisit task; the refreshed data revoked both candidates | Saved nested `AND / OR / NOT` and membership comparisons over constituent observations. Returned to the same earlier choice, preserved its prior attempt, changed from primary to `ELSE` hold, and reassessed dependent work without replaying obsolete reads or writes. | Targeted functional pass for nested conditions, revisit, preserved attempts and effect handling. |
| 5 | Original task after constituent-fact guidance | Saved nested policy expressions over 16 constituent observations, selected primary from the cached input and fallback from the authoritative refresh, and completed the expected sequential operations with correct final output. | Pass for this ordinary task's structured authoring and execution. |

The original task wording was matched across trials 1, 2, 3 and 5 apart from each trial's folder. Trial 4 explicitly requested continued treatment of one live decision and used different authoritative data. Its revisit result therefore establishes that targeted behavior; it is not an unchanged-prompt comparison or a measure of how often a model chooses revisit without that direction.

All five final outputs were correct for their supplied data, and the four input files in each trial remained unchanged. Trials 3 and 5 each recovered from three rejected planning edits; trial 4 recovered from one. Those recoveries did not produce additional file operations or erase prior results. Trials 1 and 2 had no planning-edit errors but still failed the structural planning objective.

The final original-task trial retained separate truthful cached and current assessments. It did not exercise formal revisit. Other operators, deeper trees, different models and broader task distributions were not established by these live trials.

## Schema 10: the missing post-work planning return

Follow-up diagnosis found that the runtime's final-answer boundary required an initial plan but did not require a later reassessment. A real-engine test with a deterministic provider could publish a final answer while its reasoning leaf remained active. Merely marking that leaf done changed the plan revision and its presentation flag, but did not establish a return to planning.

Schema 10 adds a saved review after the actual outcome:

```text
plan → think or work → return to planning → think → respond
```

The work and review portions repeat when the result calls for another observation, a revised substep, or a return to an earlier decision. The review records a concise finding, the remaining work and the decision to continue, respond or report a real blocker. It does not record private reasoning.

### Self-contained workshop comparison

The next live task uses only supplied data. It asks for the cheapest bundle containing one software workshop and one hardware workshop, with a maximum price of $170 and no time overlap. One $10 enrollment fee applies to each bundle, and a $30 discount applies only to S2 + H2. Touching endpoints do not overlap.

| Workshop | Price | Time |
| --- | ---: | --- |
| S1 | $60 | 09:00–10:00 |
| S2 | $80 | 10:00–11:00 |
| H1 | $70 | 09:30–10:30 |
| H2 | $95 | 11:00–12:00 |

The expected result is **S2 + H2 for $155**. The other feasible pair, S1 + H2, costs $165. Both pairs containing H1 overlap. No files or browser actions are required to solve the task.

The first schema 10 workshop run saved a fresh final review for its current run. It also exposed a separate decomposition weakness: several material comparisons remained inside one oversized reasoning leaf. The instruction guidance was refined to require those distinct comparisons as substeps before attempting them. A second matching run is pending evaluation in this candidate record.

This distinguishes successful review delivery from successful decomposition. The first workshop run does not, by itself, establish the complete requested planning behavior.

## Runtime and presentation checks

Focused deterministic checks exercise the actual planning handler, state store and engine boundaries. They cover rejection of a premature review, the difference between completion and reassessment, review freshness after changed facts or direction, worker scope, honest blockers, unresolved operations, saved history and bounded storage. Provider-level checks exercise continuing an unpublished candidate within the accepted task and preserving actual tool results.

Presentation fixtures use synthetic public records and the production renderers. They check nested numbering, indentation, preserved alternatives, chronological plan and review entries, and reconstruction of public phases in reopened conversations. A rendered fixture verifies that presentation path; it is not evidence of hidden reasoning or a claim that every live desktop state has been exercised.

Final source-suite totals, final installer verification and the second workshop trial remain to be recorded for the release candidate. Historical focused checks must not be relabeled as verification of a later complete build.

## Interpretation limits

These are bounded observations from specific synthetic tasks and deterministic regressions. Structured validation and recorded reviews make the process inspectable; they do not prove the truth of every model inference, guarantee atomic decomposition for every request, or establish real-world success from a response ending. The [recursive planning guide](RECURSIVE-PLANNING.md) describes the implemented contracts and their limits.
