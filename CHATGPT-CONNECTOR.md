# BLACKICE direct ChatGPT connector

## Architecture and setup

ChatGPT owns the conversation and reasoning. BLACKICE supplies direct tools for local files and commands, contained and connected native browsers, browser profile imports, durable action receipts, and saved planning data. The connector does not call a model provider, create a worker turn, or depend on ChatGPT Work computer tools. The experimental BLACKICE-to-ChatGPT browser provider has been removed; the supported direction is ChatGPT calling BLACKICE.

1. Keep BLACKICE and Tailscale running. In **Settings → ChatGPT connector**, choose **Prepare this computer** and confirm public publication when requested. Copy the displayed server URL ending in `/mcp/chatgpt`. Reuse a healthy existing connection.
2. In the intended ChatGPT account, open **Plugins → + → Add custom MCP server**. Name it **BLACKICE connection**, paste this computer's URL, and choose **OAuth** with client metadata discovery (**CIMD**). Discovery should populate BLACKICE's authorization and token endpoints. No manual client ID, client secret or Owner login key is needed.
3. Review the host's warning, choose **Create as a plugin**, then **Connect BLACKICE connection**. Complete **Install** if the host offers that separate step; some flows make the connection available automatically. Do not create another copy just because there is no Install button.
4. On the authorization page, match its request code with the pending request in BLACKICE Settings. Review the permissions. **Select all** checks only this request's offered permissions; it does not approve access. For all supported capabilities, verify **7 of 7 permissions selected**, then separately choose **Allow selected access**. The browser returns to ChatGPT after the local decision.
5. Start a new conversation in ordinary **Chat mode**. Type `@BLACKICE` and choose **Plugins → BLACKICE connection**. A typed name, uploaded source archive, package listing, or Files-only picker does not attach this computer's tools.
6. Send the setup guide's unique status-check prompt in that conversation. Verify the returned nonce, `app: "BLACKICE"`, `mode: "direct-execution"`, `available: true`, `modelStarted: false` and `providerTurns: false`. Inspect `grantedScopes` for the capabilities you approved. Only after seeing that actual matching result, choose **I see the matching result in ChatGPT** in BLACKICE.

