# Direct-caller contract interpretation

> **Status: Engineering reference.** This describes a source implementation or internal contract, **not a guarantee for every installed or published version**. Verify the relevant source revision and release notes before applying operational details. See [documentation map](README.md).

Fresh `blackice_task_contract` responses that contain a contract add a response-only `contractInterpretation` sibling. Existing callers receive it on an ordinary fresh read without a catalog refresh. Replaying an earlier durable request retains its original response bytes.

The sidecar identifies authenticated caller supply or canonical source linkage. Neither is verified human authorship. Validation, persistence and `preserve`/`audit` labels do not turn caller assumptions into user authority or evidence.

The fixed guidance asks the caller to use the latest actual intent and uncertainty policy, separate known facts from supported inference and unknowns, identify the governing basis at material decisions, consider expected value, and scope third-party process requests and personal certifications. Agent disagreement alone is not a veto. Explicit user gates and prior-effect duplicate protections remain intact.

This is advisory, not semantic enforcement. The host does not inspect contract prose, verify factual premises, detect conflicts with unavailable user messages, or require a new decision ritual. It cannot force an external caller to continue or detect an unreported abandoned branch. No provider call, new schema, admission predicate, contract migration or receipt rewrite is added.

Unit tests check labeling, bounded guidance and unchanged arguments/state. HTTP tests check ordinary-read delivery, stored journal bytes, old idempotent receipt replay, unchanged catalog and zero model/browser calls. They do not claim external-model behavioral compliance.
