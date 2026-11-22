# Remote access for people and agents

BLACKICE exposes one running workspace through two interfaces: the normal browser application for a human, and an authenticated MCP/REST connection for an outside agent. Both use the same chats, durable plans, run results and registered artifacts. Model execution, tool access and credential storage happen on the host computer.

## Enable an address

For the current desktop's guided public setup, open **Config → App connections → ChatGPT** and use **Prepare this computer** with its explicit publication confirmation. Tailscale must be installed, signed in and connected on that host. The guide reports the endpoint and connection checks.

The underlying remote service retains the two modes below. The current Config workspace does not expose a separate **Remote access** tab; private Serve configuration and manual pairing remain retained service/CLI interfaces. The pairing commands in this guide require an already-enabled, ready route.

| Mode | Clients that can connect | Transport |
| --- | --- | --- |
| Private | Devices connected to your Tailscale network and permitted by its access rules | Tailscale Serve HTTPS |
| Public | Browsers and outside agents with internet access | Tailscale Funnel HTTPS |

Public setup requires an explicit choice to publish the authenticated BLACKICE endpoint to the internet. Human browsers still pair, and outside agents still need their own credential. New profiles use standard HTTPS port **443** by default. For hosts whose 443 and 8443 HTTPS routes are already reserved, local `BLACKICE chatgpt prepare --confirm-public --https-port=10000` explicitly opts into Tailscale Funnel HTTPS port **10000**. BLACKICE refuses to replace an unowned root route or change the public/private exposure of other paths. Disable an existing enabled HTTPS route before selecting a different port; no saved URL is silently migrated. Other paths, such as an existing Vision route, and unrelated ports remain intact. If the Tailscale account does not permit Serve, HTTPS or Funnel, the setup result reports the failure; the desktop application stays available.

With the default **443** configuration, the displayed address has the form `https://your-computer.your-network.ts.net`, without a port suffix. An explicitly selected **10000** endpoint includes `:10000`. Existing saved profiles using **8443** retain their address, such as `https://your-computer.your-network.ts.net:8443`; they are not silently migrated. Use the exact address displayed by the running app. Enabling or switching access does not create a client credential automatically.

## Temporary connection loss

An already-enabled route retains its saved hostname, public/private mode, HTTPS port, and client authorizations if Tailscale is temporarily offline at startup. The local application remains usable, and remote admission stays closed until the same route is verified again.

BLACKICE checks a ready route every 30 seconds. Known transient preflight failures retry after 1, 2, 5, 10, 30, then at most once every 60 seconds while the saved intent remains enabled. These offline attempts only inspect transport state; they do not reset grants or switch exposure. **Check connection** can request an earlier retry.

A changed hostname, conflicting route, unreadable configuration, or failed verification after a route operation does not enter automatic recovery. Inspect the reported error locally. **Disable** and application shutdown cancel scheduled recovery, and a disabled profile never reconnects itself. Recovery does not promise availability while the computer, network, or Tailscale service is unavailable.

## Connect ChatGPT

For ordinary ChatGPT Chat mode, use **Config → App connections → ChatGPT** to prepare the public route and register the displayed address ending in `/mcp/chatgpt`. This connection uses separate OAuth authorization: begin connection in ChatGPT, match the pending code in BLACKICE, and choose **Connect with full BLACKICE access** for the matching request. Changing the server address requires fresh authorization.

After connecting, select BLACKICE in the intended Chat conversation and send the setup guide's unique status-test prompt. Confirm the guide only after the matching nonce and actual status result appear in that conversation. Successful endpoint discovery alone does not prove that ChatGPT can invoke the tools. See [Direct ChatGPT connector setup](CHATGPT-CONNECTOR.md) for the full steps.

## Connect Gemini

Use **Config → App connections → Gemini** for Gemini's incoming connection, independently from the **ChatGPT** guide. Google Gemini uses the same already-published HTTPS MCP server, but its Google OAuth request, granted scopes, expiration and revocation are separate from ChatGPT's grant. Adding or disconnecting Gemini does not authorize, replace or disconnect ChatGPT.

Open Gemini's connector setup from BLACKICE's **Gemini connector** panel, use the **Shared MCP endpoint** displayed there, match the Google pending authorization code, and choose **Connect Gemini**. Then verify a real `blackice_direct_status` tool result from Gemini; a successful OAuth grant alone is insufficient evidence of execution. The panel includes a copyable nonce probe and a two-step **Disconnect Gemini only** action.

See [full Gemini setup](docs/GEMINI-CONNECTOR.md) and [2.39.27 release notes](RELEASE-NOTES-2.39.27.md).
## Connect a human browser

