# Swarm project management — isolated source candidate

Status: **source implementation for independent review; not integrated, installed or released**. Introduced from BLACKICE `2.39.97` source commit `2371578ed97960a235abbdd3dbdec14da91a4703`. This is a project coordination board, not the recursive Planning/Goal/Directory runtime.

## Purpose and boundaries

BLACKICE Swarm lets the local user and authenticated connector workers coordinate durable projects. The **Planning navigation tab** is replaced with **Swarm**. Existing Planning graph, Goal, Directory, and executable Projects stores, routes, records and deep links are intentionally untouched. Existing `#planning` can still open as a legacy link; no Planning tab is shown. Swarm does **not** run an assignment, send a message to a worker, run a model, submit an application, merge a branch, start a release or install an app.

A project contains a coordinator, workers with declared scope and optional bound connector ID, work items with owner/dependencies/requirement revision, explicit coordination phases, source observations, evidence, readiness requests, coordinator decisions, and integration records. Creating a work item **proposes** it; `queued` is an explicit *recorded decision*, not evidence of dispatch; `delivered` requires a reference but is **reported**, not confirmed; `accepted` is a worker/local-human acknowledgement; `completed` requires coordinator approval and a recorded integration reference plus scoped evidence. `completed` means completed in this **management ledger** only, not packaged/live execution. The external action must be checked independently.

### Control surfaces

| Surface | Read | Write |
|---|---|---|
| Local authenticated browser UI | `GET /api/swarm`, `GET /api/swarm/projects/:id` | `POST /api/swarm/actions` with `mutationId`, exact `action`, expected entity revision, and action-specific `value` |
| ChatGPT connector | `blackice_swarm_read` | `blackice_swarm_write` with `planning:write` scope |
| Native short-lived worker | Not yet independently exercised/wired to these new tools | Not claimed as implemented |

The connector **read** response includes authenticated `self.kind/id/label`; a coordinator can register that `id` as a worker's `actorId`. For `delivered` reports, `accepted` transitions and readiness requests, a nonhuman caller must match its bound worker identity; the local human can act directly. Coordinator/human-only operations include queuing, ready decisions, recording integration and completion. Other workers can propose, record source/evidence and inspect assignments, but cannot assert another owner's delivery or readiness; all events identify the host-authenticated actor. No caller-provided actor override is accepted.

The data is saved only to the separate `swarm-board.json` under the existing application data directory. It has a serialized write queue, per-project/item/source optimistic expected revisions, stable actor-scoped mutation-ID deduplication, atomic temp-file rename, and a hash-chained append-only event log within the saved snapshot. Corrupt snapshots **stop loading without deleting the original**. Recorded source revisions and old requirement definitions are preserved; stale evidence remains visible. These checks prevent ordinary lost updates **within one running server**; there is no cross-process file lock or proven multi-host distributed transaction.

### REA epistemic adaptation

Read-only research inputs — NOT a code dependency or imported reverse-engineering workflow:

- REA `AGENTS.md` (repository blob `2af483be32f38eec95e7abe5cf2f65c6bc9c464f`): distinguish observed, derived, inferred, unknown; preserve exact identity, omissions, source provenance, lifecycle ownership, and limitations.
- REA `docs/reference/reconstruction-obligation-ledgers.md` (blob `5e3310dafbf7e09e983a9e3abc0b784fbc400a5f`): claim-to-evidence applicability must bind exact source and obligation revisions, and match the kind of authority actually required.
- REA `docs/reconstruction-coverage.md` (blob `a3cc64a63a67bf059a8ae7a3a7b79acf04565877`): report evidence integrity, authenticity, comparative coverage and unresolved failed checks separately. New passes do not silently erase failed evidence.

**Adaptation, not copying the domain:** Each Swarm evidence claim records `epistemic` (`observed/derived/inferred/unknown`), claimed `authority` (`source/unit/integration/packaged/live_worker/external`), `outcome` (`pass/fail/unknown`), source ID+revision+content SHA-256, requirement revision, and origin actor/time. The stored-content digest checks **local text integrity**, NOT authenticity of its origin, its observation, claimed authority, or delivery to a worker. Evidence is projected applicable only against the **current exact source and requirement revision**. Only directly comparable **reported observed** evidence of the required authority can support a coordinator readiness approval. Unit test evidence cannot establish packaged or live-worker efficacy. All selected evidence IDs must remain applicable; a changed source/requirement revision invalidates **affected claims only**. Unresolved current failures outrank approval; resolving a failure needs new passing evidence on the same named claim and an explicit coordinator rationale, while the original failed record stays available.

Projected readiness distinguishes `not_ready`, `ready_requested` (worker claim only), `ready` (coordinator approved **on claimed applicable evidence**), `blocked`, `out_of_scope`, `contradicted`, and `stale`. `ready` is **not an authenticated worker observation or release gate**: reported comparable evidence and integration references are not independently verified. `proof.assessment` stays `reported-comparable`, never “live verified” from client text.

### Source and review procedure

