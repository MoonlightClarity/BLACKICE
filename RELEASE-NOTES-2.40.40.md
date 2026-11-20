# BLACKICE 2.40.40

Windows test candidate.

- If a checked Directory action is blocked and an independent step can still run, BLACKICE can continue once more after the block reaches the provider transport. It leaves the blocked step blocked and does not replay uncertain attempts. Maximal Receipts record when this happens.
- Maximal Receipts now label workspace command activity as `run` without recording command text, arguments, or output. Older receipts do not gain missing information retroactively.
