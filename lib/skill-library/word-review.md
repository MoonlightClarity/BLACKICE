# Review a Word document

Use this guidance when reviewing or revising Word prose or checking a value in a Word table. Adapt the amount of reading to the requested edit; a paragraph rewrite usually doesn't need the whole document.

## Read the document you have

- **Known local DOCX path:** Use `relay_workspace`: `{"action":"read","path":"drafts/brief.docx","startLine":1,"lineCount":60}`. If the filename isn't resolved yet, use `relay_find_files` and pass the selected returned path directly. The built-in reader extracts paragraphs and tables from supported DOCX files. Use `nextStartLine` for the next chunk when needed. No separate extraction, upload, or attachment step is needed.
- **Task attachment:** Use `relay_files`: `{"action":"read","attachmentId":"<actual ID>","startLine":1,"lineCount":60}`. Get the ID from task context or `{"action":"list"}`. Use `nextLine` for subsequent ranges. A distinctive heading or phrase can also be located with `search` and `query`; read surrounding lines before suggesting a change. If a line is marked truncated, the attached-file reader supports `startChar` and `charCount` over the extracted text.
- **Pick the deliverable the user asked for.** A review can use a heading, a short anchor quote, and the proposed replacement. A requested edited Word file is a different outcome: use a compatible editing tool if available and verify the output. For an attachment, `relay_files` `export` can make a separate working copy; the original stays unchanged. The text reader doesn't edit the file or certify preservation of layout, comments, or tracked changes.

**Example:** “Make the handoff deadline clear in my brief.” Read the found DOCX, locate the handoff paragraph, and check the milestone table before rewriting. If the prose says “next week” but the table says “Friday, May 14,” identify the discrepancy instead of silently choosing a date. Return located replacement prose or a verified edited file, whichever the user requested.

**When the reader fails:** If a known DOCX read reports that the file changed while reading, reread the same path before relying on it. If a file isn't a supported DOCX or an essential fragment is unavailable, use an available compatible reader or a supplied copy or excerpt. If you have enough to review another section, do that now and name what remains unread. Never describe suggested text as a change already made.
