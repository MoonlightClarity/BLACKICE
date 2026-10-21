# BLACKICE 2.30.0

## Agent-managed pairing and reliable Copy

- Generate a browser or scoped agent access code from the installed BLACKICE command, including while the host runs headlessly.
- Return the address, code, permissions and expiration as JSON so an authorized agent can create and redeem the grant without asking a person to relay it.
- Redeem agent codes through standard input and save a named connection in a private per-user file. The grant needs no second BLACKICE approval after issuance.
- Keep the code's client type, permissions and credential expiration fixed. One-use redemption, explicit disconnect and existing remote publication settings remain in effect.
- Run command dispatch before profile locking or window creation, using the bundled Electron runtime without a separate Node installation.
- Use a shared Copy implementation with native desktop support and a browser selection-copy fallback. A denied write offers a usable message and preserves the source, drafts, selection and scroll; success is shown only after a completed copy.

The agent-facing workflow is: create the requested app, obtain a scoped code from the running host, redeem it and save the connection, then verify the connected identity. See [REMOTE-ACCESS.md](REMOTE-ACCESS.md). Client software must support the returned MCP/REST endpoint and bearer credential; creating a grant does not configure an arbitrary external service automatically.

## Experimental Chat Mode in the main chat

- Offer **ChatGPT Chat Mode**, labeled **Experimental**, in the normal model picker, with a stable saved route and an explicit availability state.
- **Open ChatGPT** selects its dedicated contained tab in Observe; **Check connection** checks the advertised tools and readiness. Paired human browsers can use these same actions.
- Preserve ordinary model metadata and draft choices; show the route used by a recorded response independently of the next-reply selection.
- Use advertised, document-bound browser tools through the existing contained debugger connection. Navigation invalidates old handles, and an uncertain submission is never resent automatically.

The native WebMCP transport has been exercised with an owned local page. A production ChatGPT response decoder and successful ChatGPT answer have not been verified, so this release keeps that route unavailable for agent turns with a visible explanation. It does not claim a working subscription-backed provider. The old separate ChatGPT Bridge workspace remains retired.

## Shared editing awareness

- Show short-lived human editing presence for individual plan steps without transmitting unsaved text.
- Show the saved revision delivered by each worker's real plan read, and whether a newer relevant correction requires review.
- Require a fresh plan read before affected attached BLACKICE tools execute after relevant saved changes.
- Keep independent parallel work runnable, preserve real in-flight operation results, and maintain actual dependency readiness after a read.
- Preserve focused inputs, draft text, Save controls and scroll while collaboration status changes.
- Expose awareness in the outside-agent task response and compact event stream without creating native worker acknowledgements for external reads.

The architectural direction remains a **semi-structured process knowledge graph**. Current typed process relationships support execution; flexible notes and evidence carry context. First-class reusable facts, assumptions, decisions and semantic knowledge relationships are future work.

The runtime guard applies to BLACKICE's attached tools. Native Codex built-in tools and independent outside-agent operations are outside that dispatch boundary. A plan-read receipt establishes delivery, not comprehension. See [PLANNING-AWARENESS.md](PLANNING-AWARENESS.md).

## OAuth email

- Keep Himalaya 2.2.1 as the background mail engine and add managed browser sign-in for Google/Gmail and Microsoft/Outlook.
- Suggest an installed Himalaya executable automatically. Keep existing external TOML setups in the advanced section.
- Use a BLACKICE-owned provider application registration, PKCE, state validation and a local callback.
- Store refresh credentials through Electron encrypted storage; refresh tokens without placing credentials in UI snapshots, events, command arguments or the managed TOML file.
- Keep email registration, successful authorization, the local CLI check and observed mailbox access as separate status evidence.
- Restrict email authorization and setup to the host; paired humans can use connected mailbox reads and local drafts remotely.

Connecting a real mailbox still requires a provider application registration and browser consent. Google Testing registrations with Gmail scopes have a seven-day refresh-token lifetime. Read-only mailbox access and local drafts remain the implemented email capabilities. See [EMAIL.md](EMAIL.md).

## Verification and installation

Use the timestamped reports bundled with the update to assess the exact candidate. Planning tests exercise real blocked/permitted local operations and rendered human-edit flows. OAuth tests use controlled provider transport and verify callback/refresh/secret-handling behavior; they do not establish access to a user's real account.

The update is applied only to the measured source and installed application files after confirming the live runtime is idle. Original changed files are retained for recovery. The separate user profile, existing external mail configuration and connector settings are preserved. This update does not rebuild the Windows Setup executable.
