# Connect Google Gemini to BLACKICE

**Applies to BLACKICE 2.39.27 and later.** Gemini uses BLACKICE's existing public HTTPS **MCP direct-execution server**, but receives its **own Google OAuth grant**. It does not start a BLACKICE model worker and does not share, replace or revoke ChatGPT's separate authorization.

This is different from selecting **Google Gemini as an API model inside BLACKICE** under Settings → Models. The API model is an outgoing provider connection; the Gemini connector is an **incoming** assistant calling BLACKICE tools.

## Connect

1. Keep BLACKICE and the host's published Tailscale HTTPS endpoint available. Open **Settings → Gemini connector**.
2. Use **Open Gemini connector setup in BLACKICE Browser**. BLACKICE opens Gemini's custom-connector page in its contained browser. The panel shows the actual **Shared MCP endpoint**; use that displayed address rather than guessing a hostname or port. If the endpoint is unavailable, repair the host's [remote-access setup](../REMOTE-ACCESS.md) first.
3. In Gemini, add the BLACKICE direct-execution MCP connector using the host's displayed endpoint, then begin its OAuth authorization.
4. Return to BLACKICE's Gemini panel. Match the **pending Google request code** with the request in Gemini. Select only the capabilities you want, then choose **Allow selected access**. The required read scope stays included; selecting a checkbox is not itself approval.
5. Complete Gemini's redirect and return to **Settings → Gemini connector**. **Check status** should display the Google grant, expiry and scopes. This establishes authorization, **not** successful tool execution.
6. In an actual Gemini conversation with BLACKICE connected, use the panel's **Copy test prompt**, which asks the tool to call `blackice_direct_status` with a nonce. Confirm the same nonce, `available` and `connectionId` from the real tool result.

The settings screen manages only Google requests and Google MCP grants. **Disconnect Gemini only → Confirm disconnect Gemini** revokes that Google grant, not an existing ChatGPT grant.

## What the connection can do

The active BLACKICE server advertises its current direct-tool catalog. Depending on the approved capabilities, Gemini can read plans and action receipts, edit saved plans, inspect or modify local files, inspect or control BLACKICE's contained browser, and run local commands. The 2.39.27 release verified discovery of 36 direct tools and a live `blackice_direct_status` round trip; the catalog can change in a later release.

Execution occurs on the running BLACKICE host. Long actions use durable job receipts; inspect the actual result before treating the requested effect as complete. Do not replay an uncertain submission simply because the model did not receive its first response. A saved connector configuration alone does not establish live availability, model entitlement or successful task execution.

## If something does not work

- **No pending Google request:** confirm Gemini used the exact endpoint shown in BLACKICE and actually started OAuth. Refresh the panel.
- **Request code differs:** do not approve a different request. Restart the intended connection flow and match codes.
- **Connected but no tool result:** select the connector in the Gemini conversation and request the explicit status probe. OAuth status alone cannot confirm a tool invocation.
- **BLACKICE closed or endpoint offline:** start BLACKICE and check Tailscale/publication. The availability responder cannot run tools while the app is closed.
- **ChatGPT still connected:** expected. Each client has an independent grant and can be disconnected separately.

See [2.39.27 release notes](../RELEASE-NOTES-2.39.27.md), [remote access](../REMOTE-ACCESS.md), [ChatGPT-specific setup](../CHATGPT-CONNECTOR.md) and [API providers](API-PROVIDERS.md).
