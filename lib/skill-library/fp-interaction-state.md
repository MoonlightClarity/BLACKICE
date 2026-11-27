# Model Observable Interaction States

Use this method when a flow appears usable in the happy path but becomes confusing during waiting, errors or retries. Treat each action as a state transition with observable evidence. Design the information the user needs to choose the next action.

## Primitives

A state describes what is true about the task, not merely which screen is visible. An action has preconditions and possible effects. The system's internal state and the user's belief about that state can diverge. Feedback should expose the distinctions that matter for the user's decision.

## Procedure

1. Define the task's initial, intermediate and completed states. Include states such as unsaved, pending, succeeded, failed and outcome unknown only where the underlying system actually distinguishes them.
2. For each user action, identify its preconditions, transition and possible failure outcomes. Distinguish an accepted request from a completed effect.
3. Specify observable feedback for each relevant transition: changed content, status text, focus behavior or another accessible signal.
4. Trace interruptions, delayed responses, duplicate activation and return visits. Determine what state survives and how the interface recovers it.
5. Make the next action appropriate to the observed state. A retry should not be presented as harmless when the earlier action may already have completed.
6. Inspect alternative input and output paths such as keyboard navigation and screen-reader announcements. Use the current applicable accessibility criteria for a real conformance assessment.
7. Exercise representative transitions with realistic data. Check that the displayed status corresponds to the underlying result and that errors preserve enough context to continue.

## Worked example

A form sends an order, but the network response is lost. The server may have accepted the order. Showing a generic failure and immediately offering the same submission can create a duplicate.

Model a pending or unresolved state backed by the order request identifier. The interface can query its status and then show either the confirmed order or a supported retry. A spinner alone does not communicate this distinction. The acceptance observation is that a repeated click or return visit resolves to one authoritative order and gives the user a clear next action.

## Output and check

Produce a state-transition table containing state, action, precondition, possible result, feedback and recovery. Verify both the task outcome and the user's ability to recognize it through the supported interface.

## Failure boundary

A front-end label cannot create backend guarantees. Do not claim exactly-once effects from disabled buttons alone. Accessibility checking must include actual behavior; visual inspection by itself cannot establish keyboard or assistive-technology support.

## Reference

[W3C: Understanding Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) explains programmatically available status feedback.
