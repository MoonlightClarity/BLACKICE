# BLACKICE agent reliability — audit coordination and corrected evidence (2026-11-14)

## Ownership and status
- Our general-reliability worktree: `C:\Users\user\Documents\Codex\BLACKICE-agent-reliability-20261114` (branch `feature/agent-reliability-20261114`).
- Separate audit lifecycle repair copy: `C:\Users\user\Documents\Codex\BLACKICE-agent-audit-lifecycle-repair-20261114`. The audit owner's source at `C:\Users\user\Documents\Codex\2026-11-14\new-chat-3\blackice-audit-candidate` was NOT modified.
- Live BLACKICE was NOT restarted, reinstalled or released by this task. No duplicate live Luna test was started. The stopped job-search conversation remains untouched.

## Correction to the earlier PATH hypothesis
The original failed Luna tool attempt involved BLACKICE's already-running Codex app-server from Windows Store package `OpenAI.Codex_26.1106.6628.0`, whose matching package companion was absent. The registered Codex package had meanwhile changed to `26.1111.2228.0`. The audit-owned restart completed at 12:11 UTC, replacement BLACKICE PID 22632 on the same direct connection. An observed Codex child PID 20120 under 22632 was using package `26.1111.2228.0`. None of these observations proves a completed live tool call.
My earlier independent discovery of a standalone executable under `.codex/plugins/.plugin-appserver` did NOT explain why the stale Store app-server could not launch its own matching companion. Prepending that unrelated directory to the child PATH might select the wrong executable/version. **That PATH workaround is withdrawn and must not be included in a release.** The general-reliability tests and host-error classification remain separate.

## Audit lifecycle candidate
Audit owner supplied an isolated rediscovery candidate and independent test file:
`C:\Users\user\Documents\Codex\2026-11-14\new-chat-3\blackice-audit-candidate\independent-review.test.mjs`.
Reproduced pre-fix: **1 passed, 4 failed**; failures cover the turn-admission race before `thread/start`, failure to await observed old-process exit, phantom `starting` phase on missing replacement, and changing a healthy `ready` phase.
A separate lifecycle repair copy:
`C:\Users\user\Documents\Codex\BLACKICE-agent-audit-lifecycle-repair-20261114\lib\codex.mjs`
preserves a pre-thread admission guard until the turn settles, never installs a replacement before actual old-child exit, retains the old child handle when exit is unconfirmed and returns an explicitly non-ready status, and avoids false `starting` on failed admissions and healthy reuse.
After changes: independent 5/5, audit-regression 6/6, schema-reduction 2/2, additional negative lifecycle 3/3 = **16/16 passing** (isolated tests). This is not integration, packaging, or live success.
The remaining risks are real-process exit/IPC races, tool dispatch under the replacement, and compatibility with concurrently changing source. Audit owner should review the patch, reconcile with source, and own any release.

## General agent-reliability candidate
- `lib/goal-recovery-policy.mjs`, `lib/conversation-goals.mjs` add no-progress loop recognition, host pre-dispatch refusal versus web/CAPTCHA diagnosis, unknown-effect preservation, specific recovery observations, and destination evidence versus tool call assertions.
- Focused suite: **96/96** passes after explicit recovery-observation fix. Not installed/merged and no live post-patch Luna verification.
- The earlier Luna all-modules/Directory-on test `a29c5416-f2fd-4adb-99ce-f660b596cdd7` ended `MODULAR_OUTCOME_STALLED` with no recorded tool actions and was paused. Do not count it as verification after the audit restart.
- No destination-confirmed employer submission in the test; don't resume the stopped job-search conversation or reattempt uncertain effects.

## Required next steps before release
1. Audit owner reviews lifecycle repair against latest source, checks that no old process can overlap the replacement, and validates the existing test suite.
2. Integrate only the lifecycle repair that survives review. Do not merge the withdrawn PATH workaround.
3. Once coordinated, run **one** actual post-fix BLACKICE Luna chat test with all nine modules, Directory on, and the agent's own tools; demonstrate a local test action plus separate independent readback first.
4. Reconcile every prior job application and uncertain effect before any employer action; require employer-side confirmation for a real submission. No synthetic receipt is a real application.
