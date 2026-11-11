# BLACKICE 2.39.60

- Accept repeated identical terminal choices containing only inert metadata in the response-only data-return stream. The complete response arguments remain unchanged.
- Continue rejecting conflicting termination, additional tool-call deltas, nonempty content, mixed output, malformed or incomplete responses, and cancellation.
- Check consistency of optional native termination metadata without allowing it to override the canonical finish reason.
- Preserve the single data-return function, zero operational-tool dispatch, authoritative schema and semantic validation, and the existing one-repair budget. Normal executable-tool behavior is unchanged.

Validation uses sanitized synthetic framing replay, adversarial offline fixtures, and the exact Windows source suite. The previously captured response validates unchanged in offline replay; this release does not claim a fresh live-provider success or completed user task.
