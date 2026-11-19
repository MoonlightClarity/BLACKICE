# BLACKICE 2.40.21

Status: source candidate. This note does not establish installation or publication.

- Browser navigation briefly waits for top-level routing to settle before offering controls. If the page is still changing, take a fresh snapshot rather than reopening the URL.
- When input is rejected before dispatch because its reference went stale, the tool returns fresh controls when available. It never repeats the click or reloads the page during recovery.
- Task handoffs carry usable source links and checked facts, not just names. When an input is missing on resume and it can be located independently, recover it from a current source before declaring the step blocked.