Source branch: `feature/swarm-project-management-20261115`, worktree `C:\Users\user\Documents\Codex\BLACKICE-swarm-project-20261115`, base `2371578ed97960a235abbdd3dbdec14da91a4703`. Root dot is the **sole integration/release owner**; do not merge, publish, install or restart from this lane. Deadline and startup lanes have independent owners. No application submissions or Work Mode actions.

Focused checks use `node --test tests/swarm-board.test.mjs tests/swarm-http.test.mjs tests/next-workspace-navigation.test.mjs`; the implemented code was also inspected with `node --check`. A temporary in-memory/ephemeral-data HTTP server on port 43981 is available only for isolated UI tests. BLACKICE contained-browser UI observations are a stronger browser boundary than unit fixtures but **do not validate packaged app, native workers, remote-model tool selection or real integration effects**.

For root review: compare `git diff 2371578ed97960a235abbdd3dbdec14da91a4703..feature/swarm-project-management-20261115`. Inspect `lib/swarm-board.mjs`, `lib/swarm-direct-tools.mjs`, `server.mjs`, `public/next/workspaces/swarm.mjs`, `public/next/swarm.css`, `public/next/app.mjs` and `public/next/index.html`. Keep source verification against any newer main; do not cherry-pick blindly if those files changed in another lane.

### Explicitly unverified / deferred

- Real live workers reading and writing through installed connector. The source exposes direct read/write, but this candidate has not been installed or exercised in the real installed binary.
- Native short-lived worker Swarm tools. `lib/engine.mjs` currently owns native tool catalog construction and is on a concurrently dirty checkout; it was deliberately not edited. Connector workers are supported in this candidate; native agent tool parity remains future work requiring ownership reconciliation.
- Actual outbound dispatch/delivery, integration merges, independent authenticity checks, packaged/live efficacy, cross-process DB coordination, runtime recovery across Windows restarts.
- Full suite, release packaging, source promotion, Skills and visuals. None was performed in this lane.

The purpose of the evidence protocol is to make **claims proportionate to observations**, not to turn missing evidence into automatic refusal or user interruption. Work may proceed autonomously under its real authority; management claims cannot retroactively manufacture outcomes.

## 2026-11-15 Chat Mode successor recovery and verification

The predecessor owner chat failed to resume (Connection interrupted). The successor **continued this exact existing isolated worktree without recreating the candidate**. The old preview command durable job `direct_44efda85d900d80c5aec22751056903c76a005d23ca9e1e40d775a4072a9780c` remains `cancelling` and `settled:false` despite a separately observed live preview: `node.exe` PID **20100**, parent **5860**, started 2026-11-15 09:17:14 EST, command `verification/swarm-render-preview.mjs`, listener `127.0.0.1:43981`. The successor did **not** relaunch, kill or restart it. A stale job status does not establish a stopped process.

The existing contained-browser preview tab `71f4114d-f90d-4995-8642-19fd31056393` was reused. DOM snapshot, screenshot and refreshed browser navigation confirmed the Swarm tab replacing the Planning tab while preserving the old underlying Planning route/module. The rendered board displayed owned work items, phases, coordinator controls and evidence provenance. A separate **isolated preview-only** authenticated HTTP edit of the fixture project (revision 3 → 4, event sequence 4) caused an SSE update; the unsaved project-name input stayed intact, with a visible notice instead of a silent form reset. This is rendered/HTTP preview evidence, **not packaged runtime, installed connector, live model or native-worker proof**. The preview server loaded its backend before the final successor source fixes; only freshly requested frontend assets were exercised in that browser check. Fresh Node test processes exercised the latest backend.

Successor source hardening binds dependent readiness to **currently valid** upstream completion, ties integration records to the exact readiness-decision identity and requirement revision, requires later observed/comparable evidence to resolve failed claims (older and weaker evidence is rejected), and reserves worker delivery reports/readiness requests for the authenticated bound owner or local human. Source records, failed results and prior revisions remain retained. Frontend failed writes retain user drafts and a stable mutation identity for deliberate identical retries; concurrent SSE updates do not destroy focused or dirty forms.

Latest narrow source receipt: `direct_98712869100a1033d065f80872c185ffef319079ebb64e064484d1e75debd642` ran `node --check` on the Swarm board/direct-tools/workspace/server, `node --test tests/swarm-board.test.mjs tests/swarm-http.test.mjs tests/next-workspace-navigation.test.mjs`, and `git diff --check`. Result: **14/14 passing, 0 failed/skipped**, exit code 0, no competing full suite. This differs from the original 11-test baseline `direct_09be51cc853c58322b12eba64393495d99c51e2a9a1efb998fece84d19aa585f` and reflects three added regression tests. Test receipts are for their exact source state only; an integration merge, new source revision or installed build needs new comparable verification.

**Integration remains owned by root dot only.** This lane did not touch native engine worker-tool catalog (concurrently owned), installed binaries, releases, applications or the root checkout. The candidate still does not implement actual worker dispatch, cross-process Swarm file locking, independently authenticated external evidence, real-worker tool selection or end-to-end release efficacy. Those are explicit future requirements, not effects implied by a green suite.
