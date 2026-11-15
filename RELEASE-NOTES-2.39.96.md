# BLACKICE 2.39.96 candidate

A fill can focus a field before the page retires its observed reference. A later stale-reference rejection now preserves uncertainty about those earlier focus-handler effects. Host-proven rejection before focus still retains its not-dispatched classification. This change does not clear prior receipts or automatically replay an action.

A matched disposable native Chromium test reproduced the incorrect whole-action not-dispatched claim on the 2.39.95 runtime and passed after this correction. The synthetic focus handler removed its target; the corrected run verified the removal, preserved the original field value, inserted no replacement text and closed its windows. Each native run also exercised live/offscreen contained input. Local focused checks passed 42 tests with one opt-in native test skipped; the native tests were exercised separately on Windows CI.

The native fixture was corrected to trigger focus redirection at actual select preparation rather than expecting a retired select-all keystroke. It accepts either relevant stale-state rejection only while independently checking navigation, unchanged field value and preservation of prior-effect uncertainty.

These results establish this browser boundary, not whole-workflow efficiency. The action-based Directory experiment remains separate. Full exact-source and installer checks are release gates; this candidate is not an installed-runtime, live-model or whole-startup claim.
