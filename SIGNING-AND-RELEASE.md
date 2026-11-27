# Windows packaging and publication

BLACKICE's standard Windows x64 artifact is Blackice-<version>-Setup.exe, with the version taken from package.json. The per-user NSIS installer preserves the existing application identity and user profile location. Packaging does not publish or install the result.

## Build locally

On a supported Windows host with Node.js 22.23.5 or newer:

    npm ci
    npm test
    npm run docs:check
    npm run package:public

The package command builds a local candidate. The package:desktop command is an alias. Build output normally appears in dist/Blackice-Public-Windows with a manifest identifying the installer and its checksum.

The installer includes the current RELEASE-NOTES.md summary, not hundreds of old individual source notes. Versioned historical details can be recovered from the relevant Git tag.

## Publication

When the maintainer asks for a release, carry that authorization through the existing checks, merge, publication, and outcome verification without asking for permission again. Continuing the same authorized release carries that authorization across turns. Preserve prepare-only or no-publish limits only when they actually come from the maintainer; an assistant's earlier restriction is not a maintainer instruction.

The Windows publisher runs automatically when a push to `main` changes `.github/release-request.json`. `workflow_dispatch` remains available as an optional manual path. An ordinary source or documentation push **without editing the release request does not trigger publication**.

The request binds an exact source commit, application fingerprint, source-test receipt, release version, and publish/draft intent. The workflow must qualify the installer, create or verify the source tag, upload matching assets, and validate the installed candidate. Its release description uses RELEASE-NOTES.md from the requested source commit.

Do not substitute a passing source test for installed-binary validation, or treat an old receipt as evidence for a newer commit. A normal documentation cleanup is not a release request.

## Source lineage review and acknowledgement

The normal push-to-main release request continues to trigger publication automatically. Before building an installer, the existing workflow checks the independently maintained remote accepted-development branch and records the exact ancestry finding in the GitHub Actions summary. This warning does not require all experimental branches or worktrees to be clean.

Every new publishing release request must explicitly include a lineageReview record with format 1, acknowledged true, reviewedVersion matching the new release, reviewedAppFingerprint matching its application fingerprint, reviewedAcceptedTip matching the remote accepted commit (or null if unavailable), reviewedOutcome equal to included, omitted, or unavailable, and a specific note describing what was checked. Run the read-only lineage inspector against the proposed source and latest accepted ref before editing the acknowledgement. The workflow independently recomputes the finding; omitted, changed, absent, or stale acknowledgement blocks publishing. A known omission may proceed with matching explicit acknowledgement and a visible warning. A missing remote baseline is reported as unverified, not as successful inclusion. Draft-only requests still receive the warning. Publication requires the matching verified lineageReview record, completed by the authorized releasing operator. This technical acknowledgement does not add a separate user-permission step or require the maintainer to repeat commit hashes in chat.

The accepted-development reference represents only changes actually accepted for integration; it is not automatically reset to a release branch. This workflow cannot inspect unpushed local work, so the reviewer must compare the local canonical development worktree to the accepted branch before acknowledging. Keep this review proportional and do not block unrelated experiments.

## Signing and user choice

BLACKICE may distribute unsigned builds; signing is optional unless expressly required by the selected release configuration. An unsigned file has no Windows-verified publisher identity. A matching published SHA-256 verifies artifact bytes, not publisher trust or antivirus compatibility.

Do not make a paid certificate or additional approval process a new blanket release prerequisite. On managed devices, applicable administrator security policies still govern installation. Keep release checks tied to concrete build integrity and observed installation, without inventing new gates.

After a successful release, use the GitHub release record for that tag's actual installer, checksum, source commit, and verification evidence.
