# BLACKICE 2.33.14: workspace navigation and restart recovery

## Changes

- **Workspace navigation:** Chat, Activity, Planning and Settings switch their visible content again. Shared navigation no longer depends on the retired Desktop preview mount. This fixes a reproduced case where clicks reached the interface but the selected workspace stayed on Chat.
- **History recovery:** An error while rendering a refreshed chat catalog releases pending refreshes and waiting actions. The interface reports the error through its recovery notice, and later refreshes can retry. A newer queued catalog update still runs after a failed render.
- **Interface diagnostics:** Desktop renderer unresponsive and recovered events are recorded as metadata. These events contain no conversation text or page contents.
- **Explicit forced restart:** The native command accepts `BLACKICE --restart --force --request-id=ID`. It pauses automatic queues, cancels cancellable work through its owners, waits for settlement and drains writes before relaunch. This includes saved direct actions waiting for input under another connection grant. It does not kill the process or bypass browser, private application session, storage, origin or acknowledgement checks. Queues remain paused if preparation fails.
- **Restart receipts:** Restart refusals identify the blocking category. The durable receipt records the force choice; retries must use the same request ID and force choice. An uncertain restart is inspected before another request is submitted.

## Verification and activation

The navigation issue was reproduced in the running desktop app, and the repaired interface was checked across the visible workspace tabs. Source regression checks cover navigation without the legacy Desktop mount, history render failures and retries, renderer recovery, and restart preparation. The matching Windows source receipt and exact installer evidence record the final release checks.

Native restart changes take effect in a new BLACKICE process after updating. Reloading the interface alone activates frontend changes but does not replace the running restart controller. A successful scheduling receipt does not establish that a restart completed; inspect the same receipt after reconnecting.
