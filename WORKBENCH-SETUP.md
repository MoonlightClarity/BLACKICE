# BLACKICE Workbench — End-to-end setup and repeatable app sync

**Priority: compatibility first, low friction second, disk and memory use third.**
Default backend is a **persistent Windows guest on Hyper-V**, not the restricted private Win32 desktop. This supports a much wider range of installed Windows applications, although hardware drivers, GPU features, anti-VM, DRM and some licensing schemes can still impose compatibility limits.

**Current state as of 2.39.27 (November 7, 2026):** The existing development guest reached an interactive Windows desktop. Release 2.39.26 verified **Pair & auto-repair** on that guest: a fresh guest-agent heartbeat and pairing challenge, bidirectional shared-folder access, a guest screenshot, and automatic remount of `W:` after a deliberate disconnect. The running guest, installed applications and virtual disk were preserved. These observations do **not** establish that a new user's VM is ready, that every application works or that the separate native viewer has passed full visible/physical acceptance. Always inspect this machine's live Workbench readiness and observed receipts. Do not drive or interrupt the host desktop to stand in for guest control.

## Current setup shortcut

For a supported Windows host with an **already installed, signed-in guest**, open **Workbench**, inspect the current guest status and use **Pair & auto-repair**. BLACKICE prepares a dedicated host share account and credential, sends bootstrap files with Hyper-V `Copy-VMFile` even if `W:` is missing, starts the guest agent, and installs a guest-local reconnect watcher. The watcher checks the share every 15 seconds while signed in and can recover from stale mounts and host-IP changes. Verify its heartbeat and host↔guest read/write test before describing pairing as complete.

For a new guest, follow Steps 1–3 first. Do not recreate an existing VM to fix pairing. Use the [in-app Workbench Setup guide](public/next/workspaces/workbench-guide.mjs) for current UI labels; this Markdown page provides the accompanying operational reference.


## Step 1 — Check existing Windows prerequisites

Use the Workbench tab for the host/guest status. Check Windows 11 Pro/Enterprise/Education x64, hardware virtualization, Hyper-V feature, VM service, free RAM, disk and Windows Package Manager.

~~~powershell
(Get-CimInstance Win32_OperatingSystem).Caption
Get-CimInstance Win32_OptionalFeature -Filter "Name='Microsoft-Hyper-V'" |
  Select-Object Name, InstallState
Get-Service vmms,vmcompute -ErrorAction SilentlyContinue
Get-Command winget.exe -ErrorAction SilentlyContinue
~~~

If Hyper-V is already enabled and VM service runs, **skip enablement**. Only if missing, use administrator PowerShell:

~~~powershell
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All -NoRestart
~~~

If Windows requires a reboot, save user work and obtain authorization for a Windows reboot. Restarting the BLACKICE app does not restart Windows.

If the existing background Windows token cannot query Hyper-V, **Workbench must remain blocked**. Do not automatically raise UAC, launch an elevated PowerShell process, sign out, reboot, foreground Hyper-V Manager or move keyboard/mouse focus. A preauthorized background VM-management token or genuine headless service/broker is required. An administrator may separately prepare Windows permissions outside the Workbench feature, but this application never prompts or interrupts the host to obtain them. A group-membership change alone does not refresh an already-running Windows token. The existing VM and virtual disk must be preserved until a compatible background backend is available.

## Step 2 — Obtain a genuine Windows installation ISO

**The complete guide is also embedded directly in BLACKICE's Workbench tab**, under **Complete setup guide — for you or an LLM agent**. No repository access is required to read it.

First choose **Find existing ISO** in Workbench. BLACKICE searches common local download/media folders and validates plausible Windows 11 installation images without copying or downloading them. When it finds exactly one, it can reuse and save that path; with multiple candidates, choose one. The installed host Windows operating system cannot be used as a bootable VM installer without creating separate installation media or a prepared guest image.

