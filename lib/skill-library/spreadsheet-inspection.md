# Inspect spreadsheet data

Profile supplied table data and reconcile totals; use workbook features only when the reader exposes them.

**What you need:** Supplied cells, CSV, or a local .xlsx file. For .xlsx use relay_workspace read with its path to list sheets; repeat with the exact sheet name and a bounded row/column range to inspect stored cells. Formula text and stored cached values are separate; dates/styles and caches are not recomputed. CSV does not expose sheet structure, formula text, hidden rows, or workbook formats.

**Approach:** Identify the actual sheets or ranges inspected. Check headers, blanks vs zeroes, duplicates, date formats, units, and counts. Recompute a small set of meaningful totals independently and reconcile discrepancies before extrapolating.

**Check and recover:** State which rows or sheets were inspected. If formulas are not visible, report checks on exported values only; ask for a formula-bearing copy or a specific range export when that gap affects the answer.
