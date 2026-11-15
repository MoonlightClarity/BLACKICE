# Whitelist layout acceptance

Run with an installed Electron binary from the repository root:

    electron verification/whitelist-layout/render.cjs acceptance

This isolated renderer imports the real chat frame and autonomy controls and every stylesheet in production order. The API is a local mock; no user settings are read or changed. It checks desktop/narrow/zoom layouts, horizontal overflow, scrolling, keyboard Space/Tab/Escape, search and cancel/reopen. JSON and PNG evidence goes in the supplied label directory. A successful run prints `rendered acceptance passed`; check that message and result.json because some Windows launch wrappers do not propagate Electron exit codes.

The original failure is a later generic dialog input width rule stretching the whitelist checkbox to the entire row width. Unit selector tests complement this actual Chromium cascade regression; neither is installed-screen acceptance.
