# Representation behavior evaluation

This opt-in fixture tests observable choices and artifacts in fictional local tasks. It does not send applications, start a model, or assess private reasoning. Cases cover transferable experience, primary positioning versus past background, audience-appropriate artifact selection (including when depth is required), supported inference, an ordinary application agreement, an explicit firm limit, a directly requested negative answer, and a genuinely unavailable required fact. Version 2 adds the positioning and artifact-depth cases; prepare a fresh directory rather than reusing a version 1 fixture.

Prepare an unused directory:

```text
node scripts/representation-eval.mjs prepare --root PATH
```

For each baseline and candidate case, run the same `prompt.txt` in its own case directory using an explicitly selected model, effort, and planning mode. Use independent data directories or otherwise ensure that saved tasks and provider state cannot cross-contaminate conditions. Preserve raw run and tool traces. The user must explicitly choose to start real model runs; preparing and scoring never do so.

Place the actual `decision.json` and a `run.json` in each case directory. `run.json` records `runId`, `model`, `effort`, `planningMode` (`on` or `off`), `sourceFingerprint`, `status`, `settled`, `startedAt`, and `finishedAt`. Record the actual source/runtime identity and any intervention or reviewer/tool-call variant separately; an authored description is not proof that an instruction or tool was used. Use equal model, effort, planning mode and fixture inputs for comparisons and inspect actual tool calls and timing. A separate reviewer adds its own run, latency, and potential errors; keep its draft and final artifact distinct.

```text
node scripts/representation-eval.mjs score --root PATH
```

The scorer checks protected input hashes, output shape, expected action direction, completion metadata, timing and supplied matched conditions. For the constructed positioning and artifact-depth cases, it also checks the specified response labels and chosen artifact filenames. It preserves submitted artifacts and asks for semantic review of each answer. It cannot determine whether wording is accurate, persuasive, materially complete, or avoids an unasked weakness; nor can it verify supplied run provenance or establish causation. Review the saved receipts and raw outputs independently, include genuinely necessary negative answers and actual hard limits, and report sample sizes and inconclusive runs. A single outcome is not a reliability estimate. Use additional held-out scenarios before installing a mandatory checkpoint.
