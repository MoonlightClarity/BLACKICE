# Browser Navigation and Continuity

Use when opening a page, following navigation, inspecting visual or embedded obstacles, recovering stale controls, resuming browser work, or reusing and closing completed task pages.

## Open and identify the page

For a fresh task, open the supplied URL or find the relevant source. An empty tab list means there is no tab to reuse; open the target. For a continuation, reuse the task's matching tab or reopen its last confirmed URL.

Before multi-step interaction, inspect the page and make a brief outline of its main sections, navigation, and relevant controls. Every mutating action may invalidate controls or change what becomes required; schedule dependent input as **observe → one mutation → observe its result → next dependent mutation**. Do not batch fills, clicks, selects or uploads on the same tab from one older snapshot, even when a form initially shows many fields. Parallelize only independent reads or work on different pages with independent preconditions. After a rejected stale input, refresh the observation and choose a current control rather than replaying remaining calls from that stale batch. After a mutation, copy the fresh `observationReceipt` returned by a successful same-tab snapshot, read, or screenshot into the next dependent input. Never guess or reuse the receipt, and do not issue that next input in the same speculative model batch as the observation. Refresh the page when access or loading is stuck, then inspect it again.

After navigation, check the current URL, title, and expected content. If a click leaves the original page unchanged, check whether the link opened a new tab and inspect that destination. Wait briefly for expected loading content, then use a confirmed direct link or the site's search if necessary.

## Inspect a visual or embedded obstacle

1. Inspect the intended tab without a text filter before concluding that content is absent. A provider name, iframe, or frame-local capture does not establish that a challenge is visible. Use a current screenshot to inspect visual content and the surrounding page.
2. If no obstacle is visible, continue the normal authorized workflow and observe its result; required UI may appear only after the surrounding action. If expected content is still loading, wait briefly and inspect again before choosing an input.
3. When a challenge or other visual control is visible, read its actual instructions and use the available native controls. Prefer current element refs. For a screenshot-based click, convert the image point to CSS coordinates using that screenshot's imageScale: x = imageX / imageScale.x and y = imageY / imageScale.y. Keep the same tab, URL and document identity. Do not assume image pixels equal CSS pixels or invent a drag capability.
4. Use a visible refresh or accessibility alternative when it addresses the observed problem. Re-inspect each new stage before acting; old coordinates or a previous challenge answer may no longer apply. Preserve filled work, and reconcile any uncertain submission before refreshing or retrying.
5. Verify the resulting page or record. Dismissing or completing an obstacle does not by itself complete the surrounding task. If this route remains blocked, record the exact observed limitation and continue independent authorized work.

## Recover from an input error

1. Read whether the tool sent the input.
2. If it was rejected before dispatch, take a fresh snapshot of the intended tab, find the control again, and retry with its current reference and required document identity.
3. If dispatch is unknown, inspect the page or destination record before repeating a send, submission, booking, or other change.
4. If one route fails, try another route that reaches the same requested page. Continue independent work while an uncertain effect is being checked.

A successful click establishes that input was sent. Verify the resulting page or record before claiming the task succeeded.

## Reuse and close completed task pages

1. Read tabs and record the baseline; track exact tab IDs opened by this task. Reuse the task's matching page when continuing work. Preserve personal/pre-existing pages and foreign pages.
2. Reuse or close completed owned pages incrementally as work progresses. Save their useful results first, then inspect for unfinished forms, pending effects, unresolved dialogs, running downloads and resumable work. Apply these checks before navigating a page to new work as well as before closing it. Keep anything still needed by the user or another task, including work awaiting input.
3. Keep `inUse` marks while pages are needed. Use `relay_browser` with `action:"tab_mark", inUse:false` only to release your own completed task mark; never clear a user or another task's mark.
4. Close the chosen task-created page with `relay_browser`, `action:"close", browser:"relay"` and its exact `tabId`. Await the native tool result, then call `action:"tabs"` to verify removal. After an uncertain close, inspect its receipt and current tabs before retrying; an already absent tab needs no new close.
5. Close a task-created folder only after verifying it is empty. Task settlement alone does not establish that a page is finished; preserve unfinished work for continuation.

## Preserve what lets the next step continue

Record the confirmed URL, last action, whether it dispatched, observed result, and next step when handing off or pausing. Keep a partly filled form distinct from a submitted one.

Example: a stale click receipt says “not dispatched.” Refresh the snapshot and select the current control. A timeout after Submit instead calls for checking the confirmation page or saved submission.
