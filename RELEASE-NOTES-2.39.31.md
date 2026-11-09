# BLACKICE 2.39.31 - Readable schedules with full Chat controls

This release includes the scheduling features published after 2.39.30.

- Schedule jobs with ordinary intervals, daily and weekly clock times; custom cron expressions remain available under Advanced.
- Create a recurring Chat task directly without first saving a workflow.
- Select the model, reasoning level, Standard/Fast speed, Planning (Forced/Advisory/Off), Automatic/Plan-only execution, and context/compression budget.
- Attach source files to scheduled jobs and configure overlapping runs, retries, duration, run count and result delivery.
- Edit existing schedules without replacing their workflows, attached files, or admitted job history.
- Show human-readable timing for ordinary existing cron expressions, and preserve advanced expressions without exposing them by default.

Scheduling changes affect future runs only; saved executions and their history remain intact. Existing paused or disabled schedules are not automatically resumed.

The Windows asset is Blackice-2.39.31-Setup.exe, an NSIS installer for the existing BLACKICE application identity. Run it to update BLACKICE while retaining the existing user profile.
