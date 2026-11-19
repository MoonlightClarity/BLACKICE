# Summarize a web page

Use this when the user wants the substance of a particular page, not a survey of what the web says. Start from the page or excerpt they supplied. The goal is to answer their question from the source, not to describe the navigation.

## Get the relevant text

- If the user supplied a URL, reuse the matching task tab if it is already open. Otherwise `relay_browser` with `action:"open", browser:"relay", url:<supplied URL>` opens it. Use the observed tab ID for `action:"read", browser:"relay", tabId:<observed ID>`. Check the final URL and title; a redirect can land on a different document, edition, or sign-in page.
- If the question points to a heading, version, date, or term in a long page, add `query` to `read`. This can bring nearby visible text into view without rereading the whole page. An empty query result does not establish absence. Try a likely heading or alternate wording, then read enough of the surrounding section to preserve exceptions and scope.
- If only a link or collapsed section is visible, use a fresh `snapshot` of that tab to identify the actual section or link. Follow it when it is needed to answer the question; use the current tool contract for any interaction. Confirm the resulting page or expanded section with `read` rather than assuming a click exposed the desired text.

## Turn the source into an answer

Lead with what the page says that matters to the user. Include the effective date, edition, affected group, or conditions when they change the conclusion. Link the source, and distinguish the page's claims from your own implications. Read tables with their headings and footnotes; pagination or default filters can limit which rows you saw. You don't need to exhaust the site to answer a narrow question.

If a page stays unavailable, distinguish the failure from a substantive finding. For example, a sign-in wall means the relevant policy was not visible, not that it says nothing. Summarize any supplied excerpt as an excerpt. If the request depends on the exact page, don't silently substitute another; a clearly labeled public counterpart may still answer the nearby question.

## Worked example

“Does the linked release note say when CSV export ends?” The page opens on a release feed. Reading with `query:"CSV export"` shows a heading and a sentence ending “see migration notes.” The observed migration link leads to a note saying the legacy CSV endpoint retires June 30 for v1 clients; the in-app Export button is unchanged. State the date and the narrower scope, and link the migration note. If the link instead opens a sign-in page and the feed gives no date, report that the published excerpt mentions retirement but you could not verify the date. Don't turn the feed's publication date into the retirement date.
