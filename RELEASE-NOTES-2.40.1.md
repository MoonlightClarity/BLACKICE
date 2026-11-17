# BLACKICE 2.40.1 candidate

This update improves existing features rather than adding another layer of workflow.

## Changes

- Browser folders are part of one compact tab strip instead of a duplicate list above it. Folder groups collapse, nested paths remain visible, icons retain their width, and keyboard focus survives refreshes. Narrow address controls wrap without squeezing the page. Existing folder persistence and tab ownership are unchanged.
- Swarm now presents tasks in an Excel-style grid across workflows, with row/column addresses, arrow-key navigation and editable cells. Task, owner and folder edits use existing operations. Selection survives updates; pending edits cannot be changed underneath a save. This is not a formula engine or a full Excel replacement.
- Passwords has human-facing reveal and copy controls for a selected saved credential. Leaving the view clears the revealed value; clipboard failure offers a keyboard fallback. No passwords are included in this release.
- Tools can search the public MCP Registry for server connections. Results show package information and setup links; supported HTTP results prepare a connection draft. Searching does not install software or connect an account. Unsupported endpoint shapes remain manual setup.
- Local-model setup includes a Hugging Face search and a ready-to-copy recommendation prompt. The bundled llama.cpp picker still loads GGUF. Other formats require an appropriate external runtime; this update does not invent new format support or download models.
- Native Codex controls now sit together with the account settings instead of inside Optional API connections. Closing that API section no longer disables the native controls.

## Verification and limits

The integrated runtime source passed 376 focused tests and disposable rendered checks for the browser, Swarm, passwords/tools and model discovery.

A complete Windows suite reported 9,252 tests: 9,240 passed, one failed and 11 skipped. The single failure was an unchanged storage-recovery test; its immediate exact-test rerun and full 32-test file both passed without code changes. Its cause is unconfirmed and the original failure remains recorded. This is not a claim of a completely green full suite. Skips include opt-in live fixtures and one unavailable Windows symlink fixture.

Version metadata and these notes were updated separately after runtime qualification. Packaging and disposable checks are recorded separately; these notes do not claim a live install, publication, real provider validation, live registry connectivity or OS clipboard validation.
