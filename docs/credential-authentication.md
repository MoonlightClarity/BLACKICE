# Scoped credential authentication

The credential tool's authenticate action handles separately authorized routine login/signup without exposing passwords. Account category is not an authorization shortcut: ATS login does not authorize application submission, mailbox access, recovery changes or payments.

## Supported scope

- Ordinary native/coordinator/delegate tool path and direct browser-write tools with fresh host callbacks.
- Same-origin HTTPS POST native forms, exact saved credential revision, fresh document/password/username/submit refs.
- Password autocomplete current-password for login, new-password for signup.
- Credential-only fields, hidden fields, and buttons. Additional visible fields or commitments require a separate supported flow.
- Explicitly attached protected task contexts still have no credential authentication adapter and remain blocked by their existing gate. This release does not claim protected-context end-to-end authentication.
- JS-only buttons and foreign authentication endpoints remain unsupported. No Workday/domain allowlist or generic click bypass exists.

## Receipt and retry rules

Use one stable requestId for the exact operation. The encrypted vault journals an unknown dispatch receipt before native submission, then upgrades it to dispatched when confirmed by the adapter. A thrown/lost result remains unknown and does not replay after restart. Neither outcome proves login/account creation; inspect a safe resulting page separately. Do not substitute a new requestId to replay uncertainty.

Password masking, protected screenshots and console/network capture suppression remain in force on the credential-bearing document. Host receipts contain only bounded credential handles and dispatch metadata, never password values or page text.

## Validation limits

Native controlled HTTPS fixtures use synthetic accounts, real Windows DPAPI and isolated Electron profiles. They exercise the real host/service and (when recorded by the fixture) tool adapters. They do not prove acceptance by every ATS, a live external account, or a model choosing the correct flow. Full-suite and installed validation are separate release gates.
