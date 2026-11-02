# Workbench current-state update — October 31, 2026

**Resource allocation update:** Workbench now has one adaptive policy. The manual Light/Balanced/Intensive presets and Save profile control were removed from the active runtime. VM startup memory and CPU are automatically sized from host capacity, with Hyper-V Dynamic Memory used for actual RAM scaling. The older Phase 2 profile descriptions below are historical only.

**Supersedes the historical pre-reboot observations in the Phase 2 checkpoint below.**
Windows has restarted, Hyper-V service and management module are running, and the existing Windows operator was added to Hyper-V Administrators. The current user's process token still lacks group membership until a fresh Windows sign-in. No Windows guest has been provisioned yet and no guest SMB mount is verified.

The persistent guest remains the default because the user prioritizes application compatibility first, reduced friction second, and disk/RAM last. Resource saving must never silently select a restricted compatibility backend.

New implementation: repeatable host installed-app inventory and Windows guest installation batching, with Rescan host apps, Rescan & install missing, and Re-batch saved inventory controls. Saved snapshots are SHA-256 verified, new batches have new run IDs, and guest installed state is checked before and after the winget import. The host's real winget export was tested: 23 recognized packages, with additional unmatched software warnings. Unmatched apps are explicitly preserved for alternative installer handling. Actual guest batch installation has not been exercised because no guest exists.

See **WORKBENCH-SETUP.md** for the current end-to-end human/LLM installation procedure, including re-batching at any time and acceptance criteria.

---

# BLACKICE Windows Workbench — Phase 2 checkpoint

Date: October 31, 2026. BLACKICE version: 2.38.0.

## Goal

A persistent Windows guest for native GUI applications without activating windows
on the host desktop. Allocate guest RAM dynamically, adjust vCPUs by profile, share
the existing BLACKICE workspace read/write, and verify the guest's actual desktop
and effects before reporting success.

## Live host

- Windows 11 Pro x64, 32 GiB RAM, 12 logical processors.
- Hyper-V feature was enabled by an elevated helper with no automatic reboot.
- Receipt: .build/hyperv-enable-20261031.json, completed, restartNeeded=true.
- The host Windows restart is **pending**. Hyper-V VM service vmms is unavailable.
- No valid Windows installation ISO, provisioned guest, installed Windows OS
  in a guest, or verified SMB guest mount.
- Live Workbench API confirms Hyper-V feature enabled, Windows restart needed,
  guest state NotInstalled, and native app execution disabled.

## Implemented and validated

- lib/workbench-provisioning.mjs validates a real ISO file/signature and
  generates an idempotence-guarded Hyper-V Generation 2 VM installer
  configuration: 80 GiB expanding VHDX, dynamic memory, configured vCPUs,
  Secure Boot, vTPM, Windows installer DVD, graceful power policy.
- lib/workbench-guest-bridge.mjs supports shared-folder host↔guest
  command/reply files, strict one-time request IDs, freshness and pairing
  checks, guest screen SHA-256 verified captures, native guest operations.
  Unverified results never authorize host-desktop input.
- scripts/workbench-guest-agent.ps1 must run in an interactive, signed-in
  guest Windows session. It refuses to run on the host computer.
  Supports screenshot, launch, windows, click, paste text, key presses,
  and pairing; interrupted work isn't replayed blindly.
- scripts/workbench-guest-setup.ps1 supports optional credentialed
  SMB-drive mapping inside the guest (without sending passwords to BLACKICE),
  and auto-start at the guest user's next Windows login.
- lib/windows-workbench.mjs handles resources, optional ISO path, VM
  provisioning/start/stop, guest agent preparation/pairing/status/actions.
- Workbench tab UI: ISO path, dynamic resource profile, provision/start/stop,
  host folder mappings, setup, pair, guest screen, native app commands.
- The authenticated server exposes Workbench status, config, provisioning,
  guest preparation/pairing/commands, and verified PNG frames.
- desktop/electron-builder.yml bundles the two guest scripts.
- 294/294 focused regression tests passed (real host UI + simulated guest
  exchange, NOT an installed Windows guest).
- Installed eight changed runtime files with SHA-256 checks and rollback:
  .build/workbench-phase2-manifest-20261031.json and
  .build/before-workbench-phase2-20261031.
- BLACKICE app restarted normally and returned v2.38.0.
- Both prepared guest scripts were copied to the actual host workspace:
  C:\Users\user\AppData\Roaming\Relay\workspace\.blackice-workbench
  and match the tested source hashes. host-info.json identifies the host.

## Next dependency chain

1. Restart **Windows** at a user-safe time. This has not been done.
   Do not confuse it with restarting BLACKICE.
2. Download a legitimate Windows 11 ISO from the official Microsoft source:
   https://www.microsoft.com/software-download/windows11
   and ensure Windows guest licensing, then select the ISO path in Workbench.
3. Provision the named guest BLACKICE-Workbench. Hyper-V permissions may
   require one-time Hyper-V Administrators membership or another elevated
   action; no silent elevated daemon is currently installed.
4. Install and sign in to Windows inside the new guest. A VM that says
   Running does not yet have an interactive Windows desktop.
5. **Not implemented yet:** configure an authenticated host SMB share
   restricted to the Hyper-V guest network. Do not grant network-wide access
   to the entire host filesystem or treat a saved folder mapping as mounted.
6. Inside the guest mount the host BLACKICE-Workspace share to W: and
   run W:\.blackice-workbench\guest-setup.ps1. Then pair from host Workbench.
7. Verify a live guest screenshot, an actual harmless native app launch,
   host write visible to guest, guest write visible on host, and the receipts.
8. Antigravity's BLACKICE tool bridge remains separate: the native CLI
   still does not call BLACKICE relay_task or relay_browser through the
   current subscription adapter. The XML plan still needs atomic child
   steps promoted from flat proposed text.

## Key distinctions

- Windows feature enabled ≠ reboot completed.
- VM created/running ≠ Windows installed or logged in.
- Guest heartbeat ≠ verified pairing.
- Shared-folder configuration ≠ SMB share/mounted workspace.
- Model-described job application ≠ destination-confirmed submission.
- No native Windows guest is installed yet, and no Windows reboot has occurred.
