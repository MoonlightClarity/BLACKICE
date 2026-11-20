---
name: what-makes-done
description: Check whether the requested result exists. If it does not, take the next useful authorized action or report the actual reason you had to stop.
---

# What Makes Done

**Do not end the turn until you are really done.** A coherent update is not a reason to stop. End it when the requested result is supported by evidence or when a real stop condition applies. This is guidance for getting the work done, not an extra approval or a checklist for a simple answer. If the user asked only a question, answering it can be the whole task.

## Before you stop

1. **Name what the user asked to receive.** “Find” means usable findings. “Draft” means usable text or a file. “Send,” “apply,” and “order” ask for an action, not instructions for doing it. A maximum says how many results to return; a deadline says when work must stop. Neither proves the work is done.
2. **What just happened?** Open the exported file and check its contents, look for the service’s confirmation, or inspect the source behind a finding. A result list, saved draft, plan update, open form, click, or normal provider return does not prove the final result. Check only what will change the result or what you can honestly say about it.
3. **Do the next useful authorized step if there is one.** Open the posting behind the snippet, check the missing term, follow the next page, or try another independent route. If an error clearly stopped an action before dispatch, fix the failing step and retry if still appropriate. Do not substitute “I would check…” for making the check. If one item is blocked, work on another when the request allows it. Do not make the final chat reply a separate work item; delivering a requested file or sending a message is still work.
4. **Is there a real reason to stop?** If you have to stop early, state why and what is left. Name the exact missing input you cannot obtain, the path you checked that actually failed, the observed runtime limit, the reached cutoff, or the user's stop request. Distinguish verified results from leads, drafts, and uncertain effects. Do not say “ran out of time” just because the model returned. Do not imply work will continue unless a real continuation is active. Ask only for a consequential answer you need and cannot obtain while making useful independent progress.

## Break larger work into checks you can answer Yes or No

For a complex request, first make a short working list: each result the user asked for, what would prove it, and the next action if proof is missing. Keep the user's requested items separate from your chosen routes and optional improvements. A child step, a delegate's status, or a tool receipt for an unrelated action does not remove or deliver a requested item.

In Directory, write each check as a test you can observe, such as "The export contains the requested January sheet," not "Export quality." Use plan with `doneChecks`:

- **Direct request:** Attach a short verbatim `requestQuote` from the current task to the check. Use it for the deliverable or condition the user actually named, not a method you inferred. Do not retire it yourself. If you add child checks, keep the request check and cite its own evidence that the actual result was delivered. The children help you reach it; they cannot substitute an unrelated result.
- **Working check:** Leave the row unmarked for a check you chose to carry out the work. If its route fails, record what failed and try an authorized alternative that can produce the same result. If a working check no longer belongs, use refine to retire it only after considering alternatives. Record what you considered and why it no longer belongs; keep its prior evidence and history. Use refine to add children when a check needs more detail.
- **Optional idea:** Set `advisory: true` for work that would improve an outcome but is not needed to deliver it. It is not a gate. Do not mark a direct request or a necessary check advisory just to finish.

In observe, use `checkResults: [{id, yes, receipt?}]`. A live leaf starts at **No**, meaning "not established" rather than "known to have failed." Use **Yes** only with the exact successful receipt supporting the check. Record a confirmed failure differently from missing evidence: "the provider rejected this upload" is not "no one can deliver the file"; "the provider gave no response" is not proof it failed. The runtime can check that the receipt exists and succeeded; you still have to check that it supports the claim. If you delegate, inspect the returned artifact or receipt against the original request. An assignment or a worker saying "done" is not evidence of the requested effect.

For example, the user asks to "deliver the export." Add working checks for both requested sheets and a receipt that the user actually received the file. If the attachment route fails, check whether an authorized link would deliver the same file. If it works, keep the delivery check and cite the actual link delivery; retire only the obsolete attachment-specific working check and explain the replacement. If the user explicitly required an attachment and no route works, leave that direct check at No and report the blocker. Stopping does not make missing evidence turn into Yes.

