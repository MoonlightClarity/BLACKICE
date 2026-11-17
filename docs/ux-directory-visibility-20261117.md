# Directory live progress visibility audit

The existing live status summary is outside collapsed Details. Do not add a duplicate summary. The initial screenshot defect reproduced because a missing visuals endpoint left an empty visible Conversation visuals section below the transcript. Its 78px footprint made bottom-follow scroll the summary above the viewport. A complete empty-success endpoint already worked unchanged.

This patch hides that empty shell at construction and on conversation-owner switch. Same-owner visible content remains during refresh/failure; errors still notify. Ledger, filter defaults, tool events, data and models are untouched.

Verification: 8 focused node tests pass. Actual hidden Electron fixture, synthetic data only: .build/ux-flows-resume-20261117/verified-visual.mjs and goal-mode-visual.json. At 1400 and 760 widths the live summary is visible with Details closed even when visuals fails. Screenshots directory-visible-1400.jpg and directory-visible-760.jpg inspected. Long activity stays bounded to140 characters; manually scrolled-up position remains unchanged on new activity. Goal pause/resume, repeated dialog opening, interrupted resume also passed. Missing other fixture endpoints still show notifications and are not production findings. This does not establish all Directory UX issues solved. No installed app/profile/release changed.
