# Clean and reconcile CSV data

Use when cleaning, normalizing, deduplicating, or combining CSV rows.

1. Read the input with a CSV parser that handles its delimiter, quoting, and embedded line breaks.
2. Identify the columns to change and any key used to match rows. Keep identifiers such as “00123” as text.
3. Apply the requested transformations. Resolve duplicate candidates from their fields; keep ambiguous cases available for review instead of choosing an arbitrary survivor.
4. Compare input and output row counts, distinct keys, and important totals. Account for each removed or combined row.
5. Save the requested output and reopen it with the parser.

Report what changed and any unresolved rows. A CSV contains values and text; it does not preserve workbook formulas, sheets, or formatting.

Example: trim spaces in customer IDs, but do not remove their leading zeroes. If two rows then share an ID with different addresses, report the collision.

If parsing fails, identify the row and quoting or delimiter problem, repair the smallest affected portion, and rerun the count checks.
