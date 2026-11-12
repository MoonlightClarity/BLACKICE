# Directory reasoning in Chat

The Chat composer stores Directory (Auto / On / Off) and Subagents (Default / On / Off) independently for each conversation.

- Auto uses recursive directory reasoning only for /directory, @directory or @shadowdancer requests.
- On uses it for the next response without a prefix.
- Off uses ordinary Chat and rejects a conflicting Directory command rather than silently choosing a different mode.
- Subagents Default follows application preferences. On and Off override that preference for this conversation, subject to existing capacity, local-model serialization and safety admission.
- Changes apply to subsequent responses, never to admitted work. Draft preferences survive switching/reload; run preferences survive backend restart and Retry.
- Explicit choice changes establish a fresh provider context and preserve earlier saved run/catalog bytes.

Directory runs fresh model contexts for bounded decomposition, work and synthesis. Canonical source, module inputs, results, tool receipts and reference coverage remain on disk under the conversation's .shadowdancer directory. Exact host policies, identity preferences, agent instructions and user requests/directions remain separate from untrusted source data. Prior user authority is restored from the saved conversation lineage without ordinary display/excerpt truncation; missing, foreign or oversized history fails closed. Prior handoffs and attachment excerpts are imported as attributed, bounded evidence pages. Synthesis has no effectful tools and only the final aggregate answer is published.

All effects use the ordinary prepared Chat dispatcher. Independent retained-UNKNOWN fencing, native protected-context restrictions, read-only host policy, stop, static subagent admission, local capacity and final checks are unchanged. A fresh inference has its own stable host call identity, preventing cross-session provider-ID reuse. Per-phase usage is aggregated using reported token availability.

Supported release scope is one independently owned Chat agent. Shared/multi-agent workflows reject Directory before dispatch. Directory leaves remain serial; allowed independent worker batches may be delegated from writable work phases through the standard gate. This mode does not provide unrestricted parallel recursion.

Repository requests must identify the current Chat workspace. Verification uses guarded host dispatch and a bounded, explicitly scoped regular-file inventory. Generated/dependency/metadata/context paths are excluded and recorded in receipts and the report. Enumeration overflow, unreadable included paths and links fail closed. Existing test changes cannot certify completion. User-provided claims or reference coverage alone are not factual verification.

Authenticated conversation-scoped Context endpoints permit reviewing evidence and auditable restricted edits; historical finals remain preserved and stale. No top-level Context workspace or cross-conversation model Context tools are exposed.

Validation:
- Production Engine tests cover mode transitions, restart, Retry, independent delegation, active directions, historical catalog preservation, source/attachment isolation, UNKNOWN/corrupt journals and protected native denials.
- Mounted UI tests cover draft persistence and routing.
- Optional rendered acceptance: set BLACKICE_DIRECTORY_BROWSER_QA=yes and BLACKICE_NEXT_BROWSER_PATH to an Edge binary, then run the pinned Node with --test tests/directory-chat-browser.test.mjs. The test uses disposable browser/data profiles, a deterministic provider and real app/backend routes. It makes no external application/provider requests.
