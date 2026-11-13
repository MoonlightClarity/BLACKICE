# BLACKICE 2.39.87

## Recover transient Codex startup discovery

- Initial Codex connection discovery can recover from narrowly classified transient startup failures with at most three handshake attempts.
- Shared startup coordination avoids duplicate connections. Recovery does not replay a thread or turn, and is blocked once opening or active work could have effects.
- Authentication, permissions, quota and rate-limit errors retain their actual failure behavior. Closing cancels pending startup and backoff.

## Verification limits

Focused tests use controlled app-server processes and RPC responses, not a live Codex outage. Exact combined source testing and publication/install verification are separate gates. No real job is automatically resumed. Visual, autonomous-runtime and tab-cleanup feature branches remain separate work.