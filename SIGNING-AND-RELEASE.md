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

Use **Blackice-<version>-Setup.exe** to install, reinstall, or update the registered Windows program. Verify the exact candidate's installation path, Windows uninstall registration, and shortcuts. Use BLACKICE's Recovery & support controls to make a verified profile backup before rollback or maintenance that may affect profile compatibility. Restoring application files alone does not restore profile data or schema.

`scripts/Install-Relay.ps1`, `relay-distribution.json`, and `release:check -- --local` remain compatibility tools for historical Relay portable bundles. Current packaging commands do not produce that format. Its existing `Relay.exe` and manifest identities must remain intact when verifying those older bundles. A local verification report never establishes public release readiness, and a portable deployment test cannot replace the actual Setup.exe installation gate.

The historical helper supports same-version redeployment, refuses accidental downgrades, and provides explicit `-AllowDowngrade` and `-RequirePublisher` options. Do not use it to overwrite an installation registered by Setup; update that installation through Setup so files and Windows registration remain consistent.
