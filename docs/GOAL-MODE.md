# Goal mode

Goal mode gives one BLACKICE conversation a saved objective and keeps it moving through successive agent turns. Each continuation stays in the same task and conversation, with its saved history, model, working context, and accepted user directions. An ordinary assistant reply is a checkpoint; the goal remains open until completion is recorded or continuation is stopped.

BLACKICE must be running and the Windows host must be awake for work or timed waits to advance. Closing a chat view does not pause its goal. Goal mode does not launch a closed app or replace Cronjobs for recurring schedules.

## Start and control a goal

Choose **Goal** beside the chat composer, enter the whole outcome you want, and choose **Start goal**. Include the deliverable, relevant constraints, and what would establish completion. This works for a new chat or an existing conversation.

Leave the optional turn limit empty for unlimited continuation. The goal card shows the objective, status, turn count, and latest checkpoint. Use **Edit** to revise the objective or limit; editing a paused goal keeps it paused until you choose **Resume**. Send an ordinary chat message to steer the current work. Accepted user input takes priority over a pending automatic continuation and invalidates earlier completion evidence.

| Control | Effect |
| --- | --- |
| **Pause** | Pauses current execution and automatic continuation. BLACKICE interrupts the active provider/Directory worker and shows Pausing until dispatched work settles. Saved progress, pages, and uncertain-effect receipts remain. |
| **Resume** | Reactivates a paused, interrupted, blocked, or budget-exhausted goal and starts a fresh turn allowance. |
| **Stop** | Cancels the current run. Its goal becomes paused, so cancellation does not immediately launch another turn. **Stop all** also pauses enabled goals. |
| **Clear** | Removes the saved goal and prevents further automatic continuation. It does not cancel an already-running turn or delete conversation history. Use **Stop** as well if that turn must stop. |

Eligible agent-owned browser pages are retained between goal turns and while paused. Completion and Clear apply the normal browser ownership cleanup rules after active work settles.

### Slash commands

These commands are handled by BLACKICE Chat:

| Command | Action |
| --- | --- |
| `/goal <objective>` | Set a new goal, replacing any previous goal and starting a new allowance. |
| `/goal`, `/goal status`, `/goal show` | Show the saved goal and current status. |
| `/goal pause` | Pause current execution and automatic continuation. |
| `/goal resume` | Resume with a fresh allowance. `continue` and `unpause` are aliases. |
| `/goal clear` | Remove the goal. |
| `/goal -- <objective>` | Set literal objective text, including text that would otherwise be a control word. |

Use **Edit** to modify the existing goal without replacing it. The optional turn limit is available in the Goal editor.

## Turn allowance

The default is **unlimited**: no turn cap is added unless you specify one. `maxTurns` is a positive integer, or `null` for unlimited.

A turn is an admitted agent run, not an individual tool call or message. The initial goal run and later automatic or manual runs admitted while the goal is enabled count toward the current allowance. A turn already in progress when a goal is first attached is not retroactively counted.

BLACKICE checks the allowance before starting another automatic continuation. Reaching it shows **Turn limit reached** and preserves the goal; it does not abort a running turn. **Resume** resets the current allowance counter to zero while retaining the objective, progress, and cumulative turn count. For example, resuming a goal with `maxTurns: 5` permits another allowance of five goal turns.

Unlimited continuation can consume additional model tokens or provider charges. Existing model settings, tool permissions, and execution limits still apply.

## Completion, waits, and recovery

The agent uses its `relay_goal` tool to record progress, wait, or report completion. A completion report must contain a substantive summary and evidence. BLACKICE binds that report and captured recent tool receipts to the current goal, accepted directions, and run, then marks the goal **Completed** only after that same run settles successfully. New user steering, goal changes, or subsequent ordinary tool operations invalidate an earlier completion candidate.

This is an evidence-bearing **model report**, not an independent verification model or judge. The tool receipts make the claim inspectable; they do not prove that every part of an objective was satisfied. Review the actual artifacts, checks, and observed outcomes. A normal final message alone does not complete a goal.

An agent can enter **Waiting** for an observed active BLACKICE run or a real future retry time. BLACKICE checks that dependency and resumes when it is ready, without spending model turns merely to poll. Temporary execution failures use delayed retries. Repeated identical failures or three consecutive turns without tool work or recorded progress can produce **Needs attention**; the saved goal remains available for adjustment and Resume.

Goals persist with conversation metadata. After an app restart, a goal at a clean, successfully settled boundary can recover and continue, including applying a saved valid completion report. For a goal still enabled at shutdown, an uncertain dispatch, unfinished/failed/cancelled run, or unavailable wait handle instead leaves it **Interrupted**. Choose **Resume** after reviewing its saved state. Resumption instructs the agent to inspect saved receipts and current effects before retrying; it does not blindly replay the interrupted turn.

## Direct tools

A configured direct connection can use the same goal service. These actions use the existing authorized connection. Setting or resuming an idle goal, or updating an enabled one, can start BLACKICE model work.

Use `blackice_goal` for an existing conversation:

```json
{
  "requestId": "goal-example-set-001",
  "conversationId": "saved_conversation_id",
  "action": "set",
  "objective": "Fix the reported bug, run the relevant checks, and summarize the verified result.",
  "maxTurns": null
}
```

Replace `saved_conversation_id` with the actual saved conversation ID. Supported actions are `get`, `set`, `update`, `pause`, `pause_after_turn`, `resume`, and `clear`. All require `requestId` and `conversationId`. Read with `get` before editing and pass the returned goal's `revision` as `expectedRevision` to reject stale changes. `update` preserves the current allowance and status; `set` replaces the goal. On `update`, omitting `maxTurns` preserves the existing limit; use `null` to remove it.

For a new conversation, pass `goal: {}` to `blackice_start_chat`:

```json
{
  "requestId": "goal-example-start-001",
  "message": "Fix the reported bug, run the relevant checks, and summarize the verified result.",
  "goal": {}
}
```

The `message` becomes the objective. An empty goal object means unlimited; use `"goal": {"maxTurns": 5}` for an explicit allowance. Supply a configured `model` ID when needed, or omit it to use BLACKICE's current default. Do not call Start Chat to resume an existing goal.

Use one stable `requestId` per logical action. Retry an uncertain request with identical arguments and the same ID on the same connection, then inspect its durable result before submitting replacement work. A successful direct job or returned run ID confirms **admission**, not completion of the goal. Inspect `blackice_get_job` for the action receipt, `blackice_get_run_result` for an individual run, and `blackice_goal` with `action: "get"` for current goal status.

## Design references

The design follows the persistent, conversation-scoped continuation pattern documented by [Codex Goals](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) and [Hermes persistent goals](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/goals.md). BLACKICE's controls and completion rules are described above; those upstream implementations have their own budgets and verification mechanisms.

### Pause receipt and recovery

`pause` records its exact target before interrupting it. Pass the observed `currentRunId` as `pauseRunId` to reject a changed target. `pauseRequest.status` is `pausing` until the run settles, then `paused`; Resume is unavailable during settlement. Pause is not proof of a completed checkpoint and cannot undo an external effect. Resume continues from saved state and must inspect uncertain receipts before any retry. Replaying the same control request never interrupts a later resumed turn. For an explicitly requested finish-current-turn policy, `pause_after_turn` prevents only the next automatic turn.
