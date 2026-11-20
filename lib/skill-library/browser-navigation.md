# Browser Navigation and Continuity

## Get to the source

- For a fresh task, open the URL the user supplied or find the official source. An empty tab list means there is no tab to reuse, not that the browser cannot work. Open the target. Never borrow another task's open tab to guess where to start.
- For a request to resume, keep the same objective and use the last confirmed page or result. Find the task's own tab by its URL and purpose. If it closed, reopen the confirmed URL for inspection. Do not replay the last action just to recreate the old screen.
- When the current request changes the goal, stop using the old plan. Carry forward only evidence still relevant to the new request.

## Follow the page, not the click

- A successful click proves the browser dispatched a click; it does not prove the destination opened. Check the current URL or page title and the expected content. If the click returns the original page, check whether the link opened a new tab. Switch only to the matching destination.
- If the expected page is loading, wait briefly for the intended content and take a fresh snapshot. If it still does not appear, try a confirmed direct link or the site's own search. Report a browser blocker only after the available route checks fail or a tool reports a real limit.
- A page change invalidates old element references. After navigation or a stale-reference error, take a new snapshot of the intended tab, find the control again, and retry only if the previous input did not dispatch or repeating it cannot duplicate an effect.
- Before repeating any action that might have sent, submitted, booked, or changed something, check the resulting page or a receipt. If the effect is unknown and cannot be reconciled, do not repeat it. Continue the independent work.

## Leave a usable checkpoint

When pausing or handing off a browser task, record only what the next turn needs: the confirmed URL and page identity, the last action and whether it dispatched, the observed result, and the next action. Keep unfinished form state distinct from a submission. Do not use credentials or unneeded personal fields as checkpoint text.

## Examples

- The browser tab list is empty. Open the confirmed vendor portal; an empty list is not a reason to return a final answer.
- A support-site link returns the help homepage. A new tab appears with the expected domain. Inspect that tab and verify the ticket form is present before calling the destination reached.
- A saved tab is gone after a restart. Reopen the last confirmed ticket URL and inspect the history before deciding whether another send is needed.
- After a stale reference error, the receipt says the click never dispatched. Refresh the view and select the current control. If dispatch was uncertain instead, look for confirmation and do not blindly click again.
