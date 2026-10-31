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

## Repeatable source and native verification

Use a clean checkout of the exact source commit on Windows and Node.js 22.12 or newer. Record the source commit, Node/npm versions, native browser version, and test log hashes with the candidate's evidence. `package-lock.json` fixes the desktop build dependencies, including Electron 44.7.2 and electron-builder 26.15.3. Both generated native Chrome connection routes use the shared `chrome-devtools-mcp@1.11.0` pin in `lib/chrome-browser-policy.mjs`; that separately launched adapter is not bundled by the application's npm lockfile. A native browser remains an installed host dependency, so its version must be recorded rather than inferred from the source checkout.

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

## Requested release automation

The **Build and publish requested Windows release** workflow provides the complete hosted build path. It runs on an explicit change to `.github/release-request.json` on `main`, or a manual dispatch on `main`. Ordinary source commits do not trigger publication.

Finish the current source tests and installed application acceptance first, then commit the sanitized Windows source-test receipt. To request the release, add or update this file with the real fingerprint from that tested source:

```json
{
  "format": 1,
  "version": "2.38.0",
  "appFingerprint": "<actual application SHA-256>",
  "sourceTestReceipt": "verification/windows-2.38.0.json",
  "publish": true
}
```

The request is deliberately not created by packaging. The workflow binds the request to its actual triggering commit, checks its version, application fingerprint, tracked release notes, and tracked source-test receipt, installs the locked build dependencies, and builds the Windows candidate. It creates a draft targeting that exact commit, runs `verify-windows-release.ps1` on the fresh GitHub-hosted Windows runner, and attaches the same fixed set of sanitized installer evidence used by the separate verification workflow. Publication requires successful existing release checks and an explicit `publish: true`. Use `false` to leave the verified result as a draft.

A rerun can recover a complete draft only when it targets the same commit and its exact installer, manifest, and checksums agree. A partial draft, another source target, or an already published version is reported for inspection instead of replaced. No browser session or personal token is required: the release actions use the repository's ordinary GitHub Actions token.

## Optional existing signing identity

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
3. A profile backup passes integrity verification and restores successfully into a disposable profile.
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

Use **Blackice-<version>-Setup.exe** to install, reinstall, or update the registered Windows program. Verify the exact candidate's installation path, Windows uninstall registration, and shortcuts. Before rollback or profile maintenance, quit BLACKICE and copy the retained `%APPDATA%\Relay` profile folder, or the explicit profile folder chosen for that installation. Back up working folders separately. The release runner verifies backup integrity and a disposable restore as separate installer evidence. Restoring application files alone does not restore profile data or schema.

`scripts/Install-Relay.ps1`, `relay-distribution.json`, and `release:check -- --local` remain compatibility tools for historical Relay portable bundles. Current packaging commands do not produce that format. Its existing `Relay.exe` and manifest identities must remain intact when verifying those older bundles. A local verification report never establishes public release readiness, and a portable deployment test cannot replace the actual Setup.exe installation gate.

The historical helper supports same-version redeployment, refuses accidental downgrades, and provides explicit `-AllowDowngrade` and `-RequirePublisher` options. Do not use it to overwrite an installation registered by Setup; update that installation through Setup so files and Windows registration remain consistent.
