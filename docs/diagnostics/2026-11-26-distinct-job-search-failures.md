# BLACKICE distinct job-search failure audit — 2026-11-26

Read-only owner-local Receipts snapshot: 40 distinct groups, 79 reported failure occurrences. Structured failure history contains 61 recorded failures; 18 earlier event-only records have no safe saved failure code. The activity API also reported 9,320 retained events and 12,036 earlier event omissions. A group is not necessarily an independently proved software root cause.

Classifications separate reproducible defects, source recovery improvements, correct safety guards, and cases without enough historical evidence. Changing the error code does not prove application throughput improved.

| # | Distinct receipt category | Occurrences | Finding | Action/evidence |
| ---: | --- | ---: | --- | --- |
| 1 | relay_browser / fill · BROWSER_ELEMENT_ACTION_FAILED (3:28 PM ET) | 2 | Source improvement | Typed known field failures in [PR #40](https://github.com/MoonlightClarity/BLACKICE/pull/40); historical cause unknown. |
| 2 | relay_browser / select · BROWSER_ELEMENT_ACTION_FAILED (3:26 PM ET) | 1 | Source improvement | Native vs custom dropdown and unavailable option distinguished in [PR #39](https://github.com/MoonlightClarity/BLACKICE/pull/39); historical cause unknown. |
| 3 | relay_workspace / read · WORKSPACE_ERROR (3:06 PM ET) | 1 | Evidence insufficient | Older generic workspace read failure. [PR #32](https://github.com/MoonlightClarity/BLACKICE/pull/32) typed invalid paging fields, but original cause cannot be proved. |
| 4 | relay_browser / click · Unclassified (2:28 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 5 | relay_goal / progress · Unclassified (2:28 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 6 | relay_browser / click · Unclassified (2:24 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 7 | relay_browser / click · Unclassified (2:24 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 8 | relay_browser / snapshot · Unclassified (2:23 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 9 | relay_browser / read · Unclassified (2:20 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 10 | relay_browser / snapshot · Unclassified (2:20 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 11 | relay_browser / read · Unclassified (2:20 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 12 | relay_browser / select · Unclassified (2:20 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 13 | relay_browser / click · Unclassified (2:19 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 14 | relay_browser / click · Unclassified (2:19 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 15 | relay_browser / click · Unclassified (2:19 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 16 | relay_browser / navigate · Unclassified (2:18 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 17 | relay_browser / navigate · Unclassified (2:16 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 18 | relay_workspace / read · Unclassified (2:15 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 19 | relay_workspace / read · Unclassified (2:15 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 20 | relay_browser / click · Unclassified (1:39 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 21 | relay_workspace / stat · Unclassified (1:37 PM ET) | 1 | Legacy unclassified | The original code and action arguments were not preserved; no factual root-cause claim possible. |
| 22 | relay_browser / click · BROWSER_REF_STALE (3:46 PM ET) | 5 | Safety guard | Stale click with unconfirmed external effects. Preserve reconciliation; [PR #32](https://github.com/MoonlightClarity/BLACKICE/pull/32) improves no-input evidence. |
| 23 | relay_browser / click · BROWSER_TARGET_COVERED (3:31 PM ET) | 13 | Source improvement | Live Workday modal/backdrop blocked page controls. [PR #37](https://github.com/MoonlightClarity/BLACKICE/pull/37) emits safe blocker diagnostics; no bypass. |
| 24 | relay_browser / click · BROWSER_CAPTURE_TIMEOUT (3:31 PM ET) | 3 | Root-cause patch | Parked native view was waiting on throttled animation frames. [PR #35](https://github.com/MoonlightClarity/BLACKICE/pull/35) fixes capture path. |
| 25 | relay_browser / click · BROWSER_INPUT_DOCUMENT_CHANGED (3:14 PM ET) | 1 | Safety guard | A changing document interrupted click; original whole-action effects remain unknown. |
| 26 | relay_context_page / read · CONTEXT_ARCHIVE_INVALID (3:54 PM ET) | 1 | Validation / evidence needed | Context archive read rejected invalid input or reference; original arguments unavailable. |
| 27 | relay_browser / screenshot · BROWSER_CAPTURE_TIMEOUT (3:49 PM ET) | 7 | Root-cause patch | Same native capture timeout mechanism as #24, fixed in [PR #35](https://github.com/MoonlightClarity/BLACKICE/pull/35). |
| 28 | relay_credentials / generate · BROWSER_CREDENTIAL_VALIDATION (3:42 PM ET) | 1 | Source improvement | Credential preflight no-dispatch proof preserved in [PR #38](https://github.com/MoonlightClarity/BLACKICE/pull/38). |
| 29 | relay_context_page / search · CONTEXT_ARCHIVE_INVALID (3:36 PM ET) | 1 | Validation / evidence needed | Context archive search rejected invalid input; original arguments unavailable. |
| 30 | relay_browser / select · BROWSER_REF_STALE (3:53 PM ET) | 1 | Safety guard | Stale select reference, known no dispatch; reobserve current control. |
| 31 | relay_browser / click · BROWSER_INPUT_DOCUMENT_CHANGED (3:44 PM ET) | 5 | Safety guard | Document-change click refusals; [PR #41](https://github.com/MoonlightClarity/BLACKICE/pull/41) advises sequential same-tab dependent input. |
| 32 | relay_credentials / generate · GOAL_EFFECT_UNRESOLVED (3:42 PM ET) | 1 | Safety guard | Credential effect unresolved; no automatic replay. [PR #38](https://github.com/MoonlightClarity/BLACKICE/pull/38) prevents false uncertainty from preflight errors. |
| 33 | relay_browser / fill · GOAL_REPLAN_REQUIRED (3:39 PM ET) | 6 | Batch-dependency mitigation | Six replan refusals in 20 ms after three stale fills in 693 ms; [PR #41](https://github.com/MoonlightClarity/BLACKICE/pull/41) adds general dependency guidance, not an enforced scheduling barrier. |
| 34 | relay_browser / fill · BROWSER_INPUT_DOCUMENT_CHANGED (3:39 PM ET) | 4 | Safety guard | Document-change fill refusals; stale input blocked, scheduling dependency in [PR #41](https://github.com/MoonlightClarity/BLACKICE/pull/41). |
| 35 | relay_browser / fill · BROWSER_REF_STALE (3:33 PM ET) | 1 | Safety guard | Stale fill ref; do not insert text into an unobserved control. |
| 36 | relay_browser / interaction · BROWSER_VALIDATION (3:31 PM ET) | 1 | Validation / evidence needed | Browser interaction rejected invalid parameters; original fields unavailable. |
| 37 | relay_browser / fill · GOAL_EFFECT_RECORDED_OCCURRED (3:31 PM ET) | 1 | Safety guard | Goal recorded the earlier fill as occurred; do not replay. |
| 38 | relay_browser / fill · GOAL_EFFECT_UNRESOLVED (3:30 PM ET) | 2 | Safety guard | Fill had unresolved possible effect; verify actual page/receipt first. |
| 39 | relay_browser / click · BROWSER_REF_STALE (3:25 PM ET) | 1 | Safety guard | Stale click ref; known no input dispatched. |
| 40 | relay_browser / read · BROWSER_VALIDATION (3:23 PM ET) | 2 | Source improvement | Guarded read contract mismatch corrected in [PR #36](https://github.com/MoonlightClarity/BLACKICE/pull/36). |

## Evidence-based conclusions

**Native capture:** The long-running BLACKICE WebContentsView inside a hidden BaseWindow was subject to a slow two-animation-frame gate: about 1.34 seconds in the live process against a 1.5-second frame boundary, while direct copy took 41–50 ms. Fresh parked-view pixel tests and the fix in [PR #35](https://github.com/MoonlightClarity/BLACKICE/pull/35) support a true rendering root cause.

**Batched dependent input:** Three stale-document fills returned between 20:39:58.521 and 20:39:59.214 UTC. Six GOAL_REPLAN_REQUIRED failures followed between 20:39:59.222 and 20:39:59.242 UTC. This indicates a dependent-call burst. Codex can receive simultaneous dynamic tool requests; [PR #41](https://github.com/MoonlightClarity/BLACKICE/pull/41) explains the observe/action/dependent-action contract, but a hard provider-side concurrency barrier has not been added.

**Credential uncertainty:** One credential-generation validation error was followed four seconds later by GOAL_EFFECT_UNRESOLVED. [PR #38](https://github.com/MoonlightClarity/BLACKICE/pull/38) distinguishes trusted preflight rejection from possibly executed vault mutation.

**Other concrete improvements:** [PR #36](https://github.com/MoonlightClarity/BLACKICE/pull/36) checks guarded browser reads, [PR #37](https://github.com/MoonlightClarity/BLACKICE/pull/37) preserves modal/overlay evidence, [PR #39](https://github.com/MoonlightClarity/BLACKICE/pull/39) separates invalid native selections, and [PR #40](https://github.com/MoonlightClarity/BLACKICE/pull/40) preserves trustworthy pre-text failure evidence.

**Safeguards retained:** Stale references, changed documents, already-recorded effects and unresolved effects must not be disabled to make the error list shorter. The old error-only data does not establish which controls were targeted or whether a submitted effect occurred.

**Historical limit:** 18 legacy groups lack safe retained error codes; they are individually listed above, but their original causes cannot be reconstructed. The new lifetime distinct index preserves future unique codes after older individual receipts roll out.

## Deployment criterion

At audit time the visible Distinct failures button was installed, but PRs #35–41 were source changes pending a consolidated installer. Install the merged main source only after validation, preserve the existing profile, and use a new end-to-end run to compare error categories and confirmed application outcomes. Do not reclassify an unknown historical effect as failed or successful.