1. On the host, run the `BLACKICE --access-code` command below for the already-enabled route.
2. Open the displayed HTTPS address on the other device. You can also copy its pairing link.
3. Enter the one-use code and give that browser a recognizable name.
4. Use the web-accessible Chat, Cronjobs, Browser, Skills and Config surfaces. Controls requiring the host's native window remain local; the remote interface is not a second Windows desktop.

Pairing codes expire after five minutes. A successful pairing consumes the code. Browser sessions expire after 30 days and use a Secure, HttpOnly cookie. The host lists each paired browser separately; **Revoke** disconnects that browser and closes its ongoing remote streams.

Normal server-based model and connection settings remain available subject to the gateway's route restrictions. Network publication, remote credential management, profile maintenance and controls requiring a host-native window stay on the host. The former Email workspace is retired; retained endpoint code is not evidence of a current mailbox or email-draft UI. **Disconnect this browser** ends its own session.

## Connect an outside agent

Use the native **agent code** command below and redeem its code into an agent credential. The plaintext credential is returned only at redemption unless the helper saves it to the requested private connection file. BLACKICE stores the credential hash and retains the client's name and expiration time.

New paired agents receive the full retained `read`, `tasks:write`, and `planning:write` capability set. The legacy `--scope` option is accepted for compatibility and does **not** narrow that access. The gateway still enforces host-only management routes; pairing is not permission to create new credentials through those blocked routes. The manually paired `/mcp` catalog below is distinct from the OAuth direct-tool catalog at `/mcp/chatgpt`.

An agent credential expires after 30 days and can be revoked independently. Use Public mode when the outside agent cannot join the private Tailscale network.

### Let an agent create and redeem a code

An agent with access to the host computer can issue a code through the installed BLACKICE command, then redeem it directly. The code is the grant: there is no second confirmation in BLACKICE after it is issued. The host can be running with its window visible, in the background, or in headless mode.

For a person connecting from another browser, the shortest host command is:

```powershell
& "$env:LOCALAPPDATA\Programs\BLACKICE\BLACKICE.exe" --access-code
```

It prints the address, one-use code, pairing link, permissions and expiration times. Add `--json` for a machine-readable receipt. Browser codes retain the normal browser pairing flow.

For an agent that needs to build an app or start other work, issue an **agent** code:

```powershell
$blackiceExecutable = "$env:LOCALAPPDATA\Programs\BLACKICE\BLACKICE.exe"
$grant = & $blackiceExecutable remote code --kind agent --json | ConvertFrom-Json
```

The agent can use that receipt without asking the person to copy or retype the code. On the connecting computer, redeem the code through standard input:

```powershell
$connection = $grant.code | & $blackiceExecutable remote pair "--url=$($grant.url)" --code-stdin "--name=App builder" --output app-builder.json --json | ConvertFrom-Json
```

This example saves the credential in a private connection file and returns its path, client identity, permissions, expiration and MCP/REST endpoints. An agent can read that file to configure its connection. On Windows, files live under `%APPDATA%\BLACKICE\connections`; the command sets and verifies a current-user-only ACL before redeeming the code. `--output` accepts a filename, never an arbitrary project path, and refuses to overwrite an existing connection. Other supported client platforms use the per-user configuration directory with private file permissions.

For an agent that manages its own credential storage, omit `--output` and retain `--json`: the redemption response returns the bearer credential once. Without `--json`, redemption saves a private connection automatically and prints its location. Codes are accepted only through standard input; error messages and desktop diagnostics do not include them or the bearer credential.

Agent codes use the full retained capability set. Legacy `--scope=NAME` arguments do not restrict newly paired agents. Use the shown `--url=` and `--name=` forms with the native Windows executable; these keep values inside their option. Code type and session expiration are fixed when the host issues the code; redemption does not renew the expiration. An agent code cannot become a browser session, and a browser code cannot become an agent credential. Issuing a fresh code replaces the previous unredeemed code, and every code expires within five minutes and works once. A lost redemption response is reported without automatically retrying or issuing another code.

Use `--profile-dir ABSOLUTE_PATH` on a host code command to select an already running custom profile. The command verifies the existing runtime record, process and owned loopback listener, then uses BLACKICE's normal authenticated local routes. It does not create a profile, activate the existing window, or enable network publication. Remote access must already be enabled at the address the host returns. Host discovery currently targets the Windows desktop/headless runtime; agent redemption does not need a running local BLACKICE instance.

No separate Node installation is required. Agents can also invoke the bundled `scripts/remote-access-cli.mjs` with the installed BLACKICE executable and child-only `ELECTRON_RUN_AS_NODE=1`, using the same commands and JSON responses. `remote --help` describes the options without opening a profile or contacting a server.

