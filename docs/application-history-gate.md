# Native Planning application-history gate

> **Status: Engineering reference.** This describes a source implementation or internal contract, **not a guarantee for every installed or published version**. Verify the relevant source revision and release notes before applying operational details. See [documentation map](README.md).

Native Planning now checks available local application history at browser admission, instead of relying on a model to search only its newest tracker. This is separate from outcome counting and from the opt-in PowerShell registry helper.

## Behavior

- The host obtains the current page URL/title and the inspected native POST control label. Ashby, Lever, Greenhouse, iCims and Workable requisition identities are recognized. Different requisition IDs remain different targets.
- Recognized application-submit labels (such as Submit Application) require the history check. Explicit intermediate labels such as Next, Continue, Save draft and Log in do not reserve an application. An ambiguous POST label on a recognized requisition page requires inspection rather than being silently treated as a final submission. Opaque input on that page also requires an inspected control.
- Ordinary observation, navigation, field typing and browser control remain available. Enter on a field is opaque because it may implicitly submit without identifying the default submitter; inspect and use the actual submit control instead. A prior application hold does not block reading its receipt.
- Every matching top-level workspace JSON, JSONL, CSV, Markdown and text source is checked, across all dates. Supported filenames contain job-search/jobsearch/job_search or application. CSV field names are case-insensitive. UTF-8 and BOM-marked UTF-16 are supported. Historical literal CRLF separators between JSONL objects are tolerated.
- Exact requisition history, available company/title records and matching narrative reports produce a review hold. They are imported reports, not new host-verified external confirmations. A different explicit requisition is not merged merely because its employer/title matches.
- Existing claims in .application-registry/claims.json remain respected. Source parse/read/size errors cannot produce a clear result.
- Immediately before browser input, the host repeats the check and durably reserves UNKNOWN under one shared lock for the canonical workspace and task-state profile. This prevents two native tasks or processes from reserving the same requisition. Payload edits, new task IDs, closed tabs and restart do not clear that reservation.
- Only a canonical host-observed confirmation/absence or verified non-dispatch settles a reservation. Cancellation, timeout, lost transport and absent email do not establish absence. Claims never expire automatically.

## Coverage and recovery limits

This is a bounded native Planning guard, not a lifetime-history guarantee. It does not cover legacy execution without the canonical Planning dispatcher, arbitrary outside tools, unknown ATS URLs, missing source files, a different workspace/profile, or posting identity lost when navigation reaches a form whose URL no longer identifies the requisition. Arbitrary prose, nested record conventions, aliases and multilingual submit labels are not universally understood. Review holds can require a targeted check of the original record.

Control labels classify the observed interaction; they do not prove what a website ultimately did. Existing native receipt validation remains the authority for actual outcomes. A successful click or local history check never counts as a successful application.

When a history source is damaged, preserve its original bytes and restore or repair its encoding/structure from the evidence. When a company/title record is ambiguous, inspect the original receipt and record its actual requisition identity. Do not delete history, change workspaces, or relabel an action merely to bypass a hold. Unresolved native attempts should be reconciled using the original task and matching destination evidence.

## Verification

Regression tests cover old and current ledgers, URL normalization, narrative records without URLs, CSV and Markdown outcomes, malformed sources, UTF-16, symlinks, distinct requisitions, independent-process races, abrupt process exit/restart, UNKNOWN persistence, host-only reconciliation, and intermediate controls. Native Planning tests verify both preflight and final-dispatch checks, implicit Enter protection, and non-dispatch recovery through the production browser normalizer for both actionDispatched and inputDispatched. These are synthetic tests, not live application submissions.
