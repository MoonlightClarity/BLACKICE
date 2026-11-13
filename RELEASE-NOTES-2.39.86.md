# BLACKICE 2.39.86

## Preserve configured remote access through transient outages

- A transient transport outage during startup or health checks no longer erases an already enabled route configuration.
- Recovery uses capped backoff while the same enabled intent remains, preserving the exact mode, hostname and ports. Offline preflight probes are read-only.
- Explicit disable and shutdown invalidate queued and in-flight recovery. Ownership conflicts, hostname changes, and uncertain post-mutation verification do not automatically retry.
- Healthy configured routes receive periodic read-only availability checks. Recovery does not create a new grant, broaden exposure, or modify unrelated routes.

## Verification limits

Focused mocked transport, gateway and recovery tests and the combined source suite are distinct from a real Tailscale outage test. No live network settings were changed by source verification. This release does not contain the unfinished autonomous-runtime candidate or resume real job applications automatically.