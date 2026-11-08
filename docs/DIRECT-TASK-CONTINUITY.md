# Direct task continuity and outcome verification

## Status

Development branch only. Not installed into the running application. Do not describe this as a deployed or universal exactly-once guarantee.

## Observed incident and root cause

An earlier verified application was omitted by a later history lookup, and a later run reported the same outcome again. The later lookup considered only its current ledger and email, omitting the earlier ledger. Missing email was not proof of non-submission. Some historical JSONL also used malformed literal line separators.

The original external direct execution path did not enter engine prompt assembly, saved conversation handoff, or native contract planning guards. Its durable identity is authenticated owner plus caller requestId. That provides exact-request retry protection, not continuity of a user's business objective. New request IDs can perform the same business effect. A successful tool receipt is not a measured task outcome.

This is distinct from tool exposure. The live connector has 36 tools, while the calling conversation catalog contains 30. Read-only inspection of the actual live ChatGPTConnector instance confirmed missing planning_graph_read, planning_graph_write, planning_cycle and three provider tools. Planning tools are registered, but the caller has stale discovery. Refreshing discovery alone would not impose native execution contracts on direct browser calls. The existing planning_cycle execution starts a model and is not used here.

## Implemented

1. Automatic bounded resource recall from durable owned direct-job receipts, filtered by current scopes, with candidate observations explicitly marked unknown. This is contextual evidence, not business deduplication.
2. A canonical task contract tool supporting create, read, update, bind, reconcile and measure without starting a model.
3. A durable owner-scoped semantic outcome ledger. Semantic identity is destination business effect plus host-observed selected identity fields, not task/request/attempt IDs, browser call text, URL alone or payload digest.
4. Native form binding observes the actual submit control without clicking it. Receipt extraction identity must match the business identity fields. Per-resource identity field policy is immutable across tasks.
5. Ordinary browser calls inherit the task from the bound tab. Subsequent observed target identities bind automatically under the same task policy. No mandatory baseline read is added before each operation. With no recorded host effect, the initial attempt may proceed while its baseline remains UNKNOWN. Known prior outcomes and pending UNKNOWN claims remain protected; empty history or email search absence is not evidence of issuer absence.
6. The browser's final fresh-descriptor dispatch guard atomically persists UNKNOWN before allowing a commit. Equivalent unknown/confirmed effects are blocked unless the agent records a separate deliberate occurrence under the supported repeat protocol. That protocol preserves the original evidence and does not turn uncertainty into absence. Scope, prerequisites and target capacity are checked. UNKNOWN survives cancellation, crash, process restart and lost acknowledgment. Lease expiry never authorizes a repeat.
7. Native host receipt extraction, not caller assertions, resolves outcomes. Distinct confirmed outcomes require matching admitted effects and adequate host evidence. An initial confirmed outcome with an UNKNOWN baseline may count with novelty qualified as within-recorded-history and history coverage not established; it must not be described as globally new. Established issuer absence supports the stronger absence-established qualification. Baseline source facts are durably retained before establishing absence, and cannot be reused as fresh post-action absence. Conflicting facts remain unknown.
8. Tool results retain task measurement separately from transport success. Read-only reconciliation remains possible while effects are unknown.
9. Explicit owner-bound task contexts and a native engine bridge now share semantic admission with direct browser calls. Supported HTTP host-only transports preserve the guard through operational workers, delegated workers, readiness, recursive planning and final review. See EXPLICIT-TASK-CONTEXT.md and HOST-ONLY-TRANSPORT.md.
10. Agent-managed deliberate repeats record an instruction reference, quoted user instruction, reason, occurrence identity and caller-attested provenance. An uncertain prior effect requires an explicit uncertainty acknowledgement; it is retained, not erased. Repeated instruction references are idempotent. This adds no user-facing control or requirement to leave direct mode. Caller attestation is not host-authenticated proof that the quoted instruction came from the user.

## Success measurement

Each external-confirmation criterion declares a target count. Measurement reports distinct host-confirmed outcomes, evidence IDs, novelty/history-coverage qualifications, unknown baselines, unresolved effects and repeat ambiguities. Prior outcomes, duplicate issuer outcomes, successful clicks and merely missing receipts do not count. A deliberate occurrence requires a distinct recorded issuer outcome; acknowledging uncertainty alone cannot prove additional progress. Current implementation does not satisfy observation/source-coverage/judgment criteria; these remain unsatisfied rather than being silently accepted.

