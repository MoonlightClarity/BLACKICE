# Workbench: browser-compatible, hidden administrator operations

BLACKICE requests **the highest available Windows rights by default**, using `requestedExecutionLevel: highestAvailable`. In the manifest-only Windows diagnostic, both the primary and restarted BLACKICE processes remained elevated on the tested administrator runner, while restricted Chromium child processes ran without administrator rights. The `requireAdministrator` comparison failed GPU-child startup with Chromium launch error 18; changing only the execution-level resource repaired the observed startup failure without changing GPU flags, sandbox flags, the working directory or ACLs. This is bounded runtime evidence, not a compatibility claim for every Windows account or UAC configuration.

Workbench's established Hyper-V helper remains available as **a short-lived hidden administrator PowerShell child**. Actual administrator-token and `Get-VM` checks still decide whether host operations are available; the manifest is not proof of access and does not elevate the guest. The existing guest, its VHDX and workspace are retained. The successful manifest diagnostic covered strictly hidden startup, restart, window-state preservation, shutdown, profile backup and diagnostics; it did not establish visible desktop compatibility on every host.

## Project priorities and observed Windows settings

BLACKICE is free and open source, maintained by one person without a code-signing budget. Time spent on signing and enterprise security-configuration compatibility is deferred until adoption justifies it. The project explicitly prioritizes usable features and recognizes that people choose their own Windows configuration.

**Recommended UAC setting: Never notify.** Open Windows Start, search for *Change User Account Control settings*, move the slider to *Never notify* and confirm. The actual host-side test environment was `ConsentPromptBehaviorAdmin=0` and `EnableLUA=1`: consent prompts were suppressed, **but the underlying UAC infrastructure was still enabled**. This is the **only UAC configuration tested** with the hidden helper. UAC prompts enabled and `EnableLUA=0` remain untested; users may choose other settings, but we cannot claim compatibility with those settings. BLACKICE does not automatically change UAC settings for other users.

**Recommended Smart App Control setting for unsigned releases: Off.** Open Windows Security → App & browser control → Smart App Control settings → Off. The developer's Windows host previously blocked an unsigned BLACKICE Setup executable under enforcement mode (Code Integrity events 3033 and 3077). With Smart App Control set to Off (registry value 0), a new unsigned console program ran successfully and a complete unsigned BLACKICE NSIS installer built without a new Code Integrity block. That installer has **not** been installed and tested end-to-end. The Windows policy refresh command had hung, so do not claim the policy-listing refresh was verified.

These choices affect the entire Windows computer, including other programs. They are optional user decisions, not modifications BLACKICE silently performs. No paid signing service or additional security-compatibility work is part of the normal release path.

## Startup and guest operation

1. Install or launch **BLACKICE normally**. Its executable requests `highestAvailable` rights; the NSIS installer remains per-user. On the tested administrator runner, the primary and restarted processes retained administrator tokens. Verify actual runtime and Workbench access on the current host.
2. Open **Workbench**. Confirm that its hidden Hyper-V helper reports an administrator token and `Get-VM` inventory access. If authorization fails, the VM inventory remains **Unknown**, never `NotInstalled`.
3. Reuse the existing `BLACKICE-Workbench` VM, its VHDX/AVHDX checkpoint chain, and existing Windows installation. Never reset or recreate them because a query failed.
4. When the guest is verified Running, use the **headless guest screen and synthetic keyboard/mouse**. The developer's VM has already reached an interactive Windows 11 desktop with local guest account `BLACKICE`. Live screenshots (800 × 600), guest-only keyboard, text and clicks were verified without VMConnect or host input.
5. For host–guest files, create or verify the `BLACKICE-Workspace` SMB share and its intended host folder. Authenticate to it **inside the guest**, map `W:`, and run `W:\.blackice-workbench\guest-setup.ps1`. **These steps and guest-agent pairing have not yet been verified**; do not claim app syncing is ready.
6. Reuse the current guest for subsequent application installation. Do not replace the VM or overwrite its virtual disks.

The hidden helper uses the already-tested **Never notify** configuration, runs with no visible PowerShell window, and writes each bounded result to a temporary receipt. A failure is reported, not retried blindly. A guest-only control action does not move the host pointer or type into host windows.

## Inspect the VM; take and cede control

The Workbench console now supports two independent activities:

- **Inspect guest now** captures the isolated Windows guest screenshot without changing ownership. **Start live inspection** periodically refreshes the guest image while the Workbench view is open; closing or leaving the view stops inspection. It never opens VMConnect or captures the host desktop.
- **Take control** temporarily gives the user guest keyboard, typed text, synthetic mouse clicks and paired native-app commands. The server finishes any already-dispatched guest action, then rejects agent input until the user has returned control.
- **Cede control** returns guest input to the agent. A private per-take receipt is needed for user input and ceding, and earlier receipts cannot be reused after ownership changes. If a view loses its receipt, selecting **Take control** again reclaims ownership without guessing. A BLACKICE process restart resets guest control to the agent.

The user may inspect the VM at any time, including while the agent owns input. Agent and user guest actions are serialized so they cannot race through the normal Workbench API. No guest action can automatically take or cede control on the user's behalf.

## Known limitations and verification

- The Browser-tab repair switches the contained WebContentsView to `sandbox: false` because the previous `sandbox: true` view failed to start on the tested machine with Chromium exit code 57. Its browser profile remains separate, Node integration disabled, context isolation enabled, and page web-security setting enabled.
- The Electron executable defaults to **highestAvailable**. The successful manifest-only diagnostic retained elevated primary processes and working restricted children; it does not waive actual runtime or Hyper-V access checks.
- The guest Windows desktop is confirmed; the SMB mount, guest agent, Windows app inventory, and bidirectional file round trip are **not yet confirmed**.
- Windows may render a temporary “Not Responding” ghost window if BLACKICE stalls. That separate, intermittent focus issue still requires diagnosis.
- BLACKICE requests the highest available token on startup, but readiness checks do not silently change UAC, antivirus, firewall, VM lifecycle, host input, or Windows reboot settings.

This is a **use-at-your-own-risk** configuration, described from actual observations rather than hypothetical compatibility claims.
