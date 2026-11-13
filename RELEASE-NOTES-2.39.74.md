# BLACKICE 2.39.74 — Persistent Goal mode

Goal mode keeps an objective active in a saved conversation and continues through the normal BLACKICE runner until the goal is completed, paused, or reaches a limit the user chose.

## Use it

Choose **Goal** beside the chat composer, or enter `/goal <objective>`. The goal card shows the objective, current state, turn count, and latest progress. Edit, Pause, Resume, and Clear operate on the same durable record.

Supported commands include `/goal`, `/goal status`, `/goal pause`, `/goal resume`, and `/goal clear`. Use `/goal -- <objective>` when an objective starts with a command word.

## Behavior

- Automatic turns stay in the same conversation and task, preserving the chosen model, planning settings, context, and resumable browser resources.
- There is no default turn limit. A selected limit counts turns while the goal is enabled; Resume renews that allowance while retaining total progress.
- User input takes priority over pending automatic continuation. Pause allows the current turn to finish; Stop cancels current work and pauses continuation.
- Completion is an explicit model report with evidence, committed only after its bound turn settles successfully. Edits or steering invalidate an outdated completion report.
- Observed waits and execution failures retain progress. Interrupted work is preserved for Resume; clean restart recovery reconciles the saved result before admitting another turn.
- Goal controls use revision checks and request receipts to avoid duplicate starts after uncertain transport results.

The connector exposes `blackice_goal` for existing conversations. `blackice_start_chat` can enable Goal mode atomically with `goal: {}`.

Conversation-scoped browser tabs and the prior combined Context and Storage fixes remain included. See [Goal mode](docs/GOAL-MODE.md) for the lifecycle, commands, API, and verification details.
