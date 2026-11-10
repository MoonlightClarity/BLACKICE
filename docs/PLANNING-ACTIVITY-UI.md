# Planning activity and workspace review

## Behavior
- Saved is the unarchived conversation collection. Running now includes only recorded running executions, not saved lifecycle, assignments, readiness, queued work, or stopping work.
- Conversation activity comes from the current conversation status and the planning request's running-attempt projection. Detailed requests use the latest attempt per module.
- Idle, Queued, Stopping, and Needs attention are separate labels. An unavailable catalog does not report that nothing is running.
- The read-only catalog now preserves conversation status and settled fields. No execution, scheduling, validation, cancellation, or persistence behavior changed.

## Workspace
- Compact sidebar and activity badges, a visible running count, readable stage navigation, focused module inspection, and a collapsed outcome brief reduce repeated material.
- New request sits beside Conversations. A single request no longer reserves an empty request-picker toolbar.
- Full titles, evidence, provenance, editors, and model controls remain available. Opening, filtering, and navigating remain read-only.

## Verification
- 98 focused tests pass across the planning browser UI, HTTP adapter, graph model, canonical Plan editor, and workflow ownership.
- Headless Edge uses a disposable profile and synthetic data. Widths 1440, 1024, 390 and 320 pass page-overflow checks. Running-to-idle transitions, Outline/Graph/XML navigation and Cancel pass with zero mutation requests and zero page exceptions.
- Run: node tests/planning-activity-headless.mjs
- Captures and the machine-readable report are written to verification/planning-ui/. The test never opens the user's profile or contacts a model.
- Real installed app captured before changes. Candidate screenshots inspected for desktop and mobile layout. This is not a full accessibility certification or a claim about every Windows DPI/input combination.
- Full repository regression and installed-app activation remain integration steps.
