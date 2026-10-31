# Remote access for people and agents

BLACKICE exposes one running workspace through two interfaces: the normal browser application for a human, and a scoped MCP/REST connection for an outside agent. Both use the same chats, durable plans, run results and registered artifacts. Model execution, tool access and credential storage happen on the host computer.

## Enable an address

Open **Settings → Remote access** on the computer running BLACKICE. Tailscale must be installed, signed in and connected on that host. **Check connection** reports its current state.

Choose the reachability you need, then enable it:

| Mode | Clients that can connect | Transport |
| --- | --- | --- |
| Private | Devices connected to your Tailscale network and permitted by its access rules | Tailscale Serve HTTPS |
| Public | Browsers and outside agents with internet access | Tailscale Funnel HTTPS |

Public mode has a separate **Publish the authenticated BLACKICE endpoint to the internet** selection. Human browsers still pair, and outside agents still need their own credential. New profiles use standard HTTPS port **443**. BLACKICE refuses to replace an unowned root route or change the public/private exposure of other paths. Other paths, such as an existing Vision route, and unrelated ports remain intact. If the Tailscale account does not permit Serve, HTTPS or Funnel, Settings reports the failure; the desktop application stays available.

For new profiles, the displayed address has the form `https://your-computer.your-network.ts.net`, without a port suffix. Existing saved profiles using **8443** retain their address, such as `https://your-computer.your-network.ts.net:8443`; they are not silently migrated. Use the exact address displayed by the running app. Enabling or switching access does not create a client credential automatically.

## Connect ChatGPT

For ordinary ChatGPT Chat mode, use **Settings → ChatGPT connector** to prepare the public route and register the displayed address ending in `/mcp/chatgpt`. This connection uses separate OAuth authorization: begin connection in ChatGPT, match the pending code in BLACKICE, and have the local owner approve the needed permissions. Changing the server address requires fresh authorization.

After connecting, select BLACKICE in the intended Chat conversation and send the setup guide's unique status-test prompt. Confirm the guide only after the matching nonce and actual status result appear in that conversation. Successful endpoint discovery alone does not prove that ChatGPT can invoke the tools. See [Direct ChatGPT connector setup](CHATGPT-CONNECTOR.md) for the full steps.

## Connect a human browser

1. Select **Create pairing code** in the host's Remote access settings.
2. Open the displayed HTTPS address on the other device. You can also copy its pairing link.
3. Enter the one-use code and give that browser a recognizable name.
4. Use the same Chat, Planning, Activity and Settings workspace from the remote browser.

Pairing codes expire after five minutes. A successful pairing consumes the code. Browser sessions expire after 30 days and use a Secure, HttpOnly cookie. The host lists each paired browser separately; **Revoke** disconnects that browser and closes its ongoing remote streams.

Normal server-based model and connection settings, connected mailbox reads, and local email drafts remain usable by a paired human. Email setup and OAuth authorization, network publication, remote client credential management, profile maintenance and controls that require a host-native window stay on the host. **Disconnect this browser** ends its own session.

## Connect an outside agent

In host Settings, open **Connect an outside agent**, enter a name, select its permissions and create the credential. Copy it immediately: the plaintext credential is shown only when it is created. BLACKICE stores its hash, and lists the client's name, permissions and expiration time.

| Permission | What the agent can do |
| --- | --- |
| `read` | Inspect runtime availability; search models and saved tasks; read plans, outputs and registered files; follow change events |
| `planning:write` | Edit the shared visual plan at an expected revision |
| `tasks:write` | Start authorized work, continue a settled chat, and request cancellation |

An agent credential expires after 30 days and can be revoked independently. It cannot call the broad browser/desktop API or create more credentials. Use Public mode when the outside agent cannot join the private Tailscale network.

### Let an agent create and redeem a code

An agent with access to the host computer can issue a code through the installed BLACKICE command, then redeem it directly. The code is the grant: there is no second confirmation in BLACKICE after it is issued. The host can be running with its window visible, in the background, or in headless mode.

For a person connecting from another browser, the shortest host command is:

```powershell
& "$env:LOCALAPPDATA\Programs\BLACKICE\BLACKICE.exe" --access-code
```

It prints the address, one-use code, pairing link, permissions and expiration times. Add `--json` for a machine-readable receipt. Browser codes retain the normal browser pairing flow.

For an agent that needs to build an app or start other work, issue an **agent** code with explicit task permissions:

```powershell
$blackiceExecutable = "$env:LOCALAPPDATA\Programs\BLACKICE\BLACKICE.exe"
$grant = & $blackiceExecutable remote code --kind agent --scope=read --scope=tasks:write --json | ConvertFrom-Json
```

The agent can use that receipt without asking the person to copy or retype the code. On the connecting computer, redeem the code through standard input:

```powershell
$connection = $grant.code | & $blackiceExecutable remote pair "--url=$($grant.url)" --code-stdin "--name=App builder" --output app-builder.json --json | ConvertFrom-Json
```

This example saves the credential in a private connection file and returns its path, client identity, permissions, expiration and MCP/REST endpoints. An agent can read that file to configure its connection. On Windows, files live under `%APPDATA%\BLACKICE\connections`; the command sets and verifies a current-user-only ACL before redeeming the code. `--output` accepts a filename, never an arbitrary project path, and refuses to overwrite an existing connection. Other supported client platforms use the per-user configuration directory with private file permissions.

For an agent that manages its own credential storage, omit `--output` and retain `--json`: the redemption response returns the bearer credential once. Without `--json`, redemption saves a private connection automatically and prints its location. Codes are accepted only through standard input; error messages and desktop diagnostics do not include them or the bearer credential.

Agent codes default to `read`. Repeat `--scope=NAME` at issuance to select the existing permissions listed above. Use the shown `--scope=`, `--url=` and `--name=` forms with the native Windows executable; these keep colon-containing values inside their option. Code type, permissions and the session's expiration are fixed when the host issues the code; redemption cannot widen them or renew the expiration. An agent code cannot become a browser session, and a browser code cannot become an agent credential. Issuing a fresh code replaces the previous unredeemed code, and every code expires within five minutes and works once. A lost redemption response is reported without automatically retrying or issuing another code.

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

The tool catalog is filtered by the authenticated client's permissions:

| Tool | Purpose |
| --- | --- |
| `blackice_status` | Runtime availability, execution capacity, current client identity and permissions |
| `blackice_models` | Compact, searchable, paginated model choices |
| `blackice_list_tasks` | Saved tasks and plan summaries; active and archived by default |
| `blackice_get_task` | The exact durable plan, revision, readiness, artifact records and current editing/worker-read awareness |
| `blackice_get_run` | Execution status, worker statuses and a bounded result window |
| `blackice_read_output` | A paginated run result or individual worker output |
| `blackice_read_artifact` | Registered file bytes up to 1 MiB, returned as base64 |
| `blackice_edit_plan` | Atomic edits to the same plan shown in the human application |
| `blackice_start_task` | Submit a task with a stable retry ID |
| `blackice_continue_task` | Continue a settled run in an active chat |
| `blackice_cancel_task` | Request cancellation while preserving saved results and notes |

### REST connection

REST uses the same bearer header and the same permission checks. `GET /api/agent` returns the scoped tool schemas and connection instructions. Paths below are relative to the displayed HTTPS address.

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

Read the task first. A plan write requires its saved `revision` as `expectedRevision`, with 1–100 edit operations. Supported operations are `add`, `update`, `remove`, `move`, `dependencies`, `choose` and `metadata`. MCP's tool schema gives their complete supported fields. For example:

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
