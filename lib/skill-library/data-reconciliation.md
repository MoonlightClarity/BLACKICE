# Reconcile two lists

Match two tables or exports and report missing, duplicate, and ambiguous records without silently dropping rows.

**What you need:** Two readable lists, a join key or sufficient matching attributes, and representative sample rows.

**Approach:** Compare key formats and uniqueness in each list. Separate exact, normalized, ambiguous, and unmatched cases; show normalization on a sample. Use secondary fields to resolve a collision only when they support the match.

**Check and recover:** Reconcile input counts on both sides before claiming completeness. If exports are partial or a key has multiple candidates, show the exceptions and suggest the field that would resolve them.
