# Protected provider setup

Provider setup shares BLACKICE's existing direct execution jobs, grant scopes, browser ownership, local-session checks, and provider storage. It does not run a model, select an application default, or accept raw API keys/header values in tool arguments.

## Interfaces

| Tool | Actions | Existing scopes | Result |
| --- | --- | --- | --- |
| `blackice_provider_read` | `list`, `catalog` | `read` | Sanitized connections, or paged provider catalog metadata |
| `blackice_provider_configure` | `save`, `test` | `commands:run` | Saved nonsecret settings, or credential/catalog test receipt |
| `blackice_provider_import_key` | `click_inspect`, `inspect`, `import` | `commands:run`, `browser:read`, `browser:write` | Protected source metadata or encrypted import receipt |

Each action takes a stable `requestId`. Inspect the saved job after an uncertain result. An identical same-ID retry reads that job; a changed request under the same ID is rejected. Never invent a new ID to repeat an uncertain key-generation click.

The authenticated local frontend can POST `/api/providers/setup` with `{tool:"read"|"configure"|"import_key", arguments:{...}}`. It uses these same tools and the existing local browser client through the direct-job ledger. GET `/api/providers/setup/jobs/:jobId` reads that local client's receipt. The adapter rejects remote HTTP proxy requests; remote callers use their existing direct-tool grant. It is not an arbitrary API proxy. These routes inherit the server's current session and Origin validation.

## Key generation and transfer

1. Use normal observed browser controls to reach the provider's key form and complete its nonsecret fields. Do not use a normal click for the final Create/reveal operation: normal browser actions can return an automatic page snapshot.
2. Call `click_inspect` with the exact observed contained `tabId`, HTTPS `origin`, `expectedUrl`, `expectedDocumentId`, and button `ref`. It durably marks this dedicated tab as protected before one existing guarded trusted click. A host-only option suppresses the automatic result snapshot. The result contains source refs and generic field metadata, never the key or page text.
3. If the site renders the key later, call `inspect` on the same exact HTTPS URL. It performs no click. It returns the current `documentId` and candidate source refs for visible key-labelled/read-only fields, code blocks, and token-shaped text leaves. Cross-origin frames are excluded. Generic labels, element types, dialog membership, and value presence are returned; values and nearby page text are not.
4. Save the destination provider's nonsecret configuration through `configure/save`. For a new provider, use `expectedUpdatedAt:null`; for an update, use the exact `updatedAt` from its current saved metadata. Save only the intended model IDs. No default-selection action exists in this interface.
5. Call `import` with that provider ID/current `updatedAt` and the selected source's exact URL/document/ref. The host checks current encryption availability before source access and before commit. It rechecks existing grant authority, tab ownership, the HTTPS origin, current frame/document lineage, and the unchanged selected source value. Only a host callback receives the key, then calls `runtime.saveProvider` with encrypted storage required. Tool arguments, receipts, and job storage contain no key bytes.
6. `configure/test` verifies credentials/catalog only. Its receipt explicitly has `modelAccessVerified:false`. A separately requested model run is needed to demonstrate actual inference or tool access.

Protected tabs retain their privacy marker across persistence/restart and pass it to native child tabs. Agent snapshots and screenshots are masked; agent tab/interaction metadata omits dialog text and URL paths/queries that could contain secrets. The local human's native Chromium view remains usable. A protected tab remains protected until it is closed; open a separate ordinary tab for subsequent browsing.

The protected source operation stays on its exact HTTPS URL. If a click redirects, changes the source, opens a modal challenge, or fails to settle, it returns a sanitized uncertain result. This does not establish that key generation failed. Inspect the provider and protected source; do not replay the click automatically. Import consumes the observed source once. After a failed or uncertain import, inspect the saved provider before obtaining a fresh source observation.

## Masked key displays with Copy controls

