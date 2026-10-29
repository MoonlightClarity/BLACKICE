# Native frontend development

`blackice_frontend` operates the actual BLACKICE desktop window and Electron main
process. It is registered by the desktop host through the existing direct
connector and uses the connection's `commands:run` authority. It adds no separate
confirmation prompt, method allowlist, or model worker.

## Actions

| Action | Result |
| --- | --- |
| `state` | Actual window and process identities, window geometry and zoom, process memory/CPU, event-loop measurements, and application process metrics. |
| `snapshot` | Current DOM text and controls with values, visibility, and rectangles. Text/control truncation is explicit; `snapshotOptions` changes the requested limits. |
| `screenshot` | A PNG captured from the actual desktop window, optionally restricted to `rect`. |
| `evaluate` | Arbitrary JavaScript through `Runtime.evaluate`, including asynchronous expressions and caller-supplied protocol options. |
| `cdp` | A raw DevTools Protocol `method` and `params`; frontend subtargets may include `sessionId`. |
| `events` | Buffered protocol events with cursor, explicit overflow counts, optional clearing, and caller-adjustable event/byte capacity. |

`target: "frontend"` selects the app renderer. `target: "main"` selects a native
Node inspector session in the actual Electron host process, not a helper process.
DOM snapshots and screenshots belong to the frontend. Raw protocol responses,
evaluation exceptions, and protocol errors retain their native details.

## Profiling a reported interaction

Use separate request IDs for each action. On either target, send
`Profiler.enable`, optionally `Profiler.setSamplingInterval`, and
`Profiler.start`. Interact with the real window, then send `Profiler.stop`.
Debugger sessions remain attached across calls, so start and stop address the same
process. Compare the process IDs in their receipts.

For example, the start call for the Electron host is:

```json
{
  "requestId": "frontend-investigation-main-start",
  "action": "cdp",
  "target": "main",
  "method": "Profiler.start",
  "params": {}
}
```

Use observed DOM controls and their rectangles for input. Raw input methods such
as `Input.dispatchMouseEvent` work on the frontend target. Keep the investigation
focused on the reported interaction; the resulting profile includes the tool's
own requests as well as application work.

## Durable results

The direct execution ledger owns action identity and recovery. Repeating the same
request ID with identical arguments retrieves the saved job instead of repeating
the native action. After a transport interruption, retrieve that job's result.

Small results and screenshots are returned inline. Results that exceed the
ledger's inline size are saved completely under the profile's
`frontend-development` directory. The durable receipt contains their absolute
path, SHA-256, byte count, format, and original success status. The JSON artifact
contains the complete original tool result, including original image data.
Oversized PNGs are also saved separately when possible. A profile returned by
`Profiler.stop` therefore remains recoverable without repeating the stop call.

Cancellation records whether dispatch occurred and whether native execution may
continue. Closing the controller releases only its own debugger sessions and
listeners; it does not close the app window.

## Local development transport

The desktop also exposes `POST /api/development/frontend` through its existing
authenticated local HTTP session. The body is the same tool argument object.
Read the returned job at `GET /api/development/frontend/jobs/:jobId`, with
`offset`, `limit`, and `includeImages` for result paging. Remote connector callers
use `blackice_frontend` and `blackice_get_job` with their existing grant.

## Focused verification

```text
node --test tests/desktop-frontend-devtools.test.mjs tests/frontend-devtools-tool.test.mjs tests/frontend-devtools-integration.test.mjs
node tests/desktop-frontend-native.mjs
```

The native acceptance test starts an isolated Electron fixture and checks actual
DOM evaluation, raw input, screenshots, event/error preservation, both process
profilers, and normal window closure. It does not attach to or terminate the live
BLACKICE instance.
