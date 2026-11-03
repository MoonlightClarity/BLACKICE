# Guarded frontend UI controls

`blackice_frontend` retains all existing evaluate/CDP functionality and its existing `commands:run` authority. No permission, security setting, runtime installer, or restart behavior changes.

1. Request `action: snapshot`.
2. Select a control's `ref`; retain the snapshot's exact `documentId` and `url`.
3. Request `action: interact`, `operation: click|fill|press|scroll|drag`, `ref`, `expectedDocumentId`, and `expectedUrl`.
4. Inspect a new snapshot or screenshot to confirm the application's actual result. An input dispatch receipt is not a claim that a save, submit, or other application action succeeded.

Extra fields: fill takes ordinary `text`; press takes a navigation/editing `key` (Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, or a space); scroll takes pixel `deltaX`/`deltaY`; drag takes `destinationRef` from the same document snapshot. Fill selects existing text using native Ctrl+A and inserts replacement text; empty text clears it. Helpers use native CDP events. Fill first clicks its target. Press focuses without clicking, preserving an existing caret and avoiding a duplicate button activation. Both require the target to hold focus.

References belong to one document and expire on reload. The helper rejects detached, disabled/inert, hidden, offscreen, covered, moved, and stale-document targets. It rejects simultaneous helper gestures rather than interleaving them. Refresh the snapshot after layout/navigation changes. To reach offscreen controls, scroll a currently visible target first. The snapshot redacts password and one-time-code values and their matching text; fill refuses those targets. Never supply other secrets to generic text input.

Limits: top-document controls only; no shadow-root/iframe traversal, contenteditable fill, native OS menus, clipboard, or complete Windows desktop control. Raw CDP remains available for advanced authorized development. Application handlers, user input, or raw CDP can still change the UI between protocol commands; guards reduce races but do not make gestures atomic. Cancellation can leave already-dispatched effects; inspect the receipt and current UI before retrying. Pointer release on interrupted drag is best effort. A drag is a native pointer gesture, not a guaranteed HTML drag-and-drop data transfer.
