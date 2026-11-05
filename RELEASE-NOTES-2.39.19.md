# BLACKICE 2.39.19 — Visible Mistral replies with Planning Off

**5 November 2026.** This source release repairs a native Mistral reply failure observed with Planning Off: the CLI ended the turn with whitespace instead of a visible answer, and Chat labelled that empty result “Response saved.” It also repairs Windows native session saves and follow-up readiness. Planning and reasoning remain separate choices.

## Native Mistral reply recovery

- A completed native turn must supply a nonblank visible answer to be treated as an answered chat turn. Hidden reasoning is not substituted for the assistant response.
- After a confirmed empty completion, BLACKICE requests at most one answer-only continuation in the same native session. It retains the selected model, reasoning effort and conversation history. It does not resend the original user request.
- Tool callbacks are unavailable during that continuation, so reply recovery cannot repeat the original task's file, command, browser or other tool operations.
- If the continuation still provides no answer, BLACKICE records a clear failure. Interrupted or uncertain requests retain their existing recovery behavior; they do not enter this completed-turn recovery path.
- Native tool guidance uses the MCP tool names actually exposed to Vibe by BLACKICE's attached bridge.

The recovery applies at the native reply boundary for all planning modes. It addresses a missing final answer; it does not change which model is selected or promise that every provider request succeeds.

## Windows session saves and follow-ups

On Windows, BLACKICE supplies the native Vibe home using extended-length path syntax while retaining the same physical directory and existing history. This fixes native session chunk saves that exceeded Windows' traditional path length limit, without changing the Windows registry or moving the native home.

A persisted session becomes ready for a follow-up only after the native session-close acknowledgement and an observed graceful child-process exit. If saving or closing fails, an accepted visible answer is retained while session readiness remains uncertain. A forced or unconfirmed close is not recorded as a clean exit, and BLACKICE retains ownership of a live session until its native process has actually exited.

## Startup requests during shutdown

Shutdown waits for already accepted automatic-startup requests to finish reading their results before it closes the connector services. Concurrent requests still share one Windows startup operation, and new requests are rejected once shutdown begins. A failed result read does not interrupt another accepted request that is still finishing.

## Chat completion and saved history

Chat shows “Response saved” only when the saved turn contains a visible response. Historical empty completions receive an explicit missing-response status and helpful text, while existing user messages and execution records remain intact. Final responses are hydrated into the conversation when completion arrives, including when the final text was not present in streamed deltas.

Existing native model identities, application defaults and provider credentials are preserved. The three choices reported by the signed-in Vibe account remain independently selectable with their own reasoning controls.

## Verification and Windows distribution

Focused regressions cover blank native completion, bounded continuation, tool isolation during recovery, repeated-empty failure, extended Windows paths, acknowledged session closure, actual process exit, saved-response hydration and historical empty-result rendering.

A live Planning Off check on the installed candidate runtime used a GLM native session to read a nonce fixture through a BLACKICE tool, displayed the answer, and reached a completed and settled state. The next turn resumed that same native session and returned the expected value from its history without another tool call. Large 4 and Medium 3.5 were each selected through BLACKICE's UI with their reported reasoning options; with Planning Off, both returned the exact requested visible reply and reached a completed and settled state.

The original older native journal also loaded successfully in a bounded ACP metadata-only probe, restoring its original session identity and GLM/high settings. The probe sent no prompt, ran no inference or tools, and finished with a close acknowledgement and a graceful exit with code 0. Vibe's checkpoint chain and all three chunks passed hash validation after normal journal pruning. These observations remain separate from the synthetic source suite.

The complete Windows source suite and exact-installer checks are required by the [Windows release workflow](SIGNING-AND-RELEASE.md). The Windows artifact is **Blackice-2.39.19-Setup.exe**, using the existing unsigned release policy. The matching source-test receipt records the tested source inventory and final counts; the release's installer evidence records the exact Setup hash, installed-file integrity, registration, shortcuts, backup/restore and uninstall checks. Older receipts and local source overlays do not establish verification of this installer.

## Incoming Mistral Work connector status

Incoming **Mistral Work → BLACKICE MCP** remains unconnected in the current live verification. A fresh custom-connector setup still failed server reachability before an OAuth connection or an actual tool call was established. Incoming setup and tool-call acceptance must be verified separately from native **Mistral Vibe Code** inside BLACKICE and optional **Mistral API** connections. The [2.39.18 notes](RELEASE-NOTES-2.39.18.md#incoming-mcp-authorization-and-its-remaining-limit) record the earlier reachability limitation.

On the verification machine, persistent Tailscale transport was already configured with automatic Windows service startup, unattended mode and a saved background Funnel. The endpoint remained usable after a BLACKICE application restart. A Windows reboot was not exercised in this verification.
