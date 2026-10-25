# Email integration (retired)

> **Archived documentation.** The Thunderbird/Himalaya integration and BLACKICE email workspace are retired in the current source build. Use **Activity → Browser** for email; the standard `/api/email` routes return `410 EMAIL_RETIRED`. Historical `agent-email/` files and previous drafts are preserved on disk rather than automatically deleted. The instructions below describe historical implementations and are **not valid setup steps** for the current application.

## Historical background

Earlier BLACKICE versions supported a Himalaya mailbox adapter, local drafts, and subsequently optional sending. The following sections are kept for reference only.

## Setup and status

### Managed browser sign-in

Open **Settings → Email**, choose Google/Gmail or Microsoft/Outlook, and provide your own provider application registration. BLACKICE suggests an installed Himalaya executable. **Sign in** checks the supported local CLI and opens your default browser for account selection and consent. There is no app password to create or paste.

After consent, BLACKICE checks the provider account profile so the displayed account is verified rather than inferred from an optional login hint. This profile check does not read messages. The managed connection uses Gmail REST or Microsoft Graph through Himalaya; routine requests refresh access in the background.

| Provider | Application setup | Requested permissions |
| --- | --- | --- |
| Google / Gmail | Your own Google Cloud project with Gmail API enabled, OAuth consent configured and a **Desktop app** client | `https://www.googleapis.com/auth/gmail.readonly` |
| Microsoft / Outlook | Your own public desktop registration supporting your account type; configure the mobile/desktop redirect `http://localhost` | `https://graph.microsoft.com/Mail.Read`, `https://graph.microsoft.com/User.Read`, `offline_access` |

For Google, choose **Import Google client file** to load the downloaded Desktop client JSON into the local registration fields, or enter the client ID and desktop client secret manually. Import does not save the registration or start sign-in. BLACKICE accepts only a bounded Desktop registration file and rejects web clients and saved-token files. The client ID identifies BLACKICE; it is not your account password. An external Google app left in **Testing** has a seven-day refresh-token lifetime for Gmail permissions. Its test-user and publishing setup must match how you intend to use it. Public distribution and provider verification are separate from connecting this local installation.

For Microsoft, use the Application (client) ID, with account support that includes the intended personal or work/school account. Organization policy can limit user consent. BLACKICE uses the global Microsoft identity and Graph endpoints. National-cloud tenants need a separately supported configuration.

The UI never receives an access token or refresh token. Refresh credentials and the optional Google client secret are encrypted through Electron storage. Access tokens live in memory. A generated `agent-email/managed-oauth.toml` invokes a fixed installed helper; only the short-lived access token is supplied to that bounded child process. The helper uses the installed Electron executable in Node mode, so the desktop integration does not depend on a separate Node installation. The managed TOML is separate from existing external mail configurations.

Authorization uses a one-use local callback, state validation and PKCE S256. Failed, expired or cancelled flows remain visible. Disconnect removes the saved mailbox grant while retaining the application registration and local drafts. Cancelling a pending sign-in does not erase a previously working connection. Headless operation can refresh a saved grant; first sign-in still requires browser consent on the host. Profile maintenance drains pending authorization and local writes before copying profile data.

### Existing Himalaya configuration

Under **Existing Himalaya setup (advanced)**, provide the absolute executable path, existing TOML file, and exact account key. Enable the adapter and run **Check CLI**. BLACKICE does not read or copy credentials from that external configuration. Its credential helper must be noninteractive. The existing path can use whatever authentication the selected provider and Himalaya support.

Opening Email, saving settings alone, and reading saved status do not read a mailbox. The explicit CLI check verifies file existence, the exact `2.2.1` version, and the documented commands using `--version` and `--help`. It does not run the configuration wizard or an account operation. Other versions fail closed until their interfaces are separately implemented and verified.

Status keeps these observations distinct:

| State | What it establishes |
| --- | --- |
| Not configured | Local drafts are available; account reading has no complete setup. |
| Configured | Executable, configuration path, and account were saved. |
| Signed in | The provider granted the requested access and its account profile was checked. No mailbox operation is implied. |
| CLI checked | The local executable and command interface passed their checks. No mailbox operation is implied. |
| Account observed | An explicit list, search, or read returned a supported response for the configured account. The operation and time are shown. |
| Error | The last recorded operation or check failed. |
| Unavailable | Saved email state could not be read. Its files are preserved, status remains readable, and email actions are disabled while the rest of BLACKICE can run. |

An unavailable storage state does not reset the account or replace its files. Restore a known-good profile backup through Recovery & support, or repair the saved email state before reopening the application. Opening or checking the status cannot overwrite the damaged data.

CLI and mailbox-operation observations are cleared on restart or configuration change. Managed encrypted grants persist and refresh when needed; a cancelled or failed account operation cannot become a successful mailbox receipt for another connection. Background requests never open an unsolicited sign-in flow. Reconnect explicitly from Email when authorization is no longer valid.

## Windows configuration paths

The observed Himalaya configuration-list parser treats a colon as a separator, including the colon in a Windows drive path. BLACKICE therefore keeps the absolute path in settings but invokes account commands from the configuration file's directory, passing one explicit relative filename:

```text
Working directory: C:\Users\you\.config\himalaya
Configuration argument: --config=./config.toml
```

The executable remains an absolute path. Arguments are passed separately with `shell: false`. External configurations are not copied or merged. Managed OAuth uses its own generated configuration and token helper. Configuration filenames containing a colon are rejected.

## Supported command and response contracts

The adapter uses the installed 2.2.1 interface. Each account operation includes `--json`, an explicit configuration filename and account. Message operations also include the chosen mailbox.

