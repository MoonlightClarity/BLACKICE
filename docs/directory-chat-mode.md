# Directory in Chat

**Directory Diagnostics** is an opt-in, local view of evidence retained for a selected Chat turn. It records which sources the host prepared, whether the adapter showed turn activity, which tools were attached or returned results, and the saved terminal state. A prepared source is not proof that the model used it. Prior contents of a resumed provider session are not visible from this receipt. When old events were never captured, pruned, or not retained in an archive, the view does not claim that nothing happened.

Directory Diagnostics stays with its own task, including later turns in that task; an independent task starts without it. It does not supply context, add a model call, restore the retired execution loop, or override Past Chats. Personal Context is a separate skill for deciding when historical information is relevant and when to verify against current evidence.

## Historical execution design (not current behavior)

> **Status: Historical engineering reference.** The execution runner below was retired. It is not activated by Directory Diagnostics. See the [documentation map](README.md).

Directory has two conversation settings: **On** and **Off**. On uses Directory for the next response without requiring a command prefix. Off uses ordinary Chat. The choice applies to subsequent work, and remains independent from the Subagents setting.

## Execute the requested work

Directory separates planning, execution, extraction and synthesis. A saved directory is the starting context for a phase; it does not limit the files, websites or authorized actions the worker may inspect or perform through its attached tools. Host execution instructions are separate from attributed source material.

A work result contains `status`, `nextAction`, `finding`, `candidate_answer` and `uncertainty`. The statuses are `complete`, `incomplete` and `blocked`. Incomplete work with an available next action continues within the same provider session before synthesis, preserving its tool history. Complete and blocked reports remain subject to the final outcome review. Repeated checkpoints without new observed work stop truthfully rather than claiming success.

Dependent work receives actual saved tool receipts, including their complete contents, in addition to model findings. Synthesis can inspect evidence but cannot repeat operational effects. A response-only correction repairs the report without replaying completed work. A model answer, a successful tool call, and completion of the user's outcome are distinct observations.

## Visible progress during a phase

Chat displays completed commentary whose public phase is explicitly identified by the native Codex adapter, without waiting for the whole Directory phase. Generic commentary labels from other adapters are not sufficient: some adapters relabel rejected final answers or incomplete JSON as commentary, so those remain suppressed. Unclassified text deltas, structured leaf answers, and reasoning records remain private; this does not fabricate narration when a provider emits none.

The host publishes metadata-only action-started, tool-returned, and outcome-unknown activity through the existing Chat event stream. The inline preview names the tool/action; Details retains bounded chronological activity. Arguments and raw results are not copied into this public projection. A tool reporting success is not proof that the user's task is complete. A transport exception is reported as unknown, not as a safely retryable failure. Existing saved receipts and no-replay behavior are unchanged.

This is an observability bridge, not the complete action-oriented Directory redesign. Durable semantic action records, within-phase context rollover, authority lineage, and independently verified effect outcomes remain separate work. Historical goals and deadlines in retrieved records remain source data, not current instructions.

## Current conversation by default

Saved Directory files belong to one conversation under `.shadowdancer/<conversationId>`. Its later runs share that conversation's current context. Automatic learning and memory-catalog admission also follow the conversation's run lineage; sharing a working folder does not import another conversation's notes. User profile settings and the currently authorized request remain available.

Other conversations are listed by metadata in the Context inspector. Selecting a conversation opens only that conversation's records. Nothing is imported merely by listing or inspecting another conversation.

## Inspect, edit, delete and import

The Context inspector is available from Chat and Planning. It groups conversation choices into the current conversation and other conversations, with Overview, Model turns, Context files and Changes views. Audit records and actual model phases have separate counters.

Select a record to edit its authored fields or its JSON content. Saved changes use the opened revision hash, so a stale editor cannot overwrite a newer value. Generated records can be corrected by the user; edited derived results are no longer represented as independently verified. Removing a record deletes it from active context and records the removal. Context changes do not undo external effects or authorize repeating them.

To use another conversation's context, select its record and choose **Import into current conversation**. The destination remains the conversation in which the inspector was opened. Import copies exactly the selected source revision and records its conversation, file and hash. Later edits or deletion affect the copied record, leaving the source conversation unchanged. Repeating the same import does not create a duplicate.

User-managed revisions and explicit imports enter later Directory execution. Deletion markers prevent removed records from returning through a prior synthesized handoff. Runtime summary refreshes do not overwrite the user's saved corrections. The Changes view retains the history of these operations.

## Use the model's available context

Directory does not impose a fixed document, objective, result or context-record length. Each new phase starts with a fresh model context and reloads the complete records it needs. Full source documents, instructions, tool receipts, findings and final answers remain available; the application does not silently clip them to short excerpts.

When the runtime reports both a default window and a larger supported maximum, Directory selects the maximum unless the conversation has an explicit window setting. It accounts for the runtime's effective-window percentage, output space, instructions and tool definitions. It partitions source material or groups synthesis only when the complete phase would exceed that actual capacity. An unknown model window does not acquire a substitute 128,000-token ceiling. The provider enforces its actual capacity until metadata becomes available.

Long Directory messages are accepted through Chat, continuations and the direct connector. The inspector can edit full context documents. Tool and audit pagination affects how much is returned in one response; it does not discard the stored content or make later offsets inaccessible. Explicit user settings and real provider limits still apply.

## Verification

Tests cover actual work continuation, tool evidence preservation, unchanged-evidence stalls, current-conversation memory selection, explicit imports, edit/delete persistence, stale revision conflicts and UI conversation switching. Native rendered fixtures and live model acceptance are reported separately from deterministic source tests. No synthetic test establishes real employer submission counts or general job-search throughput.