If no reusable ISO exists, obtain official Windows 11 installation media from [Microsoft's Windows 11 download page](https://www.microsoft.com/software-download/windows11), then run **Find existing ISO** again. The current in-app setup guide does **not** automatically launch Microsoft's interactive Media Creation wizard or take host desktop focus. The common `Windows.iso` name is recognized. The installed host OS alone is not bootable guest media; follow guest Windows licensing. BLACKICE checks ISO structure and size, which do not independently prove origin or full contents.

## Step 3 — Provision once, persist forever

After Hyper-V management works, use Workbench to provision the dedicated BLACKICE-Workbench VM. The provisioning script creates a Generation 2 VM with Secure Boot, virtual TPM, dynamic memory and expanding VHDX, and refuses to overwrite a preexisting VM/disk. It needs a valid Hyper-V virtual switch. Start the VM, install Windows inside the guest using VMConnect only for initial setup, and log in to a guest Windows account. Keep the VM and its settings/app installations between tasks. Running is not proof that Windows has finished installing.

## Step 4 — Connect host and guest filesystem

In Workbench choose **Prepare guest files**. The host puts guest-agent.ps1, guest-setup.ps1 and host-info.json into the .blackice-workbench folder of the actual BLACKICE working directory.

**Automatic pairing is the normal path.** Open the existing running Workbench VM and use **Pair & auto-repair**, or let an explicitly authorized agent call the Workbench auto_pair action. BLACKICE should handle this entire chain without requesting a password or manual guest setup:

1. Prepare the guest agent in the configured host workspace. Reuse or create the dedicated BLACKICEWBLink host account and its BLACKICE-Workspace share, generate a working password, and apply its read/write folder rights.
2. Deliver the guest-local pairing bootstrap, generated credential and reconnect watcher via the Hyper-V **Guest Service Interface** (Copy-VMFile). This works even if W: is absent or mapped to a stale Default Switch IP. Do not bootstrap by requiring the broken W: mount.
3. Transfer authorized VM input to the agent, use only the native Workbench guest input surface to start the guest-local pairing bootstrap, and return the user's previous input ownership afterward.
4. Inside the guest, save the generated share credential to the guest user's Windows credential store (encrypted through Export-Clixml), connect W: and verify real bidirectional read/write access. Run W:\.blackice-workbench\guest-setup.ps1 and complete BLACKICE's host-to-guest-to-host nonce challenge.
5. Install a **guest-local** reconnect watcher that starts at every guest user sign-in and checks the shared drive every 15 seconds while signed in. On guest resume, hostname/IP changes, lost SMB sessions or agent crashes, it removes a stale W: session, resolves the current host by name with an actual gateway fallback, reconnects with the saved credential, and relaunches the guest agent/video process when needed. The watchdog must not depend on W: to launch.
6. Verify W: again after an actual disconnect/reconnect test. A one-time mount is not finished work. Report separate outcomes for the Hyper-V bootstrap, current W: mount, persistent watcher, agent heartbeat, pairing receipt and file read/write roundtrip.

Do not turn pairing into a manual password prompt; the explicitly authorized agent may create and use the dedicated host-share password. The VM, user applications and VHDX are never recreated to repair a disconnected share. Windows still requires an interactive guest login for native desktop access.

## Step 5 — Run the native app smoke test

Capture a real guest screen, launch a guest-installed native application (such as Notepad), inspect its window, type text, and confirm no host foreground takeover. Write a disposable test file on the host and read it inside the guest; write another in the guest and read it on the host. These observations must be recorded before Workbench reports ready.

## Step 6 — Initial bulk installation of host apps

Compatibility and low friction matter more than preserving disk. **Do not copy the host Program Files tree**; normal applications have registry, services, drivers and runtime dependencies inside their OS. Instead reproduce the recognizable package inventory in the persistent guest with Windows Package Manager.

Host:

~~~powershell
winget export --output "$env:TEMP\blackice-host-apps.json" --accept-source-agreements
~~~

Put the manifest into the authenticated shared workspace. From the guest, import it (one command):

~~~powershell
winget import --import-file "W:\blackice-host-apps.json" --no-upgrade --ignore-unavailable --ignore-versions --accept-source-agreements --accept-package-agreements
~~~

Installed packages are not the same thing as all host apps. Workbench's **Rescan & discover installers** action also searches Windows Package Manager for applications that the initial export could not recognize. It uses the installed application's Windows publisher metadata to verify any otherwise exact-name catalog match. Matching names with different publishers (for example two unrelated programs named Reveal) are **not** automatically substituted. Hardware drivers, OS components and companion services are tracked separately from user applications. Verified matches are appended to a separate, checksum-bound immutable guest import manifest; the original host inventory remains unchanged. Unmatched programs, ambiguous editions, required user intervention, software licenses and failures stay visible as **exceptions**, not successes.

## Step 7 — **Rescan and re-batch missing apps whenever requested**

The application sync must **never be one-shot**. After the first batch, expose a normal Workbench **Rescan & install missing / Re-batch saved inventory** action, which may be used repeatedly: after installing more host apps, after troubleshooting an exception, or months later.

Each pass must:

1. **Re-export current host inventory** (or reuse an explicitly selected snapshot) and preserve its SHA-256/hash and timestamp. Rediscover unmatched app installers and compare observed publisher evidence before augmenting the import.
2. **Inspect actual guest installed state** rather than trusting old receipts or only a reported exit code. Keep each run bound to its exact immutable source and import hashes.
3. **Skip already installed apps by default**. Do not uninstall, force reinstall or upgrade them.
4. **Install missing recognized packages**, retry missing/failed packages, and leave package-specific exceptions in a single report.
5. Save a **new run ID** with per-package result: installed, already present, unavailable, failed, or uncertain. A missing response is not a confirmed failure or success.
6. Support another manual re-batch immediately, with no guest reinstall and no prior batch lockout.

Windows winget import with no-upgrade is safe for a simple repeatable pass; for trustworthy per-package receipts, query installed state and run each package separately. A crash-interrupted install must be reconciled with the guest's real installed state before another attempt. For an app winget cannot identify, reuse an appropriate legitimate guest installer and record it as an exception rather than micromanaging every other app.

## Step 8 — Preserve state, diagnose failures

A dynamically expanding VHDX reserves guest virtual capacity but does not occupy the full maximum on day one. Workbench resource allocation is **adaptive only**: there are no Light, Balanced, or Intensive controls. BLACKICE uses measured host resources to choose startup memory and vCPU capacity, reserves RAM for the host desktop, and lets Hyper-V Dynamic Memory expand and contract the guest RAM as needed. The virtual CPU count is chosen automatically before guest startup; Windows schedules actual CPU usage dynamically. **Do not sacrifice app compatibility for disk savings**, or rebuild the guest simply to retry app installs.

If Hyper-V service is down, inspect feature/reboot; if Get-VM denied, verify new Windows logon and group membership; if a VM already exists, reuse it; if an ISO is invalid, obtain real media; if guest app capture fails, do not substitute host screen input; if SMB is missing, do not claim filesystem sharing; if an app install fails, preserve the failed package receipt and make it eligible for a later re-batch.

## Contract for LLM agents executing this guide

Run steps in dependency order and verify observable results. Reuse an existing Hyper-V feature, guest, disk, installer/media, shared folder and existing package manifests. Do not invent successful actions. Require authorization before Windows reboot or destructive VM modifications, and do not accept a license or install unknown drivers without appropriate user action.

**Acceptance:** guest Windows OS installed and interactive; host foreground stays unaffected; screenshot and app operation verified; bidirectional file test passes; first batch produces per-package results; **second batch repeats successfully, skips present packages and retries missing ones**. Until that happens, Workbench is configured but not fully operational.

Official docs: https://learn.microsoft.com/windows/package-manager/winget/export ;
https://learn.microsoft.com/windows/package-manager/winget/import ;
https://learn.microsoft.com/windows-server/virtualization/hyper-v/powershell-direct .
