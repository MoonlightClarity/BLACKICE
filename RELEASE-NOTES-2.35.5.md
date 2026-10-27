# BLACKICE 2.35.5 — Windows release-verification correction

This candidate retains the general-purpose Planning, metacognition, and recurring-work improvements documented in `RELEASE-NOTES-2.35.4.md`. No production Planning or scheduler behavior changes in this patch.

## Verified release-input correction

- Adds exact, tracked C# helpers to the Windows package verifier's allowlist: `desktop/installed-app-icons.cs`, `desktop/native-app-launcher.cs`, and `desktop/native-foreground-guard.cs`.
- Keeps unrecognized native helpers, untracked files, private paths, and generated backups rejected.
- Allows the known 2.35.4 release notes to remain bundled alongside the current release document.
- The previous 2.35.4 candidate installed and uninstalled cleanly on the isolated GitHub runner but did not pass the strict package-inventory check. This release addresses that observed failure without rewriting the earlier tag.

## Validation boundary

The actual prior NSIS payload was extracted without installation and its 502 application files passed the repaired inventory and source-byte checks, including upstream notices. The exact new 2.35.5 installer must be built and retested before its own published release decision.

Public publication remains blocked until a fresh GitHub-hosted Windows runner confirms installation, native runtime behavior, profile backup and disposable restoration, diagnostics redaction, and clean uninstallation. The existing desktop installation and saved user profile are not modified by this packaging step.