These host setup and authentication concepts are covered by [OpenAI's custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server) and [OAuth/CIMD documentation](https://developers.openai.com/plugins/build/auth). Account and workspace policy can affect which controls are available.

New profiles use standard HTTPS port **443**, displayed without a port suffix. Saved **8443** profiles retain their existing URL. Use the exact displayed address; changing the origin invalidates the old grant and requires authorization again. BLACKICE refuses to adopt an unowned root route automatically. A reviewed, explicitly authorized migration must preserve other paths, unrelated routes and their existing public/private exposure. See [Remote access](REMOTE-ACCESS.md).

The connector retains `chatSurfaceVerification: "not-recorded"`; it cannot independently inspect a ChatGPT conversation. The separate setup guide labels its final state as user-confirmed and stores only a nonce, server address, grant identifier, status receipt time and explicit confirmation time in `chatgpt-setup.json`. It stores no access token, refresh token, cookie, authorization code or password. Matching evidence survives an ordinary restart, but is cleared when its grant is no longer active or its address changes. Damaged optional guide history is preserved before regenerating it, without replacing OAuth storage. No authenticated external-account result is assumed by isolated acceptance checks.

## Production startup on Windows

In **Settings → ChatGPT connector**, inspect **After Windows restarts** in the preparation step. Startup setup is included in the Windows desktop app. Its checks distinguish two prerequisites:

| Check | What must be configured |
| --- | --- |
| **Tailscale at Windows startup** | The Tailscale Windows service is **Automatic** and **Running**, and `tailscale get unattended` reports `true`. Current network connectivity alone does not establish unattended startup. |
| **BLACKICE at Windows sign-in** | An enabled entry launches this exact application and profile with `--background` when the current Windows account signs in. BLACKICE remains a desktop application; this entry does not start it before account sign-in. |

Use the offered **Enable automatic connection startup** action, or its Tailscale-only/BLACKICE-only variant, when a missing setting can be configured. Reading or refreshing the checks never changes Windows settings or opens an elevation prompt. Repeated reads share a cached result; an explicit setup action rereads the settings and changes only missing prerequisites. Windows may request administrator credentials if changing or starting the Tailscale service is denied to the current account. This is Windows service authorization, separate from BLACKICE's existing connector scopes and per-tool execution.

The setup preserves the current Tailscale account and other preferences, existing routes, OAuth grants, and unrelated startup entries. It uses the narrow unattended setting in the original user's context, even if a different administrator supplies service-repair credentials. It does not run a broad `tailscale up` command or change node-key expiry. An existing related scheduled task, a disabled or changed BLACKICE startup entry, or an unreadable startup inventory is reported for local inspection rather than overwritten or duplicated. Other repairable prerequisites can still be configured; unresolved checks remain visible.

The **checked at** time records observed settings, not a completed reboot test. Verify the actual connection after the next intended Windows restart and account sign-in with a fresh `blackice_direct_status` nonce in ChatGPT. Keep the computer awake and connected while using BLACKICE. Saved operations still pause after an application restart; inspect their receipts before choosing **Manage schedules → Resume**. Enabling Windows startup does not resume them.

For read-only troubleshooting in PowerShell:

```powershell
Get-CimInstance Win32_Service -Filter "Name='Tailscale'" | Select-Object Name, StartMode, State
& "$env:ProgramFiles\Tailscale\tailscale.exe" get unattended
```

Tailscale documents how Windows unattended mode retains the enabling user's configured profile across sign-out and restart in [Run unattended](https://tailscale.com/docs/how-to/run-unattended). The narrow inspection and settings commands are documented in the [Tailscale CLI reference](https://tailscale.com/docs/reference/tailscale-cli). An unavailable inspection command is an unresolved prerequisite, not evidence that unattended mode is enabled.

## Package installation and native registration

Registering the server through **Add custom MCP server** creates its native ChatGPT App connection. Uploading plugin source or installing a portable MCP package alone does not establish that registration or prove ordinary Chat tool availability. If the picker offers only Files or a different integration, check the native connection in this same account and workspace.

The 1.1.1 private package format can retain portable MCP compatibility while adding the verified native App dependency. Preserve the original package identity, scope and private audience. Copy the exact App mapping returned by verified host discovery; never derive it from a display name, plugin ID or another integration. Public directory submission is a separate workflow, with its own packaging and review requirements. See [OpenAI's packaging guidance](https://developers.openai.com/plugins/build/plugins).

## Repeat use and recovery

Keep the desktop app running while ChatGPT uses it. Ordinary reloads, token refresh and app restarts reuse the existing grant; the setup guide never revokes it merely to retry preparation or open the browser. Reopening a completed authorization URL starts a fresh local decision rather than redirecting with an already consumed code. Direct code replay still triggers the existing replay protection.

Browser launch, route preparation, public checks and confirmation show their actual pending state and a retryable error. Setup opens ChatGPT Plugins in the normal browser. Browser profiles keep their own credentials and sessions. The supported direction is ChatGPT calling BLACKICE tools. The experimental BLACKICE-to-ChatGPT browser provider has been removed. Human ChatGPT conversation tabs and legacy reserved tabs remain excluded from agent and direct connector browser tools.

Concurrent native workers receive task folders and host-owned pages scoped to their task, run and worker node. Related pages can form nested parent/child trees, and each worker keeps its own active-tab selection. Finished workers suspend idle pages while retaining the tree and metadata; pending interactions or downloads can keep a page live. Physical browser actions still run through one serialized queue, and contained pages share the saved website sign-in session. The folders organize ownership; they do not provide separate Windows desktops or isolated website accounts. Direct connector pages use their authenticated grant's ownership scope, independently of native task workers.

An undecided native consent request has no fixed elapsed-time deadline while its browser-bound session and server request remain available. Restarting BLACKICE or losing that browser session can invalidate an unfinished request. Authorization codes and access/refresh tokens retain their normal expiry and replay protections. Existing approved grants survive an ordinary restart; an unfinished consent page is a different state.

## Find the failing step

| What you see | Check and recovery |
| --- | --- |
| **Couldn't discover**, before any consent page | Check the exact displayed URL, public route and host policy. Compare actual ChatGPT discovery with the local gateway's bounded discovery trace. Local endpoint checks alone do not prove ChatGPT reachability. |
| A bare probe returns **406** | Check the request's MCP method and Accept headers. One ordinary browser/HTTP probe is not an MCP handshake. Validate the real catalog exchange and authenticated tool POST before declaring a transport failure. |
| Only **Files**, Avalon, or another integration appears | Register and connect the native **BLACKICE connection** in the intended account, then select it in a new Chat. A package/source upload or similarly named integration is insufficient. |
| A client secret, manual client ID or **Owner login key** seems necessary | Check that this is the native BLACKICE OAuth/CIMD connection. This flow uses none of those manual credentials; a legacy integration's key is a separate authentication system. |
| DOT cannot start a desktop task, or shows **Status unavailable**, while your computer is **Connected** and BLACKICE’s status check succeeds | Keep the working BLACKICE connection and save DOT’s error reference privately. This result alone does not mean BLACKICE authorization expired. Check DOT’s task startup separately; give the reference to support if it continues. The error does not identify its cause. |
| Authorization is invalid or expired | Record whether failure occurred on the consent page, callback, token exchange or tool call. A supplied expired access token receives HTTP 401 so the client can refresh the existing grant. Compare `connectionId` and the connector's `authDiagnostics` before replacing authorization; a host permission failure may never reach BLACKICE. |
| A capability is missing after approval | Inspect the actual connection's `grantedScopes`. Reauthorize for missing scope only when needed. **Select all** affects a pending request only; it does not expand an existing grant. |
| Tool actions repeatedly ask for permission | Check ChatGPT's per-tool confirmation setting. BLACKICE has no local per-action approval setting; actions use the connection's existing scopes. OAuth access consent and website sign-in interactions are separate. Do not reconnect a healthy grant that already has the needed scopes. |
| Public preparation reports an occupied root | Preserve the existing route. Automatic setup refuses unowned roots; replacing a previous service requires explicit migration review and preservation of other paths and exposure. |
| BLACKICE records status, but the result is absent from Chat | Keep verification incomplete. Read the actual result in the intended conversation before confirming the guide. |

In one diagnosed setup, ChatGPT's form failed discovery on the same hostname at **8443** without a completed native discovery trace; standard **443** discovered the native metadata successfully. This is an observed failure before completed native discovery, not an official claim that all nonstandard ports are unsupported. The successful path still required native registration, human consent and a matching authenticated status result in ordinary Chat. Neither a generic authorization error nor a bare 406 response identified that failure by itself.

## Plugin check for each BLACKICE-backed request

For each user request that needs BLACKICE, discover the available tools and call `blackice_direct_status` once with a fresh harmless nonce through the existing authenticated connection. Check the matching nonce, `mode: "direct-execution"`, and actual availability before using the needed tool. The authenticated result includes the caller's own `connectionId` and `grantedScopes`. Compare the required capability with those granted permissions: `supportedScopes` is the server's capability catalog, not authorization for this caller.

Reuse a valid connection and refresh its access token when needed; do not require a new authorization ceremony for every request. Retain the current `connectionId` alongside action IDs so that a later authorization replacement is detectable. An unavailable tool or insufficient grant is a prerequisite to resolve, not permission to substitute a BLACKICE worker or another execution path. This plugin workflow does not automatically attach tools to every ChatGPT conversation. The intended surface must actually discover and invoke the connector.

The status check does not bypass scope enforcement, browser ownership checks, or explicit completion receipts. BLACKICE rechecks authorization at dispatch; a successful earlier status response does not make a revoked or narrowed grant valid for later actions. `localMutationApproval: false` reports that BLACKICE adds no per-action approval prompt. ChatGPT's own permission controls remain separate.

## Transport and authorization

The connector provides stateless MCP Streamable HTTP POST. Clients accept both `application/json` and `text/event-stream`; responses use JSON. The current per-request protocol and supported initialized protocol variants are advertised through discovery. Long actions use durable job polling rather than holding a single HTTP request open or assuming automatic updates into an idle ChatGPT conversation.

OAuth uses the exact owned HTTPS issuer, protected-resource metadata, a resource-bound audience, authorization code with S256 PKCE, and refresh-token rotation. The allowed ChatGPT CIMD identity is `https://chatgpt.com/oauth/client.json`; callback validation uses the metadata's exact redirect URI. The server supports the public-client `none` token authentication method advertised in ChatGPT's current `token_endpoint_auth_methods_supported`, even when its legacy singular preference names `private_key_jwt`. It does not accept an arbitrary client URL, dynamic client registration, a client secret, or a client assertion as a substitute.

OAuth access decisions occur in the authenticated local BLACKICE interface. The public consent page polls using its own cookie-bound pending request and returns the original state and issuer after approval or denial. Permission checks occur again at tool dispatch and before execution. Once connected, requested actions within the granted scopes execute directly without a separate BLACKICE approval choice or prompt. Credentials are never returned by the host management UI; the main authorization store contains only token hashes. Each grant is individually revocable, and disabling the connector revokes its grants. Existing grants survive an ordinary restart; changing the owned resource origin invalidates them. Corrupt authorization storage is preserved and fails closed.

### Access-token renewal during work

Access tokens last up to 15 minutes within a grant's 30-day lifetime. An invalid or expired supplied bearer token receives HTTP 401 with `WWW-Authenticate`, allowing the client to renew credentials. BLACKICE reserves the tool-level OAuth linking signal for missing authorization and additional scopes. Ordinary token renewal preserves the grant ID, scopes, running jobs, and their request IDs.

Concurrent refreshes and retries after a lost response share a 60-second retry window. An identical retry receives the same replacement credentials, with the remaining access-token lifetime. A recently superseded refresh cannot revoke the current connection. Older replay, explicit revocation, and the grant's expiry retain their existing behavior.

On the desktop, this short retry receipt is encrypted with the existing operating-system credential storage and saved before committing token rotation. Restart recovery validates it against the current hashed grant; an uncommitted receipt cannot authorize anything. Without protected storage, retry recovery is memory-only. The optional cache cannot replace or disable valid grants if it is damaged. Status reports the recovery mode and process-local authentication challenge counts without credentials or tool arguments. See the [MCP authorization requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) and [OpenAI token verification guidance](https://developers.openai.com/plugins/build/auth).

| Scope | Capability |
| --- | --- |
| `read` | Connection status, saved plans/groups, and this connection's permitted action receipts |
| `planning:write` | Edit, rename, and group saved plans with revision checks |
| `files:read` | List, read, search, and inspect patch history at requested local paths |
| `files:write` | File writes, patches, undo, and selected attachment imports |
| `commands:run` | Command execution on the host |
| `browser:read` | Inspect ordinary contained tabs and saved-credential metadata for an exact HTTPS origin; the owned ChatGPT calling tab is excluded |
| `browser:write` | Contained-browser actions, password generation and opaque credential filling; upload also requires `files:read` |

The configured working folder supplies the default for relative file paths and command execution. File and upload tools also accept explicit local paths outside that folder. Files and commands use the Windows account's operating-system permissions; the working folder is not a sandbox. Granting command access is a separate OAuth scope. Website sign-in can reuse the native browser's existing session, an imported profile when its protected state remains usable, or the saved-credential path described below. BLACKICE does not decrypt or return passwords from native browser profile files.

## Protected website credentials

When protected storage is available, discovery adds `blackice_credentials_list`, `blackice_credentials_generate`, and `blackice_credentials_fill`. List returns metadata for one exact HTTPS origin under `browser:read`. Generate and fill require `browser:write`. Their execution uses the existing durable job and same-grant request identity rules.

For an authorized signup, generate and durably save a password before filling the form; the user does not need to invent or type one. Keep the returned credential ID and revision. After inspecting the page, fill the exact HTTPS origin, ordinary contained tab, current URL, current document token, and observed password field reference. A confirmation field and saved username field are optional. The host verifies all target fields before decryption and again before writing, and rechecks authorization after queued work. The reserved human ChatGPT conversation tab cannot be a target.

Credential responses contain metadata and execution receipts, never password text. Filling does not click, submit, reset an account, prove registration, or write an external browser password store. Submit only as a separate authorized action and inspect any uncertain outcome before retrying. Existing-account login uses a saved credential; it must not silently generate a replacement password. MFA, website challenges and a missing existing credential can still require the user.

Outbound copying to Chrome, Firefox or Neo is a separate local Password manager action with a temporary native-import file. It is not exposed as a connector tool and does not establish an imported session or independent browser-sync proof. See [BROWSER-PASSWORDS.md](BROWSER-PASSWORDS.md).

## Action identity, recovery, and cancellation

Every asynchronous execution action includes a caller-chosen `requestId`. The durable ledger binds it to the OAuth grant and exact argument digest before dispatch. **An identical retry returns the existing job only within that same grant.** Reusing that ID with changed arguments fails. ChatGPT should retain the authenticated `connectionId`, original request ID, and returned job ID across a connection loss.

An ordinary access-token refresh preserves the grant; a newly approved or replacement authorization has a different `connectionId`. Recheck that identity before retrying an uncertain action. Revoking or replacing access does not transfer the old grant's idempotency identities to the new one: submitting the same `requestId` through a new connection can create another job. Do not replay an uncertain mutation after the connection changes. Inspect the original receipt and resulting effects in BLACKICE first, then decide whether any new work is needed. Possessing an old job ID does not authorize a new grant to read that grant's protected results.

States are explicit: `queued`, `awaiting_input`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, or `interrupted`. Only a settled receipt establishes the action's result. Browser interaction handling and cancellation are separate from completion. Call `blackice_get_job` to read the actual receipt, and `blackice_cancel_job` to request cancellation. A dropped HTTP connection is not a cancellation request.

Writes, imports, browser mutations, uploads, and commands execute directly under the existing connection's scopes. BLACKICE has no local action approval setting. Revoked or insufficient permissions prevent execution. Historical pending approval receipts remain unexecuted and can be cancelled; the change never releases or replays them. Active process and browser operations retain their ownership until they actually settle. A cancellation can stop further work but cannot undo already completed effects; a late successful publication is retained as evidence. Restarted uncertain actions become interrupted and are never silently rerun.

Pending browser interactions are surfaced to the local user. Acknowledgment never replays the original action. ChatGPT must inspect the current page and issue a new, deliberate action after the interaction is resolved. A tab, URL, or document mismatch invalidates stale input ownership.

## Dialogs, uploads, and sign-in

The contained browser captures file-chooser requests, including buttons connected to hidden file inputs. Explicit local file selection uses the existing native picker. Upload requires the exact current chooser or an inspected input reference, checks its tab/document ownership, and validates file paths again at the serialized dispatch boundary. ChatGPT-originated uploads require both `browser:write` and `files:read`.

Electron suppresses native JavaScript dialog windows. When Chromium genuinely leaves a dialog paused, BLACKICE offers guarded accept/dismiss controls, including bounded prompt text. When Electron already cancelled a native dialog, the interface reports a blocked interaction and offers acknowledgment only. HTTP authentication prompts are cancelled and reported as blocked. The current implementation does not pretend these requests completed or offer a universal embedded native-auth dialog.

`blackice_import_file` accepts ChatGPT's file object metadata through `openai/fileParams`, saves a bounded attachment in `blackice-imports` inside the configured working folder, and returns its path, size, and SHA-256 receipt. Public HTTPS download destinations are validated and DNS-pinned; redirects, credentials, private addresses, and oversized transfers are rejected. Temporary download links are excluded from persisted action arguments. Importing an attachment and uploading a file to a website are distinct scoped actions.

The embedded ChatGPT view is optional. Automatic read-only preview recovery follows delayed redirects, same-URL document replacements, and asynchronous form updates. It does not replay uncertain clicks, Enter, or text. This improves native input continuity but does not establish compatibility with every identity provider, browser challenge, or external ChatGPT account.

## Native browser sessions and profile import

`blackice_connected_browser_read` discovers configured native browser connections and their actual tool schemas. `blackice_connected_browser_action` connects the existing Chrome session or calls a discovered browser tool. Chrome, Neo, and imported profiles use the same connection gateway as BLACKICE agents. The existing Chrome connection keeps the original browser profile, extensions, and live site state. Chrome controls its native debugging setup and connection prompt; BLACKICE adds no per-site or per-action approval layer.

`blackice_profile_list` discovers installed Chromium profiles and completed imports. `blackice_profile_import` copies the selected whole profile and relevant root state into a separate managed directory. `blackice_profile_connect` launches that copy with its source browser executable and exposes it through the connected-browser gateway. Imported profiles include extensions and site storage. The source is unchanged; locked or changing sources fail without replacing a completed import. Native encrypted or device-bound data may be unusable in a copied profile, so successful copying and connection never imply website authentication.

Connected-browser discovery requires `browser:read`; arbitrary native browser calls require `browser:write`, `files:read`, and `files:write`, since discovered tools include uploads and screenshots. Profile listing requires `files:read`, copying requires `files:read` and `files:write`, and launching an imported profile requires `browser:write` and `commands:run`. These are the connector's existing OAuth scopes, not additional local approval prompts. Each command returns the same durable job and idempotency behavior as other direct tools.

The local `BLACKICE browser` command line reaches the same host-owned tools and saved jobs. Use `browser --help` for discovery, profile import, native connection, and result inspection commands. It uses BLACKICE's ordinary local session and does not read stored authentication keys.

**Import into Neo…** remains a native browser-data chooser for category-based import. Data imported there belongs to Neo. Connected-browser tools can use that Neo session; contained Electron tabs continue to have their own profile. See [BROWSER-IMPORT.md](BROWSER-IMPORT.md).

## Planning and swarms

The connector reads the same durable plan outline, dependencies, groups, and revisions as the desktop. Active plans are the default. Renaming or regrouping changes organization metadata separately from plan content; stale revisions fail with a conflict rather than overwriting another edit. Editing a plan does not start a worker, clear a stopped worker's interruption, or create a false execution receipt. Swarm summaries expose bounded task/attempt metadata; detailed saved output is retrieved separately.

## Verification boundaries

Isolated acceptance exercises real local HTTP transport, OAuth validation and consent endpoints, durable execution without local action prompts, revocation, and native interface behavior using disposable profiles and deterministic fixtures. These checks do not sign in to a user's ChatGPT account, send email, create a remote worker, or prove discovery and tool invocation from the ordinary ChatGPT conversation.

Local UI and browser fixtures can exercise setup, selection, callback handling and preserved drafts using disposable profiles or owned localhost pages. They cannot prove a signed-in external ChatGPT round trip.

Verify each boundary separately:

| Evidence | What it establishes |
| --- | --- |
| Local metadata/catalog checks | Those endpoints responded from the checking computer. |
| ChatGPT's form discovers the native endpoints | The host's discovery step worked; no grant or tool result is implied. |
| **Allow selected access** in BLACKICE | The owner made the local consent decision; callback and token exchange must still finish. |
| Matching authenticated `blackice_direct_status` result in the intended Chat | That connection completed the direct tool round trip with its reported scopes and availability. |
| **I see the matching result in ChatGPT** | The person confirmed that observed result; BLACKICE does not independently inspect the conversation. |

A status result with all seven `grantedScopes` establishes those permissions for that call. It does not prove that a write, command, browser action or publication completed. Those operations need their own actual receipts. If account policy or client authentication prevents the exchange, report the limitation rather than substituting a worker or endpoint-only test.

Official integration requirements: [ChatGPT custom MCP servers](https://developers.openai.com/api/docs/guides/custom-mcp-server), [plugin authentication](https://developers.openai.com/plugins/build/auth), [connecting a plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt), and [file input metadata](https://developers.openai.com/plugins/reference).