## Boundaries and remaining work

- Recognized native form commits now share admission across direct contained-browser calls and explicitly attached native engine tasks on supported HTTP host-only transports. Arbitrary shell commands, frontend evaluation, other connectors and external browsers remain outside semantic coverage. Native Codex and Mistral transports cannot currently establish the required host-only boundary and are rejected for protected execution.
- Opaque effects in a bound task are blocked. Unbound non-native/opaque routes retain existing behavior, so this is not a universal mutation firewall.
- A canonical business identity must include both subject and target when a site shares a submission endpoint. The host verifies actual field values and persists the chosen field policy, but cannot infer every site's business meaning or guarantee that an initially chosen field set is complete.
- Without adequate identity-bound confirmation evidence, the outcome remains UNKNOWN. An unavailable absence baseline alone does not prevent an initial attempt when no host effect is recorded. Native text success needs real POST/navigation correlation. An empty history or generic “thank you” text is insufficient.
- Conservative unchanged-source rejection may require a fresh issuer record/version to establish absence after uncertainty.
- Canonical linked tasks now reuse saved plan revisions, scoped signatures and receipt refinements without reattachment. Original standalone direct contracts retain their fixed-contract behavior. The same-native-task exact-payload duplicate guard remains; semantic repeat authorization does not bypass that native limitation. See CANONICAL-PLAN-CONTINUITY.md.
- Ownership is the authenticated connector grant. Do not claim cross-account or cross-grant continuity.
- Existing historical prose/JSONL successes are not silently imported as host-verified semantic outcomes. Resource recall can surface them, but migration requires explicit trustworthy identity/evidence mapping.
- Local fencing cannot prevent duplicate effects from another client or human, or guarantee external exactly-once delivery unless the destination itself supports that.
- Journal limits: 16 MiB and 512 retained operation contexts per task. Exhaustion fails closed.
- Deployment requires review, installation into the application, a safe restart after active work settles, and connector catalog refresh. None has been performed.

## Validation

Tests use temporary isolated storage and a real production BrowserWorkspace, browser handler, native form descriptors, receipt extraction and submission-correlation code against a synthetic destination. They do not submit real applications.

The combined task-context regression log reports 368/369 passing. Its sole failure is the existing MCP browser-schema discovery securitySchemes assertion, previously reproduced on the clean de9d973 baseline; the suite is not fully green. See verification/combined-task-context-regression.txt. Additional recorded runs passed: explicit-context smoke 67/67, native engine/server 147/147, native final measurement 72/72, transport regressions 259/259, helper regressions 104/104 and final protected helper/transport checks 11/11. These suites overlap and must not be summed as unique coverage. Earlier intermediate logs are not the final result.

Synthetic 25-read and two-target cases previously measured 82.168 ms and 244.390 ms including setup/cleanup. The 100-outcome ledger benchmark measured 51.3 ms median, 78.2 ms p95 per bind/baseline/claim/confirmation sequence and 0.53 ms per measurement read. These are isolated fixture overhead, not website latency or production guarantees. No real applications, production runtime restart or active-browser changes were performed.

For the checkpoint include the bounded transport-boundary-evidence.json summary, not the raw local transport catalog capture. Raw protocol captures can include environment/configuration details and are not required as distributable documentation or commit evidence.

The final context-focused rerun passed 68/68; see verification/context-final-focused.txt.

The canonical integration regression passed 397/398 tests, with only the same baseline browser-schema assertion failing. See verification/canonical-final-regression.txt. Tests establish deterministic adapter behavior, not model attention or judgment quality. Canonical task meaning and identity-field selection remain agent-authored interpretations; host verification must not be represented as proving those interpretations correct.

## Follow-up verification

The final expanded direct/canonical/catalog/connector regression passes 494/494 (verification/continuity-complete-regression.txt). The earlier discovery failure was a stale test expectation: MCP advertises OAuth transport scope read while execution separately enforces browser action scopes. Updated tests prove missing action scopes admit no jobs and dispatch nothing; production permissions were not changed. Catalog expectations now include the two registered task tools. Dedicated direct-runtime tests verify native POST-correlated rejection clears UNKNOWN without resubmission; identical uncorrelated rejection text does not. These supersede the prior known-failure and correlated-rejection test-gap notes, not the documented coverage limits.
