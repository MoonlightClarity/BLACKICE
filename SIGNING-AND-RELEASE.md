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

The Windows publisher runs automatically when a push to `main` changes `.github/release-request.json`. `workflow_dispatch` remains available as an optional manual path. An ordinary source or documentation push **without editing the release request does not trigger publication**.

The request binds an exact source commit, application fingerprint, source-test receipt, release version, and publish/draft intent. The workflow must qualify the installer, create or verify the source tag, upload matching assets, and validate the installed candidate. Its release description uses RELEASE-NOTES.md from the requested source commit.

Do not substitute a passing source test for installed-binary validation, or treat an old receipt as evidence for a newer commit. A normal documentation cleanup is not a release request.

## Signing and user choice

BLACKICE may distribute unsigned builds; signing is optional unless expressly required by the selected release configuration. An unsigned file has no Windows-verified publisher identity. A matching published SHA-256 verifies artifact bytes, not publisher trust or antivirus compatibility.

Do not make a paid certificate or additional approval process a new blanket release prerequisite. On managed devices, applicable administrator security policies still govern installation. Keep release checks tied to concrete build integrity and observed installation, without inventing new gates.

After a successful release, use the GitHub release record for that tag's actual installer, checksum, source commit, and verification evidence.
