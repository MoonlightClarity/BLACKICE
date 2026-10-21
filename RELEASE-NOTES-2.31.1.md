# BLACKICE 2.31.1

## Direct typing in the contained browser

Fixes Chat Mode sign-in fields not receiving keyboard input after a click in the page preview. The preview previously forwarded pointer clicks only; ordinary typing remained in BLACKICE's own interface.

Click a field in the contained page, then type normally. The input bridge supports typed text, Unicode paste, Backspace/Delete, Tab/Shift+Tab, navigation and selection keys, and Control/Command+A. Escape releases keyboard capture. BLACKICE's address field and other local controls keep their normal input behavior.

Input is queued in order while a click or preview update finishes. Contiguous text can be combined without losing editing-key order. Each request is bound to the selected tab, exact page URL, and observed document identity. Changing tabs, leaving the view, or changing the page cancels unsent input; uncertain input is not automatically replayed. Typed text is not echoed in keyboard receipts, and the browser remains hidden and contained.

This release includes focused input regression checks and an isolated native sign-in fixture that exercises the real application, HTTP API, and Chromium input path. The completion handoff records the actual test outcomes. These checks use local fixture data and do not sign in to an external account.
