# BLACKICE 2.39.100 — SOUL identity, stopped-task tabs, and native password manager

> **Status: isolated, unpublished source preparation only.** This is a proposed **next** release, not the installed application or a verified Windows installer. Its integrated functionality comes from exact local base commit `19fbb2625458b7abb302128da0db2fcb9f005c6b` (tree `f114ae2ee407e2ef511fb50b3a14cb9fad0d1ae9`). The final metadata-only source commit, source index, and application fingerprint must be recorded in the separate review handoff. **No 2.39.100 full Windows source suite, installer build, signing, installed-app check, GitHub release, tag, or installation has been authorized or completed.**

The previous **2.39.99** unsigned installer and GitHub draft remain separate, frozen artifacts. They were built from earlier source and **do not contain** this integrated SOUL, tab-adoption, account/credential, or native manager implementation. Do not substitute, rename, or reuse their hashes, suite receipts, or installer as 2.39.100 evidence.

## What's new in this integrated source

### User-controlled SOUL.md defaults and consistent execution identity

On a **new** identity profile, BLACKICE can create `identity/SOUL.md` from the exact shipped `DEFAULT_SOUL` in `lib/identity.mjs`, reproducible against the 2026-11-16 source fixture (SHA-256 `456f447a1a43dc8bc9682572333836c92768276abc75383a323a4b80e564a649`). The default is part of the application source; this release **does not ship an additional root-level SOUL.md** or invent `AGENTS.md`.

Existing user-authored, imported, custom, or empty SOUL documents remain user-controlled. A prior **recognized system-owned default** can be refreshed without silently replacing user-owned content; creation uses exclusive new-file semantics. An execution captures one SOUL snapshot, and model-facing identity reads remain bound to that snapshot even if the user subsequently edits their document. Model tools cannot edit SOUL.md. These are implemented source policies and deterministic focused-test behaviors; an installed-user-profile migration has not been accepted or exercised here.

### Adopt eligible tabs from settled stopped tasks

The contained browser can recognize reusable tabs owned by a genuinely stopped and settled task without requiring a blanket close or discarding unresolved effects. Eligibility accounts for exact task termination evidence, browser ownership, conversation borrowers, retained/dirty pages, pending actions, and previously uncertain outcomes. It does not automatically adopt arbitrary unrelated, active, protected, or unfinished browser tabs. Preserved effects remain inspectable.

### Ordinary account workflows and native password manager

Ordinary account and sign-in forms are no longer automatically blocked merely for being credentials-related. The optional credential helper can generate, save, update, and reuse credentials for an authorized browser owner; password-only updates preserve omitted metadata, while explicit empty values can clear specified fields. The new **built-in native password manager** provides a local user-facing path for saved credentials, alongside revision-aware, profile-bound encrypted vault operations and recovery constraints. In source tests, credential writes require an authorized owner and supported protected storage; an unavailable vault or conflicting revision must not silently replace saved data. The release preparation has **not opened or hashed any real vault**, inspected real secrets, or demonstrated full live account creation and reuse on an installed build.

### Previously prepared 2.39.99 capabilities retained in source

The integrated source also retains earlier Swarm project management (separate from underlying planning and Goal data), Skills and conversation/task-scoped browser cleanup, cronjob title clarity, official llama.cpp release navigation, and startup critical-path diagnostics. The diagnostics are **observability**, not proof of faster installed startup. The older 2.39.99 source note and published 2.39.98 releases remain historical evidence, not proof that these latest controls are installed.

## Evidence and limitations

The root-reviewed integration chain included local predecessor source checks: **278 focused passing** checks for the SOUL/tab union and **447 focused passing** checks after credential integration, each with zero failures in their own saved source evidence. Root also reported a separate bounded synthetic Windows lifecycle assessment and **140 focused tests** for the native manager lane; its exact independent receipts are a prerequisite for any formal release evidence binding and are **not** a full suite receipt for this metadata commit. All these checks precede the final version metadata, and none proves installer packaging, Windows shortcut behavior, live credential effects, or user-profile migration.

For **2.39.100**, release qualification still requires an exact committed source SHA/tree, source-index/app-fingerprint binding, a newly admitted **full Windows source suite** with its own complete TAP and terminal receipts, and an explicitly **nonpublishing** Windows installer whose bytes and packaged runtime match that same source. Independent static payload comparison, a disposable genuine Windows installed-application/shortcut/runtime/uninstall run, backup/restore and diagnostic-redaction evidence, and source-owned readiness reporting are separate gates. An optional skipped test is **not** counted as passed. Root controls all admissions and promotion. Earlier suite totals, including 2.39.99's 8,891-test source suite, cannot be carried forward as results for 2.39.100.

The new version is **unsigned unless a future independently verified signing step demonstrates otherwise** (Windows Authenticode `NotSigned` is not a verified publisher). The existing `.github/release-request.json` is an older publication record and is intentionally **not modified or submitted** as a new release request. There is no tag, draft, published asset, installer execution, user-PC restart, or publication attributable to this preparation.

## Non-overwrite and release ownership

All product-source identity tests for SOUL use **disposable fixtures**. The release preparation never reads, hashes, seeds, or replaces the user's real `SOUL.md`, credential vault, browser profiles, or persisted conversation data, and does not generate `AGENTS.md`. Future installation must preserve those user-owned artifacts and independently demonstrate the source's non-overwrite rules. Metadata-only preparation and its local checks are not permission to deploy, launch the app, run a full suite, or publish.