### MCP connection

Configure a **Streamable HTTP** client with:

| Field | Value |
| --- | --- |
| Endpoint | The displayed address followed by `/mcp` |
| Authorization header | `Authorization: Bearer <agent credential>` |
| Accept header | `application/json, text/event-stream` |
| Content type | `application/json` |

The server supports MCP **2026-07-28**, **2025-11-25** and **2025-06-18**. Current clients use per-request metadata, `MCP-Protocol-Version`, `Mcp-Method` and, for a tool call, `Mcp-Name`. Legacy clients use `initialize` and their negotiated version. Tool calls return JSON promptly; task execution continues in BLACKICE and is followed by reading the returned run ID. There is no legacy HTTP+SSE endpoint or MCP session identifier.

Client software must support a user-configured bearer authorization header. The `/mcp` endpoint uses manually configured bearer credentials; the separate `/mcp/chatgpt` endpoint offers the OAuth flow described above. This is not a claim that every hosted agent connector accepts manually configured credentials.

The retained manually paired agent endpoint exposes this catalog. New paired agents receive its full capability set; inspect the actual schema for the running version:

| Tool | Purpose |
| --- | --- |
| `blackice_status` | Runtime availability, execution capacity, current client identity and permissions |
| `blackice_models` | Compact, searchable, paginated model choices |
| `blackice_list_tasks` | Saved tasks and plan summaries; active by default, with explicit archived/all filters |
| `blackice_get_task` | The exact durable plan, revision, readiness, artifact records and current editing/worker-read awareness |
| `blackice_get_run` | Execution status, worker statuses and a bounded result window |
| `blackice_read_output` | A paginated run result or individual worker output |
| `blackice_read_artifact` | Registered file bytes up to 1 MiB, returned as base64 |
| `blackice_edit_plan` | Atomic edits to the same plan shown in the human application |
| `blackice_start_task` | Submit a task with a stable retry ID |
| `blackice_continue_task` | Continue a settled run in an active chat |
| `blackice_cancel_task` | Request cancellation while preserving saved results and notes |

### REST connection

REST uses the same bearer header, authenticated client identity and gateway route restrictions. `GET /api/agent` returns the scoped tool schemas and connection instructions. Paths below are relative to the displayed HTTPS address.

| Method and path | Request/result |
| --- | --- |
| `GET /api/agent/status` | Runtime state and this client's scopes |
| `GET /api/agent/models?query=&limit=40&offset=0` | Compact model list |
| `GET /api/agent/tasks?query=&state=all&limit=40&offset=0` | Search active and archived saved tasks; explicit `state=deleted` lists Trash summaries |
| `GET /api/agent/tasks/:taskId` | Exact shared plan |
| `POST /api/agent/tasks` | `{task, requestId, model?, effort?, planningMode?}` |
| `GET /api/agent/runs/:runId?offset=0&limit=12000` | Status and paginated output |
| `GET /api/agent/runs/:runId/output?nodeId=&offset=0&limit=12000` | Run or worker output; omit `nodeId` for the final result |
| `POST /api/agent/runs/:runId/continue` | `{message, requestId, nodeId?, model?, effort?, planningMode?}` |
| `POST /api/agent/runs/:runId/cancel` | `{}` |
| `POST /api/agent/tasks/:taskId/plan` | `{expectedRevision, operations}` |
| `GET /api/agent/tasks/:taskId/artifacts/:artifactId` | Registered download, bounded to 128 MiB and checked against the recorded file hash |
| `GET /api/agent/events` | SSE notifications of run/worker/plan changes; refetch state after a reconnect |

Do not put a token in a URL. This example assumes `BLACKICE_URL` and `BLACKICE_REMOTE_TOKEN` have been supplied to an outside process:

```js
const base = process.env.BLACKICE_URL;
const headers = {
  Authorization: `Bearer ${process.env.BLACKICE_REMOTE_TOKEN}`,
  'Content-Type': 'application/json',
};
const response = await fetch(`${base}/api/agent/tasks`, {
  method: 'POST', headers,
  body: JSON.stringify({
    task: 'Inspect the current workspace and summarize the remaining work.',
    requestId: 'workspace-review-001',
    planningMode: 'on',
  }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error);
// Save result.runId and result.taskId; read /api/agent/runs/:runId for progress.
```

Give each intended start or follow-up a stable `requestId`. After a connection failure, resend the exact same arguments with that ID. IDs are scoped to the issuing credential, and the normal engine's durable request receipt returns the already admitted run. Reusing an ID for different work fails. This prevents duplicate task admission; it does not make arbitrary external side effects inside a model run inherently repeatable.

