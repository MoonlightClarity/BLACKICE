# BLACKICE 2.39.18 — Native Mistral Vibe and optional model connections

**5 November 2026.** This source release adds Mistral Vibe Code as a native account connection, discovers its account model catalog, and makes compatible optional API connections actionable in BLACKICE. It also repairs contained-browser navigation and input, and extends the incoming MCP connector's OAuth client support.

## Native Mistral Vibe Code

- Connect the separately installed official Vibe CLI under **Settings → Models → Mistral Vibe Code**. Sign-in opens in BLACKICE's contained browser. **Refresh connection and models** updates the account status and catalog; an unconfigured connection also has a setup action in the Chat model picker.
- Discovery enables Vibe's official account model catalog and checks the models and reasoning controls advertised by ACP sessions. It preserves exact model identities and merges duplicate entries only when the catalog confirms their alias relationship.
- The existing Medium alias remains available to saved conversations. Refreshing a catalog, signing in, or adding a connection preserves the current application default and each saved conversation's selected provider and model.
- Explicit Vibe selection runs independently of Codex startup. Saved native sessions keep their working folder and history; an explicit model change uses the normal conversation handoff. BLACKICE supplies the session's attached tools through its owned MCP bridge, with ambient CLI tools, hooks, skills and connectors isolated.

The account catalog observed during verification supplied these choices:

| Model | Native model identity | Reported reasoning choices |
| --- | --- | --- |
| Mistral Large 4 | `mistral-vibe::mistral-large-4-0` | Low, Medium, High |
| Mistral Medium 3.5 | `mistral-vibe::mistral-medium-3.5` | None, High |
| GLM 5.3 Flash (Mistral Hosted) | `mistral-vibe::zai-glm-5-3-flash` | Low, High, Max |

Catalog membership and account access can change. These observed entries do not establish entitlement for every account, and BLACKICE does not substitute the separate Mistral API catalog or a fixed list of guessed IDs. The hosted GLM entry is labelled **GLM 5.3 Flash**, matching its reported identity.

Each model retains its own reasoning choices and catalog metadata. Catalog context limits are labelled separately from runtime-observed working windows; remaining context stays unknown until the runtime reports the relevant usage. Vibe manages context automatically. **Model default** is supported; manual compaction and custom context presets or thresholds remain unavailable. An existing custom draft stays visible until the user explicitly chooses **Use native automatic context**.

## Optional API connections and Chat

- Native account connections, **Mistral API**, **OpenRouter** and other compatible API endpoints have separate setup paths. API configuration is optional; native, local and anonymous connections do not acquire an unnecessary API-key requirement.
- A configured but disabled compatible API connection offers an explicit **Enable** action in Settings and the model picker. Missing credentials remain actionable setup information. Intentional disablement, saved defaults and per-chat model identity are retained.
- The Mistral API preset uses the official endpoint. Its discovered chat choices require reported chat-completion capability; archived, embedding, OCR and other non-chat entries are excluded. Tool, vision and context metadata are preserved without inventing output limits.
- Chat and Settings receive the shared provider-availability module through the static asset allowlist, fixing the dynamic-import failure that prevented those workspaces from opening after the connection changes.

## Contained browser repairs

- The address display follows the contained tab's current navigation and redirects while preserving an address draft being edited.
- Page-opened tabs have an independent lifetime. Closing their opener or another tab does not silently close them.
- Guarded keyboard input reaches contained pages while their browser pane is inactive. Select-all/delete and printable-key presses deliver the expected key events; temporary input focus is cleaned up after the action.

These are targeted browser fixes. Website sign-in, human verification, and site-specific form behavior retain their own requirements.

## Incoming MCP authorization and its remaining limit

The incoming connector supports dynamic OAuth client registration with public clients, HTTP Basic client authentication and POST client authentication, alongside ChatGPT's existing client metadata identity. Exact redirect checks, PKCE, scoped authorization and individual client grants remain enforced. The availability helper preserves existing grants through its normal upgrade and restart path and provides bounded local diagnostics for early request rejection.

**Incoming Mistral Chat MCP remains blocked in the tested setup.** Mistral's external reachability check failed before a request reached BLACKICE. Protocol-side authorization support and local regression tests do not establish a working end-to-end Mistral Chat connection. No authentication policy was weakened to bypass that failure.

The incoming **Mistral Chat → BLACKICE MCP** route, the native **Mistral Vibe Code** connection, and the optional **Mistral API** connection remain separate. Native Vibe operation does not require the incoming chat gateway.

## Verification and Windows distribution

The installed BLACKICE UI exposed the three native choices with their own reasoning lists and completed a real request for each. Medium also completed a BLACKICE workspace-read tool check. The checks preserved the saved default and provider configuration; they did not change account billing or upgrade an account.

Focused regressions cover account-catalog discovery, alias continuity, native session and tool routing, operation while Codex is unavailable, optional API activation, context controls, browser tab/input behavior, OAuth client handling, and the actual served Chat/Settings module graph. Synthetic overlay checks exercise exact-file guards and rollback; those local recovery scripts and private profile artifacts are excluded from publication.

The Windows artifact is **Blackice-2.39.18-Setup.exe**, built through the existing unsigned-release workflow. The complete Windows source gate and verification of the exact installer are separate release requirements. Use the source-test receipt and installer evidence attached to the matching release for their final counts, source identity and artifact hashes. Earlier receipts or local application overlays do not substitute for those checks. See [Windows releases](SIGNING-AND-RELEASE.md).

The stable application identity and retained profile directory are unchanged. Existing conversations, provider settings, defaults and authorized grants remain subject to the normal update-preservation checks.
