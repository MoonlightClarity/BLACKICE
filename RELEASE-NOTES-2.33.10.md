# BLACKICE 2.33.10: responsive browser scrolling

This patch improves visible wheel and trackpad feedback in the contained browser preview.

The 2.33.9 preview waited 250 milliseconds after an input receipt, then paused queued input while it refreshed browser status and captured a frame. This release gives manual scrolling a lightweight preview path so new gestures can continue while the view updates.

The existing tab, document, ownership, cancellation and protected-credential checks remain in place. Page controls stay tied to an explicitly observed document. The focused Planning, Swarms and Schedules workspaces and BLACKICE visual hierarchy are retained.

## Installation and verification

Use the 2.33.10 Setup installer to update the registered Windows program. Source and installer evidence must identify the exact source commit, application fingerprint and Setup SHA-256. The release includes the recorded Windows installation checks; source verification also records sustained scrolling measurements against 2.33.9. Recorded checks establish the tested scenarios and do not promise the same frame rate on every website or computer.
