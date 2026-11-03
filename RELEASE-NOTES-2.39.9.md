# BLACKICE 2.39.9

## Scheduled task readiness

- Runs Inference before Feasibility when checking a schedule, so readiness uses the user’s intended outcome and the assigned workflow’s execution context.
- Updates legacy readiness prompts to distinguish the analysis worker’s tool limits from the scheduled workflow’s access and first-run checks.
- Preserves the existing hard gates for genuinely unresolved essential facts.
