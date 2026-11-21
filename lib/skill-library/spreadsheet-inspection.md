# Inspect spreadsheet data

Use to inspect workbook sheets, stored cells, formulas, or exported table data.

## Read the right data

For a local .xlsx file, use the attached local reader to inspect its sheets. Read the selected sheet using its exact returned name and a row/column range supported by the current tool schema. Inspect further ranges as needed. Use returned continuation fields rather than copying fields from an older example.

Formula text and stored cached values are separate. The built-in reader does not recalculate formulas or recreate workbook formatting. CSV exposes values and text, without workbook sheets, hidden rows, or formula metadata.

## Inspect and reconcile

1. Identify the sheets and ranges relevant to the question.
2. Check headers, units, dates, blank cells versus zeroes, duplicate keys, and row counts.
3. Recompute meaningful totals from the actual rows and compare them with the workbook's stored totals.
4. Read the cells behind a discrepancy before drawing conclusions about the whole workbook.

Report the ranges inspected, the findings, and any formula or data gap that affects the answer. If a sheet or range cannot be read, try another supported reader or a supplied export and continue the checks it can support.

Example: a stored formula value may be stale. Report the formula, stored value, and independently computed value separately.