### Editing the shared plan

Read the task and its current protocol first. A plan write requires the saved `revision` as `expectedRevision` and operations from the running endpoint's schema. A new canonical task at revision 0 uses `create_contract` with a complete contract; an existing canonical plan uses `replace_contract` as its sole operation. The host retains its plan epoch and execution evidence. Legacy graph plans retain `add`, `update`, `remove`, `move`, `dependencies`, `choose` and `metadata` where their schema permits them.

The following is a **legacy graph-plan example**, not a canonical-contract recipe:

```json
{
  "expectedRevision": 12,
  "operations": [
    {"type": "metadata", "patch": {"layout": "parallel"}},
    {"type": "add", "step": {
      "id": "document-access",
      "title": "Document the verified connection",
      "kind": "action",
      "parentId": null,
      "doneWhen": "A new client can follow the checked connection steps."
    }}
  ]
}
```

A stale revision returns HTTP 409 with `currentRevision`. MCP returns a tool error with that same information. Read the current task and reconcile before retrying. Graph validation rejects cycles, dangling dependencies, unsupported ownership changes and completion claims without the required evidence. An external agent is recorded by its verified credential name; a client cannot claim a different author through request JSON.

Plan reports remain separate from runtime receipts. Marking a step done cannot make an active worker finish, release its execution slot or bypass a real upstream worker. A plan edit also does not silently start a model call.

Unsaved text remains in the human browser. A short-lived, identity-bound presence notice identifies the step being edited. Saving publishes a revision event; native BLACKICE workers must read relevant corrections before their next affected attached tool action. Other parallel scopes remain runnable. Outside clients can follow `/api/agent/events`, including compact `planning.awareness` invalidations, then fetch the task and its `planningAwareness` field. The stream has no replay, so refetch after reconnecting. An outside API read does not fabricate a native worker acknowledgement, and BLACKICE cannot gate operations that an outside agent performs independently. Native Codex built-in tools are also outside the attached-tool guard. A plan save does not interrupt an in-flight command; use explicit task cancellation or conversation directions to control active execution. See [PLANNING-AWARENESS.md](PLANNING-AWARENESS.md).

## Background and headless operation

**Run in background** hides the current desktop window without stopping its runtime. Reopen BLACKICE normally to display the same instance. To start without a main window:

```powershell
& "$env:LOCALAPPDATA\Programs\BLACKICE\BLACKICE.exe" --headless
```

The source project also supports `npm run headless`. Electron remains responsible for the saved profile, native credential encryption and contained browser tooling. `node server.mjs` remains a separate developer server; it does not replace the desktop profile/runtime.

For deliberately separate profiles, `--profile-dir=<absolute path>` selects an isolated profile before the single-instance lock is acquired. It creates a new workspace and does not import the normal profile's history or credentials. Omit this flag for your normal BLACKICE session.

The host must stay on, signed in and able to reach its providers. This mode is not a Windows service and does not promise work through shutdown, sleep or account logoff. Quit preserves the existing cancellation, draining and scheduler-pause behavior. Remote configuration persists for the next start; failed remote startup leaves the local application available with a visible status error.

## Connection references

- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and [Serve command reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [MCP Streamable HTTP, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [Electron app lifecycle and single-instance behavior](https://www.electronjs.org/docs/latest/api/app)

## Availability while BLACKICE is closed

An enabled BLACKICE profile keeps a small availability responder and its existing owned HTTPS route after the application exits. The main application still owns all execution, model work, browser sessions and OAuth writes. The responder only forwards requests while that application is connected, or returns its availability status. It never starts the application, queues work, replays actions or starts at Windows boot by itself. Explicitly disabling remote access removes the route and stops the responder.

Authenticated connector status distinguishes `closed`, `starting`, `closing` and `unreachable`. A refused HTTP connection alone does not establish that the application is closed. A local lifetime connection clears the proxy target when its owning application disconnects; reopening attaches the new application generation to the same responder and route. Existing grant IDs and scopes are preserved.

An offline action response reports that no action was admitted when the request was never sent. If the connection was lost after delivery may have begun, its outcome, model-start and provider-turn fields are unknown. Read the existing durable job after BLACKICE returns, or retry identical arguments with the same request ID under the same grant. The responder does not replay the request.

Offline authentication reads the existing access-token hashes. Token refresh returns `temporarily_unavailable` until BLACKICE reopens; the responder does not rotate or revoke credentials. The computer and Tailscale must remain reachable for these messages to arrive. Shutdown, sleep, account logoff or a network failure can still prevent an application-level response.
