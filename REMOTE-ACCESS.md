# Remote access

BLACKICE can expose its running Windows workspace to a remote human browser or an external agent. Tool execution, credentials, and saved state remain on the host. The host must be running and reachable.

## Network setup

For the guided ChatGPT connection, open **Config → App connections → ChatGPT → Prepare this computer**. Sign in to Tailscale first. BLACKICE shows the HTTPS address it has actually configured.

- **Private:** Tailscale Serve exposes the service to permitted devices on the tailnet.
- **Public:** Tailscale Funnel exposes an authenticated endpoint to external clients. Confirm publication explicitly.

New configurations normally use HTTPS 443; existing profiles may retain another port. Port 10000 can be selected explicitly when 443/8443 are occupied. BLACKICE should not overwrite unrelated routes or silently change their exposure. Public reachability does not bypass authentication.

## Connect an external assistant

For ChatGPT, connect the displayed /mcp/chatgpt endpoint as a custom MCP plugin using OAuth, approve the matching pending request in BLACKICE, and verify a live status tool call. Gemini uses an independent Google OAuth grant through **Config → App connections → Gemini**. An OAuth connection, browser pairing, and manual agent credential are different authorization paths.

For manually paired agents, BLACKICE provides one-use codes and credentials from its host-side remote CLI. Codes expire and are consumed; credentials should be stored privately and can be revoked. Legacy scope arguments do not necessarily narrow an agent's actual access—inspect the granted permissions returned by the host.

## Pair a browser

When a remote route is already enabled, the installed Windows executable can issue a one-time human-browser code:

    & "$env:LOCALAPPDATA\Programs\BLACKICE\BLACKICE.exe" --access-code

Open the displayed address in the remote browser and enter the code. Browser pairing is not a full remote Windows desktop. Host-native controls remain local, and browser sessions can be revoked separately.

## Recovery

If the connection fails, inspect BLACKICE's displayed route, Tailscale state, and the specific grant before changing the endpoint. An offline network does not mean the grant was revoked. A previously running task or external submission might still have taken effect; read the saved job receipt or destination state before repeating it.

Do not expose private tokens, pairing codes, or downloaded credential files in repository documentation or shared logs.
