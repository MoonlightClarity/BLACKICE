# Cascade investigation: evidence and limits

The observed run used installed 2.39.94, not the unreleased recovery candidate. This document records investigation, not a claim of end-to-end recovery.

## Observed configuration and terminal state

Live reconciliation at approximately 04:23 UTC found run 152c6af5-994a-4c88-a939-ed92965a5588 running, settled=false, under the same task. It started at 04:08:53.712Z, after the original run failed. The direct BLACKICE status tool independently confirmed it. The investigator did not admit or resume it. Preserve this work: no restart or comparison admission while it remains active. Original-run failure is not the terminal state of the entire task.

Saved conversation 2299fc0e-9227-45c7-9ea9-ccd44fa2cf42 records failure and settled=true at 2026-11-15T04:08:21.212Z (11:08:21 PM Eastern), CODEX_TURN_FAILED, model context exhaustion. Planning mode was off. Saved ontology toggles enabled inference, decomposition and subagents; feasibility, branching, replanning, metacognition, anti_overalignment and verification were false. Enabled toggles do not prove each module executed. Do not describe this as an all-modules-on run.

Directory chose atomic=true and used the whole overnight request as both objective and completion criterion. One work phase contained 118 checkpoints and 1,683 saved tool receipts. Incomplete checkpoints continued that provider session. No work-result/integration result was saved. Ordinary interruption task state had no completed steps or next steps despite substantial Directory checkpoint evidence.

Dylan reports 3,920 model turns, 1,928 inspections and eleven native compactions. These are not independently reconciled with Directory file counts. The saved conversation reports 10,005 omitted events. The retained 03:11–04:08 trace cannot establish the distribution of the full run. Usage aggregates also need reconciliation: saved totalTokens differs from inputTokens plus outputTokens, only two aggregate samples are recorded, and final last usage is zero. Do not treat these fields as a reliable context-growth curve.

## Sequence supported by available evidence

The completed audit identified invalid guarded navigation/stale-control failures followed by uncertainty restrictions and displaced prepared work. The retained late window contains exact repeated snapshot-result hashes, including seven identical snapshots near 03:23 and four Epoch snapshots at 03:44:25–58, as independently reported by the read-only reviewer. Epoch upload at 03:43:59 and later fill/select/click near 03:45 demonstrate intervening productive work. Neither repeated document identity nor a snapshot count alone establishes waste. Abandonment requires identifying the branch, blocker, remaining prerequisites, switch and any later return.

The ICF employer receipt corroborates one submission. Its click is outside retained event evidence; no attribution to a particular click or to candidate fixes is established. Existing applications must be reconciled before any new real action.

## Implemented Directory boundaries

Further retained evidence independently corroborates eleven compactions: directory.context.summary lists eleven IDs and timestamps from 01:18:16 to 04:01:54 UTC, all in work phase t0005. It reports 1,693 measurement updates, peak input 844,971 at 01:27:11 against a reported model window of 828,400, and configured input budget 812,016. These are provider-derived measurements, not proof of exact effective capacity or why later compaction failed. They are stronger context evidence than the conversation usage aggregate.

An exact late sequence illustrates the interaction without proving causation: at 03:23:06 a fill failed with BROWSER_ELEMENT_ACTION_FAILED and unknown-effect guidance; seven byte-identical snapshot result hashes followed through 03:25:30. Intervening actions included a screenshot, a snapshot using a malformed tab ID (known-not-dispatched), a successful press, read, scroll and another screenshot. Thus this was not seven consecutive identical calls, and some reads followed input. The question is whether those actions resolved a prerequisite or yielded useful new evidence, not whether a repeated hash should automatically suppress a call.

lib/shadowdancer-directory.mjs starts a fresh provider session per infer phase. It packs evidence before the phase, reserves context capacity for saved-evidence reads, but operational receipts only increment the context estimate. Incomplete work checkpoints explicitly continue the same session. Stall detection compares the set of hashes of arguments and receipts at incomplete checkpoints: novel observations can therefore prevent a stall without establishing useful task progress. Native compactions are recorded elsewhere but do not themselves rotate this work phase. The proposed action-based/semantic Directory is not implemented.

## Causal hypotheses to test

Counterexample to a uniformly stuck loop: independently re-read retained events show Epoch upload succeeded at 03:43:59, followed by read and four identical snapshots, then nine successful fill/select/click calls between 03:45:31 and 03:45:36 and a snapshot at 03:45:43. Navigation to a different target followed at 03:45:58. This demonstrates resumed tool activity after repetition; tool success alone does not prove correct form state or completion. The reason for the subsequent target switch and eventual branch disposition still requires checkpoint/receipt alignment.

Predispatch errors mislabeled as uncertain effects may increase recovery inspection. Conservative interpretation of missing evidence may park otherwise viable work. A whole-night atomic package may retain many such exchanges in one session. Receipt novelty may conceal weak progress, while incomplete recovery state makes interruption costly. These mechanisms plausibly amplify each other; the present chronology does not prove their relative contributions or that Directory caused exhaustion.

## Intervention status

Candidate recovery changes use host-proven dispatch boundaries, retain genuine unknown effects, persist single-use deliberate retry decisions and remove the intrusive UI. A deliberate retry remains a model risk judgment, never proof of no external effect. Latest focused source tests: 307 passed, zero failed/skipped; this does not validate installed workflow performance. Initial frozen-source Windows verification remains in flight and does not cover later source changes. No release or installed upgrade is claimed here.

Update: initial Windows workflow 43675260212 terminated cancelled at its 30-minute job limit. No terminal suite counts were produced; partial evidence artifact 14146554935 was uploaded. This is not a passing full-suite receipt. See windows-initial-attempt-2.39.95.json. It also predates the phase-proof follow-up. No release is justified by this attempt.

Next controlled comparisons are specified in skills-directory-experiment-plan.md. Browser/recovery, sparse guidance and current Directory are isolated before combinations. Future bounded-session rotation must preserve authoritative constraints, exact receipt references, completed and unknown effects, active branches and next actions. Observation summarization must retain actionable state and exact originals. Progress heuristics must allow legitimate verification and delayed transitions. These changes are proposals pending implementation and controlled evidence, not features already present.