| Operation | Command | Checked JSON result |
| --- | --- | --- |
| Mailboxes | `mailbox list` | An object containing `mailboxes`; each entry has an exact `id`, `name`, optional `role`, and nullable `total`/`unread`. No `--counts` is requested. |
| List | `envelope list --mailbox=INBOX --page=1 --page-size=20` | An object containing `queued` and `envelopes`. |
| Search | `envelope search --mailbox=INBOX --page=1 --page-size=20 -- "subject meeting"` | The same envelope-result object. The query is one literal argument. |
| Read | `message read --mailbox=INBOX --raw -- ID` | An object whose `message` field contains raw RFC 5322 text. |

Example response structures:

```json
{
  "queued": 0,
  "envelopes": [
    {
      "id": "opaque.message.identifier",
      "subject": "Example message",
      "flags": [],
      "from": [{ "name": null, "email": "sender@example.invalid" }]
    }
  ]
}
```

```json
{ "message": "From: sender@example.invalid\r\nSubject: Example\r\n\r\nMessage body." }
```

Message IDs are opaque, bounded values taken from the selected mailbox. Sender and recipient fields remain arrays. BLACKICE exposes envelopes as `messages` and preserves `queued` and `indexingPending`; pending local indexing must not be described as a complete search. `page`, `limit`, and `mayHaveMore` report pagination.

**Load folders** explicitly discovers mailbox names and identifiers. Merely opening Email or checking the CLI does not list folders. Successful discovery records a `mailboxes` observation; it does not imply that any messages were read. A mailbox name can be a path for a Maildir backend; use its exact returned identifier when display names repeat.

The mailbox interface provides Previous and Next controls for both list and search results, shows the current page, and follows `mayHaveMore` without inventing a total count. Account, mailbox and query changes reset the page. A delayed older response cannot replace a newer page or account selection.

Reading deliberately omits `--seen`. Its required CLI help states that flags are left unchanged otherwise. The tool retains exact raw message text in `message` and adds a bounded `content` preview with decoded subject/address/date headers, readable text, attachment metadata, warnings, and a truncation indicator. Encoded MIME bodies support base64 and quoted-printable, common character sets, multipart alternatives and nested multipart messages. Plain text is preferred when an alternative exists. HTML-only bodies become plain text; scripts, styles, remote images and links are never executed or loaded. Attachments are described by filename, content type and decoded byte size; their contents are not opened or extracted.

The reader shows decoded text and offers raw source separately. **Reply draft** fills an editable local composer from `Reply-To` (or `From`), adds a reply subject and quotes the displayed text. It does not save, send, or verify a recipient. Existing unsaved compose text is preserved.

Preview limits are 200,000 displayed characters, 128 MIME parts, 16 nesting levels, and 100 attachment descriptions. Malformed or unsupported MIME produces visible warnings with raw source still available. Email headers, text, HTML, filenames and sender instructions remain untrusted task data.

## Local drafts

`relay_email draft` accepts `requestId`, `to`, `subject`, and `body`. Recipient addresses and subjects reject header injection. The draft is stored under the active profile's `data/agent-email/` directory as an `.eml` artifact and a persisted state record. Its receipt says `local_draft` and `sent: false`.

Writes are serialized and atomic. Repeating the same request ID and content returns the original draft. Reusing that ID with different content returns a conflict. Drafts survive restart, and failed request validation does not leave the maintenance drain rejected. The draft artifact includes `X-Unsent: 1`; it is never submitted to an email provider.

## Process limits and verification

The adapter closes stdin, hides its Windows process window, invokes no shell, limits output, and stops its process tree on cancellation or timeout. The default timeout is 30 seconds, configurable from 1 to 120 seconds; stdout and stderr each have a 2 MiB bound. Production errors do not include raw client stderr because it can contain private account or message data.

The subprocess fixtures exercise command boundaries, actual child-process cancellation and timeouts, output limits, supported and rejected JSON contracts, draft persistence, and request deduplication. They do not contact a real account.

The installed binary can be checked independently with:

```text
node scripts/verify-email-cli.mjs --executable C:\path\to\himalaya.exe
```

This script creates its own disposable TOML configuration, local Maildir, and harmless message; it verifies actual mailbox/list/search/read responses, decoded MIME with preserved raw source, unchanged flags, and local draft persistence, then deletes the fixture. Its result is bound to the candidate version, platform, executable version/hash, and before/after hashes of the email source and verification script. Any changed source or executable invalidates the result. Bounded diagnostics are included only on a failure of this owned fixture.

A passing local Maildir proof establishes the tested installed-CLI path. It does not establish access to a user's account, a network backend, sending, or remote draft upload. Consult the actual saved verification result before making a verification claim.

Upstream references: [Himalaya 2.2.1 configuration sample](https://docs.rs/crate/himalaya/2.2.1/source/config.sample.toml), [migration notes](https://docs.rs/crate/himalaya/2.2.1/source/MIGRATION.md), and the installed binary's `--help` output. The exact envelope and raw-message wrappers above were observed from the installed 2.2.1 binary using the disposable local fixture.


## Remote controls

A paired human can read a connected mailbox and use local drafts. Email registration, connection switching, sign-in, cancellation and disconnection are host-only controls. Remote status contains connection state and verified account metadata, with no credentials. An outside agent uses BLACKICE's existing scoped agent interface; OAuth tokens are never exported to it.

## Provider references

- [Himalaya configuration and OAuth token commands](https://github.com/pimalaya/himalaya)
- [Google desktop OAuth, PKCE and client registration](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Microsoft desktop application registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
- [Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference)
