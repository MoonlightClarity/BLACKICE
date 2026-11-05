# ChatGPT Bridge — not offered

BLACKICE 2.24.0 removes the ChatGPT Bridge from the product surface. Unattended end-to-end operation was not verified, so the application does not advertise it, attach `relay_chatgpt`, load its saved settings or start its listener.

The old HTTP route family responds with `410 FEATURE_NOT_OFFERED` after local authentication and origin checks. The Bridge UI and stylesheet are not served. Historical request and settings files remain on disk without being read or changed on startup. Old implementation modules and tests remain as historical compatibility evidence; they do not provide a supported integration or setup flow.

In the current development source, use the selected native Codex or Mistral Vibe Code account connection, or an optional configured API provider, for BLACKICE tasks. The separate incoming [ChatGPT MCP connection](CHATGPT-CONNECTOR.md) lets ChatGPT call BLACKICE tools; it does not revive this retired Bridge. Browser work uses BLACKICE's browser; email is accessed through its ordinary web interface. The Thunderbird/Himalaya adapter is retired. Reintroducing this retired browser-driven Bridge would require verified end-to-end operation and a fresh explicit product decision.
