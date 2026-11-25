# BLACKICE development instructions

## Preserve the maintainer's intended behavior

The maintainer owns product and release decisions. Do not silently replace existing functionality with a more restrictive workflow, security precaution, approval gate, or manual step. If a concrete concern exists, describe it and preserve the requested behavior unless a real higher-priority limitation prevents it. A change to both an implementation and its tests can still be a regression when it changes the user's requirements. When asked to integrate, release, or clean up, perform that task through the existing workflow. Do not invent release checklists, extra full-suite reruns, stand-alone validation scripts, audits, archival rules, or new prerequisites; investigate concrete failures directly, and do not turn routine maintenance into a process project without an explicit request.

## Windows release publication contract

- A push to `main` that changes `.github/release-request.json` **automatically starts** `.github/workflows/publish-windows-release.yml`. This is an intentional release request, not an ordinary source push.
- `workflow_dispatch` remains available as an *additional* manual recovery path, not the required publication path.
- An ordinary source push that does not change `.github/release-request.json` does **not** start the Windows publisher.
- `publish: true` publishes after the **existing** source and installer qualification succeeds; `publish: false` requests a draft. Packaging alone does not publish.
- Do **not** remove or narrow the automatic trigger because manual dispatch seems safer. Do not add extra confirmations, approvals, paid signing, or other new publication prerequisites without the maintainer's explicit instruction.
- When editing release behavior, consult `SIGNING-AND-RELEASE.md` and run `node --test tests/release-publication-contract.test.mjs`. Do not rewrite the specification and its tests merely to make an unauthorized behavior change pass.
- After committing a release request, verify an actual GitHub Actions run with event `push` for that commit. A green local test is not proof that publication started; preserve existing evidence and investigate if the run is missing.

The fast behavior check is a functional regression check, **not** an additional release approval or security gate. Only an explicit maintainer request changes this contract.

## Documentation hygiene

Keep tracked documentation small and current. Do not commit temporary investigations, model experiments, run logs, handoffs, per-version release-note files, or documentation-status inventories as permanent reference. Update existing guidance only when a user or maintainer actually needs it; otherwise let tests and Git history record development. No special documentation release or recurring review ritual is required.
