# BLACKICE provider history isolation

The BLACKICE application constructs its Codex provider with `isolatedHistory: true`. Its saved chats, plans, workflow results, learning receipts and continuity archives belong to the BLACKICE profile. Provider execution must not create a second user-facing copy in the Codex sidebar.

The boundary is an immutable `CodexRuntime.isolatedHistory` property, also reported by `status()`. `ProviderRuntime.status()` carries it at the top level and inside `codex`. A legacy per-run `codexHistory: "codex"` value cannot disable it. Generic library callers that do not enable this application boundary retain their existing persistent integration.

Every new thread created by the isolated instance requests `thread/start` with `ephemeral: true`. The response must explicitly confirm `thread.ephemeral === true` before BLACKICE sends a user turn. An ignored or unsupported flag fails with `CODEX_HISTORY_UNSUPPORTED`; there is no persistent retry. Completion, failure and cancellation release the temporary subscription and discard its non-durable context entry.

The single application provider covers Chat/coordinator execution, delegated workers, scheduled/project/workflow runs, post-task learning and native Planning responses. Planning responses already used temporary threads; ordinary agents and learning previously forced persistent history even when a caller supplied the legacy private-history value. Provider model-access checks independently request and verify temporary threads. The repository's five native runtime verification entry points now enable the same application isolation boundary.

Isolated sessions also disable only Codex's native `multi_agent` and, when present, `multi_agent_v2` spawning controls, then verify the actual thread applied them before starting its turn. BLACKICE's own delegated-worker tools and saved delegation preferences remain available; those workers use this same isolated provider. Unsupported or ignored controls fail closed. Ordinary authorized execution tools remain available, and generic library sessions keep their previous native feature behavior.

No credential file is copied, replaced or printed. `CODEX_HOME`, the account's existing authentication mechanism, subscription, model catalog and selected model remain unchanged. Isolation concerns provider conversation storage; it does not promise that Codex has no operational logs or caches.

## Continuation and compression

Temporary IDs are not durable Codex rollouts. An isolated driver rejects a supplied `threadId` before any resume RPC with `CODEX_PRIVATE_THREAD_RESTART_REQUIRED`. The application engine must reconstruct a new private response from the authoritative BLACKICE saved conversation and recorded state, including when the preceding BLACKICE run used an older persistent Codex ID. It must preserve the logical chat, chronology, user directions, confirmed results and original archive. It must not append new turns to an old shared rollout or silently fall back to persistent storage.

Persistent native compaction assumptions do not apply to temporary sessions. `compactThread` and `compactHistory` fail before model work with `CODEX_PRIVATE_COMPACTION_UNAVAILABLE` on an isolated runtime. The caller must expose that limitation rather than commit an expired temporary ID as a durable checkpoint. Normal automatic preparation of saved history for the current private response remains distinct from claiming a resumable persistent checkpoint.

Existing Codex records are not deleted or modified by this change. Any cleanup of previously leaked BLACKICE entries must separately identify ownership from BLACKICE run/node or learning-review receipts; reversible archiving must not include unrelated user chats.

## Protocol and verification evidence

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) describes in-memory ephemeral forks and version-specific local schema generation. It also distinguishes stored-history resume from turn execution. The installed development CLI, `0.166.0-alpha.5.1`, generates a `ThreadStartParams` schema containing the nullable boolean `ephemeral` field. Inspect the CLI actually used by an installation instead of assuming a different version's protocol:

```powershell
codex --version
codex app-server generate-json-schema --out .build/codex-protocol
node --test tests/codex-private-history.test.mjs tests/runtime.test.mjs tests/planning-response-profile.test.mjs
```

A bounded no-inference development probe confirmed that `thread/start` acknowledged `ephemeral: true`, the new ID was absent from stored `thread/list` before and after app-server restart, and account authentication remained valid. `thread/resume` failed for that ID while loaded, after unsubscribe and after restart. The probe started **zero model turns** and made no home-directory or credential changes. This establishes the current installed protocol's behavior; later runtime versions must retain explicit acknowledgement and fail closed when they cannot provide it.

Tests cover parallel Chat/worker/learning-style turns, legacy persistent requests that cannot bypass isolation, missing/false acknowledgement, cleanup after failure, blocked stored-thread resume, blocked durable compression claims, and the separate generic persistent-library contract. Application continuity tests additionally verify the engine's saved-history handoff policy.
