# BLACKICE 2.39.68

- Native GPT-6 Luna now retains Directory execution through protected host-dispatched tools, without falling back to ordinary chat or changing the selected model.
- Native preflight verifies effective feature controls and a read-only, network-disabled session before inference. Cancellation safely cleans up temporary sessions and does not cancel another waiter.
- Planning connector discovery is compact and provides exact per-action schemas, examples and actionable argument errors. Strict server-side validation is preserved.

Verification includes live native Luna Directory phases, model-free adversarial tool-boundary checks, connector HTTP discovery and synthetic graph round trips. Actual ChatGPT schema rendering remains a separate client-side verification step.
