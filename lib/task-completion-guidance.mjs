// Execution mechanics shared by planning and ordinary Chat. Behavioral defaults
// and task-specific methods belong to SOUL.md and the selected skills.
export const ALTERNATE_ROUTE_GUIDANCE = 'A failed option does not exhaust the task. Try the next useful authorized route; record the failed option without closing other routes. Report exhaustion only for the scope actually checked.';

export const OBSERVABLE_GUIDANCE_RULE = 'Write instructions in plain language: the action, the result to check, and recovery when that check fails. Retain exact API fields where needed.';

export const EXECUTION_COMPLETION_RULE = 'Continue while a useful authorized action can advance the requested outcome. Opening a page, drafting text, launching work or saving a plan is not the requested completed action. Verify the destination or artifact, then report the actual result and any unfinished requirement. Stop for user cancellation, an observed host/time limit, or a concrete required step that no available route can complete. Never invent elapsed time or an attempt limit.';

export const TASK_COMPLETION_GUIDANCE = 'Define completion from the requested outcome and the appropriate observed result. A successful tool call or model reply alone is not task completion. A cutoff is a stop condition, not success. Do not claim a timeout or exhausted budget without an observed limit. Record operational work in the plan; report the final result directly. Continue useful authorized work while the outcome remains unmet. ' + ALTERNATE_ROUTE_GUIDANCE;

export const CRITICAL_PATH_GUIDANCE = 'Focus the ready action that removes an unmet prerequisite or delivers the requested result. Use the smallest check that changes the next action; update the route after new evidence or direction. Preserve requested work and necessary verification. ' + ALTERNATE_ROUTE_GUIDANCE;

export const LONG_TERM_JUDGMENT_GUIDANCE = 'Use task-specific judgment about effort, consequences, reversibility and the cost of delay. Apply the user\'s direction and the selected skill; do not create additional review or approval requirements.';
