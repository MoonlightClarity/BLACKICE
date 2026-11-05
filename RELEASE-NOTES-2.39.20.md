# BLACKICE 2.39.20 — MCP discovery compatibility

**5 November 2026.** This source release improves incoming MCP discovery and exact HTTPS authority matching. It adds bodyless OAuth challenges for anonymous HEAD probes and accepts an explicit default HTTPS port while preserving endpoint identity and granted access. Native Mistral Vibe Code and optional model API connections are unchanged.

## HEAD discovery and authorization

A query-free `HEAD /mcp/chatgpt` probe without a valid bearer credential now receives the existing **401** OAuth challenge, including the protected-resource metadata URL and the `read` scope. The probe does not require MCP transport headers or JSON-RPC body parsing. Invalid credentials retain the existing invalid-token challenge and diagnostics.

All MCP HEAD status responses are bodyless. A valid bearer credential still receives **405** with `Allow: POST`; HEAD does not start a stream, parse an MCP request, invoke a tool or create an authenticated tool receipt. Foreign origins, query fields, disabled or closing connectors, and unsupported methods retain their existing rejection rules.

## Exact HTTPS authority matching

When the configured HTTPS origin uses the default port, the owned endpoint accepts both its canonical authority and that same authority with an explicit `:443`. The availability helper and OAuth/MCP gateway use the same comparison. Other hosts, unexpected ports and malformed authorities remain rejected; this change does not broaden origin checks, OAuth scopes or granted access.

## Existing managed connection

The managed Windows availability helper advances from version 6 to version 7 through the existing upgrade path. Persistent Tailscale configuration, the saved endpoint and existing OAuth grants are retained.

On the verification machine, an ordinary BLACKICE application restart completed and the existing helper upgraded from version 6 to version 7 while preserving the endpoint and grant. A Windows reboot was not exercised.

## Verification

Focused regressions cover HEAD challenge ordering, empty response bodies, invalid credentials, unchanged POST-only transport, guard ordering and actual loopback HTTP behavior. Authority regressions cover canonical and explicit-default-port requests while retaining rejection of other hosts, unexpected ports and malformed authorities.

After the application restart, one bounded public IPv4 check passed all 13 cases. It covered valid TLS, OAuth metadata discovery over HTTP/1.1 and HTTP/2 with canonical and explicit `:443` authorities, the bodyless anonymous HEAD challenge, and rejection of the wrong host or port. A Node HTTP/2 request with the explicit default HTTPS port also succeeded.

**Limitation:** Mistral Work is not a supported incoming connection. Its latest website verification returned `server_unreachable` for the correct endpoint; no website OAuth connection or tool call completed.

## Native Mistral Vibe Code retained

The [2.39.19 release notes](RELEASE-NOTES-2.39.19.md) retain the native Mistral reply-recovery, Windows session-save, follow-up readiness and Chat-history changes, together with their observed Planning Off model checks. This protocol update preserves those native behaviors, model identities and application defaults.

## Windows release verification

The complete 2.39.20 Windows source suite and exact-installer checks are required by the [Windows release workflow](SIGNING-AND-RELEASE.md). The matching source-test receipt must bind the final source inventory, and the installer evidence must record the exact Setup hash and installation checks before publication. Source preparation and focused tests do not establish installer publication; existing release assets and earlier receipts remain evidence for their own versions.