Protected `inspect` reports `sourceKind:"copy_control"` only when one visible, enabled Copy control is associated with one visible masked code/pre display in the same dialog. The result contains the guarded ref, generic label, `keyDisplayMasked:true`, and `requiresCopyClick:true`. The masked display is never a key value. An empty source list does not establish whether creation succeeded; verify the new record in a separate normal list tab and preserve the original one-time display. Do not regenerate automatically.

Use the existing `import` action with the Copy source's exact ref/document/URL and destination provider revision. The host installs a temporary `navigator.clipboard.writeText` interceptor in that exact same-origin frame, dispatches one guarded trusted Copy click with automatic snapshots suppressed, and passes its captured value only to the existing encrypted host-save callback. The OS clipboard is never read. Source element, display, dialog, masked display value, frame lineage, and provider revision are checked again; a normal Copy-to-Copied label change is allowed. Multiple writes, changed sources, invalid/masked values, or an untrusted click cannot produce an imported value.

The supported `writeText` call is intercepted before it reaches the OS clipboard. A page that uses a cached native method, `clipboard.write`, or another copying mechanism is unsupported for capture; that separately authorized Copy action can still have a native clipboard effect, but BLACKICE does not read it or claim the import succeeded. After any uncertain import, inspect the saved provider before trying a newly observed source. Never repeat Create to recover an import.

The interceptor is restored and its captured value erased after take, cancellation, failure, or a bounded page deadline. Cleanup also covers a lost prepare response. No raw key appears in tool arguments, source metadata, errors, receipts, or saved direct jobs. Local synthetic tests exercise the actual import wrapper so a lost Copy response retains `actionDispatched:null` instead of claiming no click occurred.

## Configuration and catalog semantics

Custom OpenAI-compatible providers use `preset:"compatible"`, `type:"compatible"`, and an explicit `baseUrl`. Anonymous endpoints need no key. Optional `endpoints:{models:"/models",chatCompletions:"/custom/chat"}` overrides replace the corresponding paths on that same API origin; omitted endpoint settings preserve saved paths, an explicit object replaces them, and `{}` restores standard paths. Endpoint values cannot contain a second origin, credentials, queries, fragments or traversal segments. Catalogs may be top-level arrays or the existing `data`/`models` arrays. A dedicated model `id` keeps its separate human-facing `name`; when `name` itself supplies the ID, `description` may supply the display label. Explicit display-name fields take priority. Saved conversations bind their inference endpoint, so changing that path cannot silently send an earlier conversation to the new route. Changing only the catalog path invalidates discovery without changing conversation identity. No provider-specific preset or routing shortcut is added for a test target.

Provider updates compare `expectedUpdatedAt` inside the existing serialized store mutation. Timestamps advance monotonically, including multiple writes in one clock tick. The active-provider guard is checked again at the commit boundary. Cancellation before commit prevents a write; cancellation after commit begins can leave a completed save, which must be inspected rather than described as absent. Imported secrets require the existing native encrypted storage and are never silently downgraded to session-only storage.

Catalog discovery preserves provider-reported pricing strings, observation time, supported parameter names, and the `:free` suffix indicator. `freeOnly:true` requires the suffix plus complete, explicitly zero prompt/completion prices and zero values for every reported price field. Unknown, incomplete, and nonzero prices are excluded; numeric underflow cannot make a positive price appear zero. This filter describes the observed catalog, not account eligibility, quotas, future prices, or measured model behavior. `toolsOnly` retains the existing catalog behavior, which allows unknown tool support; inspect the returned `supportsTools` and `supportedParameters` rather than treating listing as a successful tool-call test.

Validation uses synthetic pages, keys and temporary encrypted provider stores. It covers the actual direct schema/ledger and shared HTTP adapter, stale references, reserved/other-owner tabs, guarded click uncertainty, secret-bearing dialog masking, encrypted persistence, provider revision races, cancellation boundaries and free-price classification. No test calls a real model or creates an external account/key.
