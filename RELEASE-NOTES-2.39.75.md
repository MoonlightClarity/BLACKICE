# BLACKICE 2.39.75 — Goal continuation fixes

Goal mode now reliably resumes the updated objective when a queued automatic turn is superseded before it starts. The rejected turn remains in history, and only the replacement turn counts toward the goal allowance.

Rejected wait requests leave existing progress and completion evidence unchanged. Invalid retry dates or unavailable execution handles no longer clear a valid completion report or count as progress.

This release retains the Goal controls, slash commands, same-conversation continuation, pause/resume behavior, and conversation browser tabs introduced in 2.39.74.
