# Connect Claude to BLACKICE

Claude uses BLACKICE's existing Streamable HTTP MCP endpoint and receives its **own OAuth grant**. It does not replace the ChatGPT or Google/Gemini connections. This is an **incoming** assistant connection; it is different from configuring Anthropic as an outgoing model provider inside BLACKICE.

## Set up

1. Keep BLACKICE and its published HTTPS endpoint available. Open **BLACKICE → Settings → Claude connector**.
2. In BLACKICE's contained Browser, sign in to [Claude](https://claude.ai/). Under **Customize → Connectors**, add a **custom connector**.
3. Use a name such as **BLACKICE Direct Execution** and paste the exact **Shared MCP endpoint** displayed in BLACKICE. The endpoint may end in `/mcp/chatgpt` for historical compatibility; **that route serves all supported MCP clients**, not just ChatGPT.
4. Choose **Sign in now**. BLACKICE supports Claude's published OAuth client identity at `https://claude.ai/oauth/mcp-oauth-client-metadata`, verified against Claude's exact callback address. Other supported clients can register dynamically.
5. Match the code on the Claude authorization page to the **pending Claude request** under **Settings → Claude connector**, then choose **Connect Claude**. The page must direct you to the **Claude**, not ChatGPT, Settings tab.
6. Return to Claude and ask it to use **BLACKICE Direct Execution** to call `blackice_direct_status` with a fresh nonce. Verify that Claude returns the exact nonce, `available: true`, its own `connectionId` and the live tool count.

A successful OAuth callback confirms authorization, **not** a tool call. Validate the actual tool result before declaring the connection operational. The connector has been tested with all 36 tools advertised on BLACKICE 2.39.28.

## Authorization and tool access

- **Connect/disconnect is the BLACKICE authorization decision.** Once a client has a valid grant, it can call the complete published BLACKICE tool catalog, including plans, files, browser actions and local commands.
- BLACKICE advertises `read` as its single MCP **transport OAuth scope** for compatibility with clients that request only that scope. The server still retains legacy scope metadata for stored tokens and internal job receipts; it does **not** require separate user-facing capability selections.
- ChatGPT, Claude and Google/Gemini each have **independent grants**. Disconnecting one from its matching Settings tab does not revoke the other two. Restarting normally preserves completed grants, while a pending approval page may need to be reopened.
- **Claude has its own per-tool approval controls.** Claude may ask **Allow once** or **Always allow** on first use. These choices belong to Claude and cannot be suppressed by BLACKICE's OAuth scope settings. This is distinct from BLACKICE's removed permission checkboxes.
- Website sign-in prompts, file selectors, and other operating-system or website interactions may still require user input. A successful tool authorization never proves an application submitted a file or finished an action.

## Other connectors

See [Gemini connector](GEMINI-CONNECTOR.md) and [ChatGPT connector](../CHATGPT-CONNECTOR.md). All three use the same installed BLACKICE MCP tool server, but have separate client identity and grant records.

## Browser sign-in behavior

BLACKICE's contained browser follows a newly observed OAuth popup from the currently selected opener. When that popup closes, selection returns to its surviving opener rather than switching to an unrelated task tab. The browser preserves unrelated tasks and their tabs.
