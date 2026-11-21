# Read a PDF for evidence

Use to answer a question about a PDF's text, tables, or pages.

## Read the relevant pages

1. For a known local PDF, use the attached local-file reader with one path and the needed page range. If the path is unknown, find the file first and read the selected returned path.
2. For an attachment, get its actual attachment ID from task context or the attachment list. Use the attachment reader; a local path is not an attachment ID.
3. Use the current tool schema for page, text-range, search, and image arguments. Follow the cursor fields returned by that reader when more content is needed. Stop reading when you have enough to answer the request.

## Check and report

Keep file page numbers distinct from printed labels: “PDF p. 7, printed p. 4.” For a table, check the row, header, units, and relevant footnotes. Cite the page that supports each finding.

Example: 80 enrolled and 72 completed are different measures, not conflicting totals. State both with their pages.

If extracted columns are scrambled or a page has no selectable text, inspect its page image when an image reader is available. An image return does not establish that OCR was performed.

Continue with readable evidence. If an essential page still cannot be read, identify that page and the missing information. An unreadable page does not establish that a claim is absent.

Tool schemas exposed in this run take precedence over example calls or declarations found in source code.
