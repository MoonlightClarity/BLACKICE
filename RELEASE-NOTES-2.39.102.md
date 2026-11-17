# BLACKICE 2.39.102 - task continuity and clearer workspaces

## Changes since 2.39.101

- Activity exposes searchable retained text, public progress and optional structured reports without replacing the conversation. Historical reports remain readable without a saved Directory context; incomplete provider payloads are hidden.
- Conversation folders are profile-local, support manual filing and bounded automatic title grouping, and preserve Archive/Trash state. Prior task constraints are labeled as historical evidence rather than current authority.
- Informational browser alerts are acknowledged in the active run while in-flight calls and subsequent reads remain ordered.
- The application-history submission gate is removed. Native action receipts remain observational; active-call fencing and durable action records are preserved. Same-call recovery avoids redispatch within the retained receipt/guard scope; new call IDs may repeat external actions. Unsaved receipts do not provide restart-wide recovery. See the [browser action audit](docs/browser-action-gate-audit-20261116.md).
- Scoped autonomy is separate from Goal Mode and native agent control. Selected models and explicit scope govern continuation rather than a standing goal implicitly enabling it.
- Swarm creation fields and Knowledge folders have more usable layouts. Skills authoring contains its own scrolling, preserves navigation/drafts and keeps filing failures visible.

- External Firefox automation is removed from normal browser registration, selection and UI. The contained BLACKICE browser remains the supported browser; historical Firefox/email qualification fixtures are archived, not counted as current feature coverage.
- Live Windows desktop UIA is retired from normal server and agent execution. Legacy requests receive an explicit retired result without dispatch; contained-browser and supported application-integration paths remain. No saved user data is removed.
- The rendered Directory regression now checks the existing default-off policy; this test-only correction does not enable Directory or alter its runtime behavior.

Existing SOUL defaults, saved data, the action ledger, password manager and bundled local runtime are retained. This preparation does not regenerate AGENTS.md or alter the installed profile.

## Scope and limitations

Focused synthetic tests and hidden rendering cover the integrated source. This is not proof that a live job will complete, a universal browser compatibility claim, or a measured startup improvement. The separate startup-performance candidate is not included.

This revised retirement candidate has not completed full-suite, build, packaged smoke or installation qualification. Earlier source 150d76 and installer d1107f have retained historical evidence, but that installer is obsolete for these changes. See the [validation plan](docs/RELEASE-2.39.102-VERIFICATION.md). No installer, publication or installed-version change is claimed.
