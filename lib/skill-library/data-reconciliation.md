# Reconcile two lists

Use when matching two tables, rosters, or exports and locating duplicates or differences.

1. Read both inputs and check their row counts, key formats, and key uniqueness.
2. Match on a stable shared ID where possible. Normalize known formatting differences such as spaces or case and show one example.
3. Separate exact matches, normalized matches, ambiguous candidates, and unmatched rows.
4. Use secondary fields to resolve a collision only when those fields distinguish the records.
5. Account for every input row on both sides, including duplicates and unmatched rows.

Deliver the matched records and exceptions in the requested format, with the matching rule and counts. For partial exports, state which input is incomplete.

Example: two “Sam Lee” records share a name but have different email addresses. Keep them distinct unless another identifier connects them. If the key is insufficient, identify the additional field that would resolve the ambiguity and finish the reliable matches.
