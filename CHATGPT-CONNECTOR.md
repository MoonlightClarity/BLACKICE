# Connect ChatGPT to BLACKICE

ChatGPT can call BLACKICE's authenticated tools over MCP while BLACKICE runs on your Windows computer. The ChatGPT conversation does the reasoning; ordinary direct file, command, browser, and task operations do not launch another BLACKICE model. Explicit start-chat or goal tools can launch one.

## Connect

1. Start BLACKICE and sign in to Tailscale. Open **Config → App connections → ChatGPT**, select **Prepare this computer**, and explicitly confirm publishing the authenticated endpoint if needed.
2. Copy the exact address BLACKICE displays (ending in /mcp/chatgpt). Do not guess the hostname or port.
3. In ChatGPT on the web, open **Plugins → Add custom MCP server**. Use the displayed address, OAuth and client metadata discovery. Create/connect the custom BLACKICE plugin.
4. When ChatGPT redirects for authorization, compare its request code with **BLACKICE → Config → App connections → ChatGPT**. Approve only the matching request. The current connection grants the available BLACKICE tool catalog; there are no per-tool approval checkboxes.
5. Attach the installed BLACKICE plugin in the intended ChatGPT conversation. Send the unique status prompt from the BLACKICE setup panel.
6. Confirm that the real tool response returns a matching nonce, app BLACKICE, mode direct-execution, available true, and modelStarted false. OAuth authorization or a displayed tool list alone does not establish a working connection.

A connection stays associated with its address and grant. Reuse a healthy one; do not repeatedly create duplicate plugins. If ChatGPT shows old tools, use **Refresh tools** in the existing plugin settings.

## Address and startup

New public configurations normally use HTTPS 443 through Tailscale Funnel. An existing configuration can retain its saved port. If both 443 and 8443 are occupied, an explicitly configured port 10000 can be used without replacing unrelated routes. Use the actual address shown by BLACKICE.

The Windows host and BLACKICE must be running for tools to work. Tailscale unattended mode and BLACKICE's Windows sign-in startup option are independent; verify each if you need availability after a restart. Closing BLACKICE does not turn this into a cloud-hosted agent.

## Tools and recovery

- Read the tool catalog and granted scopes from a live status result, not an old note or screenshot.
- Local commands and file changes run on the user's host. Treat their effects as real, including when a model incorrectly claims failure.
- Long actions return durable job IDs. Read their settled results before retrying an operation; an interrupted response does not prove the effect failed.
- Browser actions require current page identity and observed controls. After a stale-page rejection, take a new snapshot; if dispatch was uncertain, inspect the destination before repeating it.
- Changing the published address or revoking the OAuth grant can require a fresh connection. Disconnecting one external client does not automatically revoke another client's independent grant.

For optional API and local-model settings *inside* BLACKICE, use **Config → Models**. These are distinct from incoming ChatGPT tool access.

## Limits

The connector does not guarantee that every ChatGPT plan supports the same plugin controls, that every model can use tools reliably, or that external websites accept every action. Verify actual destination results. BLACKICE's browser-provider experiment that attempted to run ChatGPT as an internal model is retired; this document describes ChatGPT calling BLACKICE.