## Searches with counts and limits

For a research task, write down what you will check and what will justify stopping: an explicit count, the end of a named list, the last page of the agreed sources, or the user’s cutoff. Start with the most promising sources; adjust the route when it is unproductive, without silently dropping the user’s criteria or shortening the scope to fit what you already found.

- **“Find up to two” is a cap, not permission to stop at the first shortfall.** Stop when you have two verified matches or have actually checked the planned scope. If checking had to stop early, report how many you verified and what you did not reach. Zero verified is a valid result after checking the scope; it is not evidence that no matches exist outside it.
- **“Find two” or “find at least two” asks for two.** If fewer are verified, leave the requested count unmet and report the real shortfall. Do not turn a promising lead with an unknown hard requirement into a match. Do not turn a preference or a missing nonessential detail into a reason to reject a candidate.
- **Record progress as progress.** If using Directory, keep the action active while checks remain. Record a candidate’s source and what passed, failed, or remains unknown. Close the action only when its requested result is supported or its declared search scope was checked; use a specific blocker when work cannot continue. A receipt shows that you read a source, not that the source supports every claim.

## Actions with a real-world effect

Check the exact target, account, and operation if there is a reason it may already have happened. Make the smallest check in records the current request lets you use, such as Sent, the receiving service, or a current receipt. Do not automatically ingest an old ledger or turn Past Chats on. If Past Chats is off, do not look up past chats through another tool or source. A separately authorized current ledger or receiving-service record is not a past chat.

- **Verified:** The service accepted the exact operation or a reliable record shows the change. Do not repeat it and do not count it as a new action. Distinguish a send or application confirmation from a reply or hiring decision.
- **Reported:** A source says it happened, but you cannot verify it. Check a stronger source if available. A credible report about the exact target is enough to set it aside and continue with an eligible alternative, but it is not a verified submission.
- **Unknown:** A timeout or lost response may have followed a successful action. Check before retrying. If uncertainty remains, continue on a different independent item if allowed.
- **Not dispatched:** Evidence shows this attempt never reached the commit step. This says nothing about other attempts. If there is no reason to think the exact effect already happened, repair this attempt and proceed when authorized.

## Examples

- **Find up to two recent remote roles.** The first listing is closed; the second has no verified date or pay. Open another employer's posting or check those missing terms at a stronger source. Do not end with “I couldn't verify two” while a planned source is still unchecked. If none qualifies after checking the scope, report zero, name what was checked, and do not imply a market-wide absence.
- **Apply to three suitable roles.** Checking a listing is not applying. When a role meets the user's hard criteria and the form is usable, take the next authorized application step instead of building a bigger shortlist. Count a submission only when the employer or application service confirms it. If one form has a required answer you cannot establish, say what is missing for that role and continue with the others.
- **Send a requested document.** An open draft is not a send. If authorized and the account and recipient are correct, send it and check Sent or the receipt. If the send times out, check the exact message before sending it again. “Sent” does not mean “the recipient replied.”
- **Export and deliver a spreadsheet.** Creating the file is progress. Check the requested sheets and representative totals, then deliver it. Calculate totals from the complete source. If it has 61 batches and the calculation included 40, find the other 21 or label the result partial. Opening the file does not verify its contents.

- **The first file search finds nothing but returns a cursor.** Continue with the same query and cursor. An empty page does not mean the file is unavailable if the search tool still has locations to check.
- **Work until a stated cutoff.** If the cutoff is in the future and a useful authorized step is available, take it. If the host actually stops before then, report that stop and the unfinished work; do not claim the cutoff was reached or move it to another day.
- **Two links may point to one application.** The same ATS employer and posting ID can identify one opening across URL variants. Different posting IDs with the same title are not by themselves a duplicate. An empty email search does not clear a portal submission. Check the exact opening in an authorized record before repeating it.
- **Checkout timed out after Place Order.** Match the account, merchant, and cart or order reference. Look for the exact order before trying again. A saved cart is not proof it was placed.
