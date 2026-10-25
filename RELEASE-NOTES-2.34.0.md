# BLACKICE 2.34.0 — combined V2 release candidate

**Candidate only.** This build is unsigned and unpublished until release acceptance. Preserve the installed 2.33.13 rollback, browser drafts and saved conversations.

## Interface

- V2 replaces the legacy startup shell at **/**. The classic interface remains at **/legacy/** and is linked from Settings and the startup recovery screen.
- Independent Chat, Planning, Tasks, Browser, Activity, Knowledge and Settings rendering lifecycles.
- Chat uses a background worker for archived conversation parsing, bounded turn rendering, and streaming text updates; no bulk execution archive on the UI thread.
- Model-specific reasoning effort and Fast/Standard controls, preserving selections across reload. Saved task milestones, artifact previews and download links appear on demand.
- Activity includes a bounded interactive workflow graph editor, per-agent model/context/planning settings, descriptive assignments and explicit run, retry and stop controls.
- Knowledge includes native memory/skill editing, revision history, recovery and conflict handling.
- Settings includes General, Identity, Models and Tools. Provider connections, exact Codex model IDs, guarded Identity history, individual tool servers and JSON/file tool-configuration import work within V2.
- The desktop Browser displays the actual Chromium page, with direct typing, mouse interaction, native pickers, downloads, Back/Forward/Reload and keyboard shortcuts. Separate Type/Send key/Read/Refresh view controls belong only to the compatibility fallback.
- Blank tabs have independent saved IDs. Address submission navigates the same tab, saved selection survives reload, and unfinished addresses remain separate for each tab. Website/proxy HTTP authentication stays available during pending navigation and workspace changes.
- Ordinary local-file and Chromium page addresses are accepted. Human tab organization can move branches between personal/task folders, and human-created tabs are no longer limited to eight personal pages. Existing total resource budgets still apply.
- Email is accessed through Browser; Thunderbird/Himalaya integration remains retired.

## Native integration and diagnostics

- Incorporates dot's two picker commits in order (221d66a1, c632c56d), preserving guarded page-world showOpenFilePicker, native-compatible file handles, denied writes and path privacy.
- Electron renderer-death window disposal is deferred beyond native process notification callbacks.
- Native process diagnostics and local-only Crashpad are enabled with no report upload. Crash dumps can contain private process memory and should not be shared automatically.
- No per-action sandbox or least-privilege restriction is introduced for BLACKICE agent execution. BLACKICE remains open source and operates under user-provided host authority.

## Remaining compatibility limits

- Rich artifact preview works for text and raster images. Native document opening, SVG and advanced document previews, and editing remain in classic tools.
- Broader physical input/IME, drag-and-drop and arbitrary Win32 app/dialog/DPI compatibility still require native acceptance. Automated browser fixtures stay hidden.
- Remaining account/configure tools and methods remain available through the classic interface.
- Background task routing and protected credential screenshot behavior still differ from direct human browsing; this release does not claim every historical browser policy has been removed.
- The historical native EXCEPTION_BREAKPOINT has not been reproduced with a real minidump; mitigation and synthetic real-Electron cleanup tests passed.

## Release safety

This candidate is not the installed BLACKICE 2.33.13. Do not deploy while another installer or live file-picker operation is active. Produce one authoritative Setup.exe, checksum and app fingerprint. Test the exact packaged executable with a disposable profile before any controlled replacement of production. On failure, restore 2.33.13 and the preserved profile.
