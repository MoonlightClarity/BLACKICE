# ChatGPT connector interruption diagnostics

The ChatGPT host, BLACKICE OAuth, direct execution, and website authentication are separate layers. An interruption at one layer does not show that a permission expired at another.

## Capture the advertised catalog

An authenticated `blackice_direct_status` response and local connector status include `toolCatalog`:

- `sha256`: SHA-256 of the UTF-8 bytes of `JSON.stringify(tools)`, where `tools` is the exact ordered array returned by `ChatGPTConnector.tools()` and advertised by `tools/list`.
- `toolCount`: the number of advertised definitions.
- `serverVersion`: the application version advertised by the connector.

The digest includes names, descriptions, schemas, annotations, security schemes, metadata, and their serialized ordering. It contains no grant IDs, tokens, request arguments, status nonces, timestamps, job state, or page content. Diagnostics are returned in status, never added to tool definitions, so reading the fingerprint cannot itself change the catalog. Save the returned fingerprint with the incident evidence; it is suitable for comparison across calls and restarts.

The current catalog is assembled at startup. Native restart availability can affect which tools are registered. Credential-tool definitions are registered independently of vault health; each execution checks current protected-storage availability and returns an unavailable result when necessary. Connected-browser/profile adapters can also affect the catalog in builds that provide them. Once registered, ordinary status probes, token refreshes and job activity do not change the definitions. Public discovery advertises the full catalog; each call separately validates its actual grant and required scopes.

Application version alone is insufficient to compare development builds: an installed source update can change tool definitions without changing the version string. Compare the exact catalog hash as well. A matching source-derived fixture hash is evidence about that source and its modelled startup capabilities; it is not a measurement of a live host cache.

## Identify the layer

| Evidence | Interpretation |
| --- | --- |
| The ChatGPT host rejects a prepared call because its tool catalog changed, before returning any BLACKICE result | A host catalog-generation check rejected that prepared invocation. Refresh discovery and preserve the exact action identity. BLACKICE cannot alter the host's approval decision. |
| HTTP `401` with a `WWW-Authenticate` invalid-token challenge | The supplied access credential is invalid or expired. The client can refresh within the existing grant. The server admits no action before validation. |
| A tool result with `mcp/www_authenticate` and an insufficient-scope challenge | The authenticated grant lacks a scope required by the requested action or saved result. Catalog discovery does not grant that scope. |
| `localMutationApproval:false` in direct status | BLACKICE adds no separate local approval to a new action authorized by the existing OAuth scopes. |
| A saved legacy job has `awaiting_input` with `interaction.kind:approval` | This is an older receipt. It is preserved and never automatically replayed. Inspect existing effects before cancelling and replacing old work. |
| An observed website dialog, security-key challenge, or operating-system chooser | This belongs to the website or native integration, independently of connector action approval. |

Local connector status also exposes process-local `authDiagnostics` counters for invalid bearer credentials, linking challenges, scope challenges, and authorization lost before admission. They record only the challenge category, time, request method, response status and tool name. They do not retain credentials, headers, arguments, URLs, or token fingerprints. A restart resets these counters; record their observation time alongside any saved evidence.

For a recurring incident, retain the exact host error, timestamp, catalog hash and count, server version, whether the connection ID stayed the same, current granted scopes, `localMutationApproval`, relevant challenge counters, and any returned job ID. Never collect bearer tokens or refresh tokens for this diagnosis. A host rejection and a server OAuth challenge can both happen before job creation, so absence of a job ID alone does not distinguish them.

## Recover without duplicate execution

After a confirmed host catalog rejection, refresh the available tool definitions and reissue the same authorized action with identical arguments and the same `requestId` while the connection ID remains unchanged. If a BLACKICE job ID was returned, read that durable job first. A lost response does not establish that an action failed. After a connection change, inspect prior effects before submitting new work, since request identity is scoped to the original grant.

The public catalog omits the optional `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` classification fields, matching the original Currents connector on this point. It does not replace them with read-only or non-destructive claims. Tool descriptions, schemas, OAuth requirements, and host action preferences continue to describe and control the actual operations. A changed catalog alone does not establish that repeated host approval prompts are fixed.

## Deployment and rollback compatibility

The access-token retention update preserves unexpired access tokens when another refresh issues a replacement. After activation, a persisted grant can contain more than four access-token records. Older OAuth loaders accept at most four records per grant and check that limit before filtering expiry, so they cannot read that state even after those records expire. A post-activation rollback must retain an OAuth loader compatible with the stored records and preserve the existing grants and tokens; restoring the older OAuth source alone is insufficient.

An installer rollback before activation is a different case: if the previous process is still running and the updated runtime has not written authorization state, restoring the previous application files does not introduce this state-format incompatibility. Record whether activation occurred when choosing a rollback procedure.

## Rebuilt connector boundary

The `direct-connector-v2` implementation separates the wire protocol, tool catalog, and OAuth admission. `blackice_direct_status` returns `integration` and the same bounded `authDiagnostics` counters as local connector status. This identifies the loaded implementation without issuing a command or exposing credentials.

Each request uses one catalog snapshot for discovery metadata, required scopes, and dispatch. The native catalog contains 28 tools. After omitting optional classification hints its fingerprint is `a2d2816177291775572f39b0694e6acc30973c00073bc45f05e58cc1165859b2`; the prior catalog with hints had fingerprint `e005a0eba62989d59498e014efffaf8b43a3b2bb9b5f77100aa4ca46e138748d`. The endpoint, supported protocol versions, tool schemas, full accepted operations, persisted OAuth format, and durable job format are preserved. Initialization does not create or reset grant state.

Optional status and setup observers cannot delay or replace an accepted action's response. Only explicit BLACKICE authorization errors produce connection challenges; a destination service's HTTP 401/403 remains an action error. If the same live grant loses a required scope before dispatch, the response identifies the missing scope rather than invalidating a valid access token.

The plugin package builder reads an existing package and writes a separate candidate. It aligns the direct MCP fallback name with the existing hosted App declaration, preserves App ID and connection settings, and synchronizes portable and legacy manifests. The hosted route remains bound to the same App; a standalone MCP client that keys its token cache by the renamed fallback may need to select that route again.

Validation covers independent MCP clients, token refresh under the same grant, receipt reads after reconstruction, same-ID retries without repeated effects, observer failures, the full catalog fingerprint, and package preservation. These checks establish BLACKICE behavior. A ChatGPT-hosted approval dialog still requires observation across actual user turns before reporting the repeated-prompt issue as fixed.
