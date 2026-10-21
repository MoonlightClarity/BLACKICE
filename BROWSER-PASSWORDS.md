# BLACKICE saved passwords and browser copying

## Intended flow

BLACKICE owns the saved credential and can help copy it into the user's normal browser password manager. Its model receives an opaque credential ID and revision; the host generates and stores the password. An authorized signup can therefore proceed without asking the user to invent or type a new password.

1. The agent inspects an ordinary contained HTTPS page and generates a credential for that exact origin and intended username.
2. BLACKICE saves the generated password in its encrypted vault before returning a handle. Repeating the same generation request with identical inputs and the same trusted owner returns the original credential.
3. The host fills only the specified, freshly observed password fields. It verifies origin, document, visibility, field type and editability before accessing the secret and again before writing. Filling does not submit a form.
4. In **Settings → Password manager**, the user selects saved login revisions and a destination: Chrome, Firefox or BrowserOS Neo.
5. **Copy to browser password manager** opens the chosen browser's password-manager/settings page and reveals the selected temporary CSV. The user chooses the intended browser profile, then uses that browser's native **Import passwords** controls to import the file.
6. **I imported these passwords** records confirmation by the user and removes the temporary file. BLACKICE does not independently inspect the destination password database.

The optional **Automatically queue saved passwords** preference queues current saved credential revisions when enabled, then queues new or updated credentials for the selected destination. The queue is encrypted and contains references to exact credential revisions. It does not silently launch a browser or create a plaintext export. A local handoff is still required for native import.

## Local management

The local password form can add or replace a saved login. Website addresses must be HTTPS origins. A replace operation names the existing credential revision and the current vault revision; a conflicting edit cannot silently replace a newer password. A successful save clears the masked draft. An uncertain save preserves the draft and its request ID so the same request can be retried without creating a second login.

Background refreshes preserve active input, focus and selection. A checkbox is bound to the credential revision actually displayed; if polling discovers a newer revision while the displayed row is preserved, clicking the old row cannot silently choose the new password.

These routes require the authenticated local application session. Remote-management requests and cross-origin writes are denied. Browser-copy preferences, native launch, import confirmation, deletion and local password entry are not model tools.

## Storage and temporary files

The vault and outbound queue use the desktop's protected storage implementation. On Windows, Electron uses DPAPI for the current operating-system user. This protects stored bytes; it is not a security boundary against another process already running as that same user. The plain Node server requires an explicitly supplied protected-storage implementation. Unavailable, unrecognized or plaintext fallback storage disables credential operations while the rest of BLACKICE remains available.

Vault records and backups are encrypted. A missing or corrupt optional store is preserved and reported as unavailable. Whole-store writes are serialized, revision checked and atomically published. Credential generation rechecks authorization inside the storage lock and immediately before publication. Direct connector calls recheck the current grant at dispatch and after queued work.

A native browser CSV is necessarily plaintext while it is available for import. BLACKICE creates it only after the explicit local handoff. On Windows, a current-user directory ACL is applied before the file is written. The filename is not returned through model tools. The default lifetime is five minutes while BLACKICE is running. Confirmation, cancellation, expiry and normal shutdown remove the owned export; startup recovery removes exports left by a dead process. Expiry does not depend on successfully decrypting the vault or queue. Profile backup excludes the exact temporary export subtree and retains the encrypted vault and queue.

Removing the temporary CSV does not erase a password already imported into a browser. Cancellation cannot undo a completed browser import. If the user copies the CSV elsewhere, that separate copy is outside BLACKICE's cleanup ownership.

## States and retries

| State | Meaning |
| --- | --- |
| `pending` | An encrypted copy intention exists; no import completion is recorded. |
| `awaiting_browser_import` | An explicit handoff was prepared; native import remains to be completed. |
| `confirmed_by_user` | The user reported completing the import; BLACKICE did not independently verify the browser database. |
| `failed` | The handoff or its recovery failed; inspect the current state before taking another action. |
| `cancelled` | Further owned handoff work was cancelled and temporary-file cleanup was requested. This does not undo an earlier browser import. |

The same handoff request returns its existing batch instead of exporting again or reopening the browser. A changed credential revision requires a new deliberate selection. An uncertain account submission must be inspected separately; generating another password is not a recovery strategy for an existing account.

## Compatibility and verification limits

Chrome and Firefox expose native CSV password import. This release uses that supported handoff and does not modify their password databases, copy encrypted Chromium profile files, bypass browser or OS unlock, or assert general silent external-write support. Neo receives its Chromium password-manager URL. The user selects the destination profile and completes the browser's own import controls.

Saved passwords and signed-in sessions are different. This feature does not clone cookies, complete MFA, transfer a Neo session into BLACKICE's contained browser, or authenticate the ChatGPT connector. Native source-browser import remains a separate Browser workspace feature.

The credential tools support the ordinary contained Chromium browser. The human's reserved ChatGPT conversation tab is excluded. A document that receives a protected credential keeps its filled password fields masked in model snapshots, including after a show-password toggle. Agent screenshot responses for that document are blocked until the main page is replaced; local human previews remain available. These controls govern the opaque credential and contained-browser paths, not separately authorized desktop captures, shell commands or arbitrary behavior by the site itself. Browser scripts still control their own page after receiving a credential; filling and submission should occur only on the intended site and as part of an authorized task.

Acceptance uses disposable profiles and owned HTTPS forms. Local API and UI fixtures use an explicitly identified encrypted test double. A separate Windows fixture exercises actual DPAPI, the contained Chromium driver and current-user export ACLs. Its browser-import callback is still an owned fixture. A passing callback or user confirmation does not prove import into a real Chrome, Firefox or Neo profile, and does not prove an authenticated ChatGPT conversation round trip.

Primary references: [Chrome password import](https://support.google.com/chrome/answer/13068232?hl=en), [Firefox login-file import](https://support.mozilla.org/en-US/kb/import-login-data-file), and [Electron protected storage](https://www.electronjs.org/docs/latest/api/safe-storage).
