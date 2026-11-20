# BLACKICE 2.40.47

Windows test candidate.

- A counted Directory action can declare how many qualifying results it needs and which user requirements must be verified. Unknown or unmet checks do not count, and repeat reads of the same source cannot satisfy two entries.
- The check compares the agent's stated findings with its declared requirements and linked source receipts. It does not independently verify the agent's interpretation of a source. Tasks without a declared target keep the existing behavior.
- Partial evidence stays recorded without closing the step. Genuine exhaustion can still be reported as incomplete.
