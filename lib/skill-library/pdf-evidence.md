# Read a PDF for evidence

Use this guidance when the result depends on what a PDF says, where it says it, or what its tables show. Start with the shortest route to the evidence; these are defaults, not a checklist.

## Get to the relevant page

- **Known local path:** Read it directly with `relay_workspace`: `{"action":"read","path":"reports/evaluation.pdf","startPage":1,"pageCount":3}`. An absolute path returned by `relay_find_files` works the same way. If you only know the filename, find it, then pass the selected returned path straight to the reader. Finding the file is not reading it. No separate extraction command or attachment is needed for a supported local PDF.
- **Task attachment:** Read with `relay_files`, using the exact `attachmentId` from task context or `{"action":"list"}`. For text, use `startPage` and `pageCount`; for a known phrase in a long attachment, `search` with `query` can locate it, then read the page around the match. A search miss covers only the text and pages the tool actually examined.
- **Partial text:** Follow the returned `nextPage` and, if nonzero, set `startChar` to the returned `nextChar` to continue within that page. An attachment read with character arguments returns one page at a time. Stop when you have enough for the request; don't read the entire file just because a cursor remains.

## Use and check the evidence

Keep printed labels distinct from 1-based file pages, e.g. “PDF p. 7 (printed p. 4).” When using table values, verify the row, header, units, and any footnote that changes their meaning. If extraction scrambles columns, don't infer the layout from text order.

**Example:** “What did the evaluation report say about pilot enrollment?” Read the found PDF. If page 2 says 80 enrolled but page 3 says only 72 completed, report the two separately with their pages instead of treating them as competing totals.

**When the reader fails:** If an attachment page has no selectable text or the table order is unclear, use `relay_files` with `{"action":"image","attachmentId":"<actual ID>","page":3}` and inspect the returned pixels if image input is available. This isn't automatic OCR, and a local path is not an attachment ID. For a local PDF with no usable text, use an available local visual reader if one exists, or continue with readable pages and ask for a text-enabled copy or specific excerpt only if the missing page matters. An empty or unreadable page is not evidence that a claim is absent.
