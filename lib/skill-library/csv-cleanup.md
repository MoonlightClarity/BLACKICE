# Clean and reconcile CSV data

Clean tabular text with reversible transformations, a change summary, and reconciliation checks.

**What you need:** Readable CSV text and, if a file is requested, an available text writer. Workbook structure and formatting are not preserved by CSV.

**Approach:** Confirm the intended key and parse delimiter, quoted fields, and line breaks. Normalize only named fields, preserve identifiers with leading zeros, and separate ambiguous duplicates rather than picking an arbitrary survivor.

**Check and recover:** Compare source and output row counts, distinct keys, and critical totals. Reopen the output if saved. If verification or writing failed, state what remains unchanged and provide a preview or complete CSV as text when practical.
