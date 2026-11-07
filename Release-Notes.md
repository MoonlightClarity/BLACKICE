# BLACKICE 2.39.25

Unsigned Windows hotfix tested and installed locally on November 6, 2026.

Fixes:
- Show recorded error messages and codes for failed runs, including HTTP 429 provider rate limits.
- Continue the same conversation after failure with another model, including failed-before-agent-start cases.
- Start a fresh provider session for a changed API model instead of reusing its earlier session.
- Remove the UTF-8 BOM that caused Electron main-process JSON parse failure.

Validation:
- 43 focused source tests passed, including simulated HTTP 429 to alternate-model recovery.
- Repaired installer was installed locally and BLACKICE 2.39.25 reconnected with existing profile.
- The package is unsigned and has not passed the full public release workflow or clean-install verification.
- The provider can still reject oversized prompts when token-per-minute budgets are exceeded.

Source code: https://github.com/MoonlightClarity/BLACKICE/tree/main
Exact source tag: v2.39.25.
