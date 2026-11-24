# BLACKICE Windows releases

The standard Windows artifact is **Blackice-<version>-Setup.exe**, with the version read from `package.json`. It is a per-user NSIS installer for BLACKICE. Packaging prepares a candidate and never uploads or publishes it. Signing is optional unless the build or release check explicitly requires it.

Both commands below build the same NSIS installer. `package:desktop` is a compatibility alias; it no longer creates a separate portable ZIP.

```powershell
npm run package:public
# Equivalent:
npm run package:desktop
```

When the project is directly inside an `outputs` directory, the candidate is written to `../Blackice-Public-Windows/Blackice-<version>-Setup.exe`. Otherwise it is written to `dist/Blackice-Public-Windows/`. The directory also contains `blackice-public-release.json` and `Read me.txt`.

Setup uses the BLACKICE program name, `BLACKICE.exe`, Start menu and Desktop shortcuts, and an Installed apps entry with an uninstaller. The stable application ID, package identity, and `%APPDATA%\Relay` profile directory remain unchanged for installation and data continuity. Do not rename those identifiers as a branding cleanup. Uninstalling preserves profile data.

**Published checkpoint:** [v2.40.75](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.40.75) targets `3fc873c8394fb8381456c305cd91068ce9b98eac`; the installer SHA-256 is `217178b3d4c913790c99bf65d3d138aa1986a54a5ec30d205034e9210eaa3b09`. The [GitHub Windows release workflow](https://github.com/MoonlightClarity/BLACKICE/actions/runs/45091943186) verified that exact uploaded installer. Owner-machine installation and skill/UI/browser smoke checks were recorded separately. Future releases must use their own version, commit, receipt, and checksum.

## Release priorities and Windows Smart App Control

**The current BLACKICE project intentionally ships unsigned Windows builds.** BLACKICE is free and open source, maintained by one person without a signing budget. Code signing is a possible later improvement *after adoption*, not a required milestone or a reason to divert development time from working features. No paid certificate or signing service should be purchased to publish this project.

**Windows policy and unsigned builds:** Windows security or organizational policy may block an unsigned BLACKICE installer or application. Verify the exact installer filename, SHA-256 and release verification record, then check the applicable device or organizational policy. A matching checksum identifies the artifact; it does not establish publisher identity or guarantee that Windows will allow it to run. A successful install on another device does not establish compatibility with this device's policy.

**Owner choice and experimental features:** On a personally managed device, the owner decides what level of risk is acceptable, including whether to keep a protection in place or make an exception. This is a tradeoff: some experimental features depend on unsigned or unfamiliar components that protections block, so making those features usable can require an exception or relaxing the specific blocking protection. Keeping that protection unchanged can mean the feature cannot realistically be offered or used in that configuration. Identify the affected component and required change rather than implying every BLACKICE feature needs it.

Use a complete installer and its published release record to inform that decision. A matching SHA-256 establishes that the bytes match the published release checksum; it does not establish that an antivirus detection is a false positive. Changes on a managed device remain subject to its administrator's policy. Validation of the actual packaged binary and installation remains valuable even without code signing.

## Repeatable source and native verification

Use a clean checkout of the exact source commit on Windows and Node.js 22.23.5 or newer. Record the source commit, Node/npm versions, native browser version, and test log hashes with the candidate's evidence. `package-lock.json` fixes the desktop build dependencies, including Electron 44.7.2 and electron-builder 26.15.3. Both generated native Chrome connection routes use the shared `chrome-devtools-mcp@1.11.0` pin in `lib/chrome-browser-policy.mjs`; that separately launched adapter is not bundled by the application's npm lockfile. A native browser remains an installed host dependency, so its version must be recorded rather than inferred from the source checkout.

```powershell
npm ci
npm test
```

For focused investigation, these commands exercise the browser gateway/profile copy, contained input/passkey behavior, OAuth recovery, and release evidence separately. They supplement the full suite:

```powershell
node --test tests/chrome-browser.test.mjs tests/browser-profile.test.mjs tests/connected-browser-tools.test.mjs tests/connected-browser-gateway.test.mjs tests/browser-cli.test.mjs tests/browser-commands-http.test.mjs
node --test tests/browser-contained-driver.test.mjs tests/browser-passkey.test.mjs tests/observe-keyboard.test.mjs
node --test tests/chatgpt-oauth.test.mjs tests/chatgpt-connector.test.mjs tests/chatgpt-connector-http.test.mjs
node --test tests/release-check.test.mjs tests/windows-release-inputs.test.mjs
```

The native fixtures below use a new synthetic browser profile and local pages. They do not open a personal browser profile or establish that copied account credentials work. Run the Electron fixtures with the checkout's raw Electron executable, never the installed BLACKICE application. Keep their reports outside the checkout. Set `$chrome` to the installed Chrome executable to be tested; the example is an ordinary system installation path.

```powershell
$evidence = Join-Path $env:TEMP ('blackice-verification-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $evidence | Out-Null
$electron = Join-Path $PWD 'node_modules\electron\dist\electron.exe'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$adapter = Join-Path $evidence 'adapter'
New-Item -ItemType Directory -Path $adapter | Out-Null
Set-Content -LiteralPath (Join-Path $adapter 'package.json') -Value '{"private":true}' -Encoding utf8
npm install --prefix $adapter --save-exact --no-audit --no-fund chrome-devtools-mcp@1.11.0
$mcpEntry = Join-Path $adapter 'node_modules\chrome-devtools-mcp\build\src\index.js'
node scripts/browser-profile-smoke.mjs "--executable=$chrome" "--mcp-entry=$mcpEntry" "--output=$evidence\browser-profile.json"
& $electron scripts/browser-input-smoke.mjs "--output=$evidence\browser-input.json"
& $electron scripts/browser-passkey-smoke.mjs "--output=$evidence\browser-passkey.json"
```

Retain the adapter's generated lockfile with private build evidence if the same resolved dependency tree will be reused. Each fixture must exit successfully and its report must show a passing result. The profile report records actual browser/MCP versions and source hashes; the passkey report records first-script coverage across frames, popups, and restored pages without requesting a real credential. These reports are evidence for their recorded source bytes and environment only. They cannot replace the final Setup.exe verification or a native restart receipt.

After finishing runtime changes and setting the release version, use `npm run package:public` and the exact-candidate checks below. Machine-specific file-patch installers and the historical `scripts/install-background-update.mjs` helper are not the public build or update workflow.

The **Verify Windows release installer** GitHub workflow accepts an existing draft tag, its exact installer SHA-256, application fingerprint, full source commit, and `source_test_receipt`. Supply a tracked path such as `verification/windows-VERSION.json` containing actual Windows source-test results for that version and fingerprint. The workflow forwards it as `-SourceTestReceipt` to `scripts/verify-windows-release.ps1`; untracked, stale, unsuccessful, or mismatched evidence is rejected. The historical receipt is never selected implicitly. This workflow runs only on a disposable GitHub-hosted Windows VM, checks the actual installer, and attaches sanitized supporting evidence to the existing draft. Publication remains a separate step.

## Release qualification and the availability responder

The tracked [`retireReleaseAvailability`](scripts/release-availability-retirement.mjs) export supports release qualification controllers that need a matching, already-offline availability responder to exit before installation. It accepts a nonsecret marker identity, the captured generation, and caller-supplied control, admission, durable-intent and retirement-observation callbacks. It validates the raw authenticated ping response without flattening its nested state, checks admission again before sending one stop request, and reconciles the observed outcome even when the stop acknowledgement is uncertain. It does not replay the stop request.

The caller owns native process and creation-time checks, saved marker/profile identity, absence of a newly opened owner, and the durable attempt record. After the helper returns, the controller still enforces its complete zero-process installer gate. An uncertain outcome requires inspection of that attempt before another invocation. This module does not locate credentials, copy profiles, launch Setup, or modify normal app quit, the updater or NSIS behavior.

The [composed regression suite](tests/release-availability-retirement.test.mjs) checks the real exported helper, including the raw-response boundary that a previous external qualification controller mishandled:

```powershell
node --test tests/release-availability-retirement.test.mjs
```

Passing that suite establishes the orchestration contract. Record actual native retirement, installer execution and reopened build identity separately. For a release pass that includes owner-machine cleanup, finish source and documentation changes, test and package the exact revision, install and verify that installer, then measure and complete the authorized cleanup before public source/release publication. Keep a verified rollback installer and the exact new bundle; preserve profiles, models, chats, source, uncommitted work and qualification evidence.

## Requested release automation

The **Build and publish requested Windows release** workflow provides the complete hosted build path. It runs automatically when a push to `main` changes `.github/release-request.json`. `workflow_dispatch` remains available as an optional manual path, not a required extra step. An ordinary source push that does not change the release-request file does not start publication. The request file supplies the exact version, fingerprint, source-test receipt and publication choice; `publish: true` publishes after the existing qualification, while `publish: false` prepares a draft. This is the maintainer-directed workflow, not a discretionary security setting. Do not replace it with manual-only publication or add approval requirements without an explicit maintainer instruction.

Finish the current source tests and installed application acceptance first, then commit the sanitized Windows source-test receipt. To request the release, add or update this file with the real fingerprint from that tested source:

```json
{
  "format": 1,
  "version": "<next-version>",
  "appFingerprint": "<actual application SHA-256>",
  "sourceTestReceipt": "verification/<tracked-source-test-receipt>.json",
  "publish": false
}
```

The request is deliberately not created by packaging. The workflow binds the request to its actual triggering commit, checks its version, application fingerprint, tracked release notes, and tracked source-test receipt, installs the locked build dependencies, and builds the Windows candidate. It creates a draft targeting that exact commit, runs `verify-windows-release.ps1` on the fresh GitHub-hosted Windows runner, and attaches the same fixed set of sanitized installer evidence used by the separate verification workflow. Publication requires successful existing release checks and an explicit `publish: true`. Use `false` to leave the verified result as a draft.

A rerun can recover a complete draft only when it targets the same commit and its exact installer, manifest, and checksums agree. A partial draft, another source target, or an already published version is reported for inspection instead of replaced. No browser session or personal token is required: the release actions use the repository's ordinary GitHub Actions token.

## Deferred signing integration (not a current release requirement)

BLACKICE does not maintain a signing provider, buy signing certificates, or include certificate enrollment in its development roadmap at the current adoption level. Existing optional signing hooks below are retained only for future reuse; do not spend development time on them in the normal unsigned release workflow.

Without a signing identity, the installer is explicitly unsigned. Its manifest records `signing.status: "unsigned"`, null publisher fields, and `publisherVerified: false`. Windows has not verified a BLACKICE publisher identity. No signing account or paid service is required for that release policy.

To use an existing identity, set `RELAY_SIGNING_PUBLISHER` to the exact common name on its certificate and supply one supported signing method:

- `WIN_CSC_LINK` or `CSC_LINK`, with `WIN_CSC_KEY_PASSWORD` or `CSC_KEY_PASSWORD` when needed, for an existing PFX. Keep certificate contents and passwords in the build environment or CI secrets.
- `RELAY_SIGNING_CERT_SHA1` for an existing Windows certificate-store thumbprint.
- `RELAY_AZURE_SIGNING_CONFIG` pointing to JSON containing `publisherName`, `endpoint`, `certificateProfileName`, and `codeSigningAccountName`. The publisher must match `RELAY_SIGNING_PUBLISHER`. Optional selectors are `fileDigest`, `timestampRfc3161`, and `timestampDigest`. Azure credentials remain in the signing environment.

The historical `RELAY_` environment-variable names are supported configuration interfaces. No identity, certificate, account, or signing service is supplied or acquired automatically. Generated configuration and release receipts must not contain certificate passwords or PFX contents.

Any explicitly supplied signing inputs must be complete and valid. Packaging does not silently fall back to unsigned output after a signing configuration error. When signing is configured, both `BLACKICE.exe` and Setup.exe must pass Windows trust and publisher verification before the candidate is promoted. Packaging always passes `--publish never` to electron-builder.

To require signing:

```powershell
npm run package:public -- --require-signing
npm run release:check -- --require-signing --distribution ../Blackice-Public-Windows --receipts release-receipts.json
```

`--require-signing` sets the release policy's `requireCodeSigning` boolean to `true`. The checker also retains a candidate manifest's required-signing policy. An unsigned candidate cannot pass that policy. Malformed policy values, mismatched release filenames, and a signed manifest naming a different publisher fail validation.

## Bind evidence to the exact candidate

Finish source changes and set the release version before testing. The application fingerprint binds runtime sources and assets. Desktop JavaScript modules are included through the same module inventory as packaging, so new helpers cannot be omitted from the installer while retaining the source fingerprint. Tests, connector recovery backups, and the build-only icon generator are excluded. Package metadata is normalized for fields electron-builder removes from the packaged application.

Adding or changing runtime modules invalidates old fingerprints. Regenerate the receipt template and gather current evidence after any runtime change. Public receipts must also name the SHA-256 of the exact Setup.exe whose installation was exercised; another installer with the same version does not satisfy that binding.

```powershell
node scripts/release-check.mjs --template > release-receipts.json
npm test
```

Fill the template from actual results and retain the underlying logs. It is intentionally incomplete. Required evidence includes:

1. The current required test suite passes, with failed tests, required skips, and optional integration skips reported separately.
2. The actual public Setup.exe is exercised. Its installed runtime matches the candidate, the Desktop shortcut targets that installation, and Windows registration and uninstall behavior are checked.
3. The release runner's disposable profile fixture passes backup-integrity verification and restores into another disposable profile. This qualifies the backup/restore path without requiring a whole copy or hash of the owner's real profile for every program update.
4. A diagnostics export passes redaction and credential-leak checks.
5. The complete Setup.exe matches its manifest. Signing checks become required when signing is requested, the manifest declares a signed candidate, or the release policy requires signing.

Controlled fixtures do not establish that a real installer or provider was exercised. Record native Electron startup and restart observations separately from unit tests, including the tested profile and mode, completed restart receipt, and runtime discovery after relaunch. Keep historical results separate from the current candidate's evidence.

Source and installer artifacts must exclude private profile data, custom prompt histories, conversation drafts, API transcripts, saved knowledge, local reading receipts, and file-patch receipts. Built-in application definitions may be packaged as source.

For a project inside `outputs`, check the candidate with:

```powershell
npm run release:check -- --distribution ../Blackice-Public-Windows --receipts release-receipts.json --report ../Blackice-Public-Readiness.json
```

For other project locations, substitute `dist/Blackice-Public-Windows` for the distribution directory. The command exits nonzero on a failed required gate and can write a machine-readable report. A successful unsigned candidate is classified `ready-for-public-release-unsigned` with `publisherVerified: false`. `publicReleaseReady: true` means the supplied evidence and artifact satisfy the required gates; `published` remains `false`.

The receipt is an operator attestation backed by retained test artifacts. The release checker verifies its binding and declared results; it does not run those tests or independently perform installation, backup restoration, or diagnostics review. Neither this document nor a passing unit suite establishes public-installer verification.

## Updates, rollback, and historical portable bundles

Use **Blackice-<version>-Setup.exe** to install, reinstall, or update the registered Windows program while preserving its existing profile. Check for active work and use the supported shutdown or restart flow before running Setup. Verify the exact candidate's installation path, Windows uninstall registration and shortcuts, then reopen it and check its running version and application fingerprint. A built installer or queued restart does not establish installation.

Routine program qualification does not require copying, hashing or restoring the owner's entire profile tree. If a rollback or planned profile maintenance needs a data recovery point, quit BLACKICE and back up the retained `%APPDATA%\Relay` profile folder, or the explicit profile chosen for that installation; back up working folders separately. The release runner's backup-integrity and restore gate uses disposable qualification data. Restoring application files alone does not restore profile data or schema.

`scripts/Install-Relay.ps1`, `relay-distribution.json`, and `release:check -- --local` remain compatibility tools for historical Relay portable bundles. Current packaging commands do not produce that format. Its existing `Relay.exe` and manifest identities must remain intact when verifying those older bundles. A local verification report never establishes public release readiness, and a portable deployment test cannot replace the actual Setup.exe installation gate.

The historical helper supports same-version redeployment, refuses accidental downgrades, and provides explicit `-AllowDowngrade` and `-RequirePublisher` options. Do not use it to overwrite an installation registered by Setup; update that installation through Setup so files and Windows registration remain consistent.

## Explicit publication and product/build versioning

The Windows publisher starts automatically when `.github/release-request.json` changes on `main`. Ordinary source pushes without a change to that file do not run the publisher. The **Run workflow** (`workflow_dispatch`) option remains available for manual recovery, not as an approval requirement. This does not hide or reclassify earlier failed runs. The separate documentation and attribution workflows keep their own triggers.

Automatic and manually dispatched requests both check the exact source, test evidence, candidate bytes and tag identity. `publish: false` requests draft preparation; `publish: true` permits final publication after all existing checks pass. Do not manufacture a passing receipt or promote a different artifact to make a check green. A future agent must not disable the automatic release-request trigger or rewrite the tests to legitimize that regression without an explicit maintainer directive.

### Version and build identity

Use the version in the exact candidate's `package.json`. The [2.40.80 public release](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.40.80) was published on November 24, 2026 with verified installer and source-test evidence; the current branch may move independently of that immutable tag. Set the version, lockfile metadata, notes and release request together before qualification. A working version or published GitHub tag alone does not establish that the owner-machine installation was completed.

- Minor versions identify coherent backward-compatible feature/usability improvements. Patch versions identify fixes to a released product version, not each agent iteration or packaging attempt.
- Keep internal attempts separate using a build record such as `buildId: 20261117.3`, with exact `sourceCommit`, application fingerprint, installer SHA-256 and `channel: internal`.
- Put attempts in distinct build/evidence directories. Preserve failed attempts. Promote the exact qualified artifact; never overwrite a published installer or retag historical releases.
- Retain existing 2.39 tags and releases. There is no need to publish missing patch numbers or rewrite history.
- Keep the current numeric `X.Y.Z` package version. The release validator and Windows version handling are not presently suffix-compatible. A `+build` suffix is not an upgrade-order mechanism; preview channels need separate compatibility work before adoption.
- Preserve application identity, installer/profile paths and migration behavior, and verify the actual upgrade rather than assuming numeric version ordering proves compatibility.

A build ID display in diagnostics/About is a later implementation item, not a feature claimed by this documentation change. Public release timing follows a useful verified change, not a per-build or daily quota.
