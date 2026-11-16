# BLACKICE 2.39.100 - SOUL identity, stopped-task tabs, and native password manager

## User-controlled SOUL.md defaults and consistent execution identity

New identity profiles use the updated shipped SOUL default. Existing user-authored, imported, custom, or empty SOUL documents remain user-controlled. Only recognized system-owned defaults can be refreshed automatically; creating a default does not overwrite an existing file.

Each execution captures one SOUL snapshot. Model-facing identity reads stay bound to that snapshot even if the user subsequently edits the document. Model tools cannot edit SOUL.md; the user editor remains available. The release does not add a root-level SOUL.md or generate AGENTS.md.

## Adopt eligible tabs from stopped tasks

The contained browser can transfer tabs from a stopped, settled task without reloading the page. Eligibility checks exact owner identity, task lifecycle, active borrowers, retained pages, and in-flight work. Active, unknown, protected, or user-retained tabs are not automatically available for takeover.

Adoption preserves historical effects and uncertainty for inspection. It does not resolve an uncertain submission or authorize replaying it. The agent must explicitly claim an eligible tab using its observed ownership and document identity.

## Ordinary account workflows and native password manager

Ordinary account and sign-in controls, including required acknowledgements, are no longer blocked merely because they are credential-related. Password fields are observable through ordinary browser tools. Existing ownership, document-identity, and provider API-key protections remain separate.

The built-in local Passwords page supports generating, saving, replacing, and using credentials. It is optional: normal browser input does not depend on the manager. Saved entries persist across restarts and tasks in the profile-bound encrypted vault.

Agent credential helpers support save and update with revision and authorization checks. Password-only updates preserve omitted username and label metadata; explicit empty values clear those fields. An unavailable vault or conflicting revision must not silently replace saved data.

## Retained improvements

This release also retains Swarm project management, Skills and conversation/task-scoped browser cleanup, clearer cronjob titles, official llama.cpp release navigation, and startup critical-path diagnostics. Diagnostics provide observability, not a guarantee of faster startup.

## Verification scope

These notes describe included source changes, not installation status or release qualification. Exact source revisions, test outcomes, package hashes, signing status, and installed-runtime checks belong in their corresponding verification records. Focused checks do not establish a full-suite pass, and earlier-version artifacts or receipts do not establish verification of this version.
