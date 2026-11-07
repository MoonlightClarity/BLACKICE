# BLACKICE 2.39.27 — Gemini connector and independent ChatGPT access

## Gemini integration
- Add **Settings → Gemini connector**, separate from **Settings → ChatGPT connector**.
- Connect Google Gemini to BLACKICE through the existing public HTTPS MCP endpoint. Gemini discovers the same 36 direct-execution tools; no second MCP server or model worker is required.
- Display only Google's own OAuth grant, expiry, permissions, and pending requests in the Gemini panel. Allow approvals and a clearly confirmed **Disconnect Gemini only** action without changing ChatGPT's authorization.
- Open Gemini's custom-connector setup directly in BLACKICE Browser and provide a copyable real-tool status probe.
- Fix permission-selection handling by reading each checkbox's current state rather than assuming all permissions are selected.

## Connection verification
- Tested a live Gemini conversation calling `blackice_direct_status` through **BLACKICE Direct Execution**, including a matching nonce and independent Google grant ID.
- Rechecked ChatGPT with its original authenticated grant and all seven permissions intact.
- Added regression tests for independent grants, Google-only revocation, exact OAuth scope selection, contained-browser setup, and Settings navigation.
- The public Windows installer bundles the Gemini settings module and registers it as a normal static asset.

## Installation
Install **Blackice-2.39.27-Setup.exe**. Existing profile, ChatGPT grant and Google grant are separate from the packaged application and are not intentionally reset by this update. Keep BLACKICE running and its public HTTPS endpoint available for remote MCP calls.

This is an unsigned Windows installer unless a publisher signing configuration is supplied.