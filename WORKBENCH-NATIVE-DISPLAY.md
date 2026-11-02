# BLACKICE Workbench native VM display

## Current architecture and acceptance state

The selected architecture is a separate native window titled **BLACKICE Agentic Workbench**, backed by the custom FreeRDP client. It uses the existing persistent Hyper-V VM, current guest console and paired guest agent. Detaching the window changes presentation; it does not create a VM, rebuild its disk, replace installed applications, change the shared workspace, or create a separate model-visible desktop.

**Current local-preview gate: PASS, with limited presentation evidence.** The frozen detached helper `9787280bbd0ff9cb50fd506d1492585730ac7c30f89bc61032477f9d241807e7`, with runtime manifest `6f626df59c1cfb05a8464bdf56deb7f39f552e51497c1050941a087c0747b1bb`, has exact-build decoded-motion/input, buffered-presentation self-test, hidden native-session lifecycle and detached-toolbar evidence. `.build/workbench-native-acceptance.json` records `scope:"local-preview"`, `fullAcceptance:false` and presentation basis `buffered-self-test+hidden-lifecycle`. It explicitly records `visibleCompositionProven:false`, `physicalInputToPhotonProven:false` and `temporalPresentationMeasured:false`. This is not clean-host or shipping acceptance; full release acceptance remains false. An unavailable or unaccepted native viewer remains explicitly unavailable; compatibility viewing is a deliberate choice.

**Historical visible-composition result — helper `8258c79302d594496cb66fb1f3f94b6dc41be0a3e554b616968116425c6abad2`.** Its visual report verified actual guest pixels in the native top-level window initially, after reopen, and after resize. Closing its window hid it while preserving connection, capture and owner; reopening retained the same helper and window. Destroying the Electron anchor HWND retained the native process, session, frame access and owner; explicit session destruction cleaned up the helper. Physical DWM window bounds were used for capture comparison. No owned window became the foreground application. The visual probe sent zero host inputs and one explicitly guarded guest-only wake MOVE. These were actual native-window checks, not an Electron page screenshot alone. They do not establish visible composition for the later `9787280b…` executable.

**Historical GDI front-surface result — helper `a510d7b6051794aba124528bf351ca4758c49bafb52a822e74df22018a994e8e`.** Its saved temporal reassessment contains 500 GDI front-surface samples over 4,993.7704 ms, with zero black, flat, invalid-counter or valid-counter-regression samples and 161 distinct valid counters. This is a reassessment of the saved observation, not a new probe. It does not prove DWM/physical presentation and cannot be assigned to the later `9787280b…` executable. Current `9787280b…` acceptance uses its own buffered self-test and hidden lifecycle, rather than inheriting either historical presentation result.

The presentation contract is:

- One app-owned native top-level window contains the renderer's native child. It has an ordinary title bar, minimize, maximize and resize controls. Automatic show/resize uses nonactivating Windows operations; explicit user interaction may activate that window.
- Closing this window hides it and releases held guest keys/buttons. It preserves the same RDP connection, decoded surface and current input owner. Reopening uses that session. Closing a viewer is not shutting down Windows.
- Chat navigation, main-window backgrounding and recreation of the Electron window retain the detached native session. The launcher process and its private control pipe own the helper lifetime. Explicit app shutdown/restart cleans up the helper; losing its launcher or pipe independently ends the helper session.
- BLACKICE reads the same decoded surface that the native renderer paints. Agent input and physical user input retain the authoritative Take/Cede ownership rules. No automatic Take/Cede accompanies open, close, wake or resize.
- Existing shared folders, guest app launch/inspection, app sync, pairing and explicitly selected compatibility viewing remain available in the main Workbench UI.

The detached mode avoids the Chromium/native-child overlap that made an earlier embedded window appear black even while its decoded BMP contained the guest desktop. It must not modify Chromium sibling styles to present its own window.

## Power and input ownership

**Start VM** starts the existing powered-off guest using the existing bounded resource policy. **Shut down VM** requests a graceful guest OS shutdown with plain `Stop-VM -Name ... -Confirm:$false`; it does not use `-Force`, `-TurnOff` or `-Save`. A blocked guest shutdown is an error, not permission to force power loss. [Microsoft documents plain Stop-VM as guest OS shutdown](https://learn.microsoft.com/en-us/powershell/module/hyper-v/stop-vm).

**Wake display** is an explicit bounded request through the connected native RDP session. It queues a benign pointer MOVE under the unchanged current owner. Its receipt says `requested: true`, `queued: true`, `desktopAwakeConfirmed: false`; delivery is not proof that the display woke. Subsequent display health determines whether it remains dark. The UI distinguishes a powered-off VM, a dark decoded display, and a failed/unpainted native window. There is no periodic synthetic-input wake loop.

Take/Cede uses one serialized server queue across guest-agent, Hyper-V and native input. A native ownership acknowledgement, including held-input release, must complete before the server grants the next owner. Uncertain ownership fails closed. Inspection remains available while the user owns control. A valid user-control token authorizes explicit Wake; it cannot authorize the separate agent-native input endpoint. No endpoint uses host mouse/keyboard injection to control the guest.

The authenticated local API is:

| Endpoint | Contract |
| --- | --- |
| `GET /api/workbench/native/frame` | Verified 32-bit BMP, with `X-Workbench-Width`, `X-Workbench-Height`, and `X-Workbench-Sequence`. No Take/Cede. |
| `POST /api/workbench/native/input` | Agent-only `{kind:"mouse",x,y,flags}` or `{kind:"key",scanCode,flags}`. Actual decoded-surface bounds, maximum 4096 per dimension. Rejects while USER/NONE owns input. |
| `POST /api/workbench/native/wake` | Strict `{}` or `{controlToken}` body. USER requires the current token; AGENT needs no token; NONE rejects. Same queue and owner revision fence; no ownership switch. |

The legacy 800×600 console routes retain their existing contract. A missing native adapter returns unavailable; it does not silently substitute a thumbnail.

## Connection and trust

`scripts/workbench-native-host-preflight.ps1` discovers the configured VM GUID, confirms that VMMS owns local port 2179 and obtains public certificate fingerprints from the local VMMS service certificate store. It does not read a private key or trust a fingerprint learned from an unverified network handshake. The client connects only to that discovered VM and pinned local certificate, authenticating with the current Windows logon through native SSPI without a credential dialog.

The implemented path uses FreeRDP's VMConnect transport and classic bitmap/GDI decoding. It does not establish Enhanced Session clipboard or dynamic guest resolution support. The verified guest surface has been 1024×768; resizing the native window scales that surface. Guest RDP settings must not be changed simply to reproduce this already working console path.

BLACKICE's normal Browser/Chat process remains separate from its approved hidden Hyper-V management helper. A working hidden management helper is a prerequisite for host inventory and power actions. Status must report unavailable inventory honestly rather than infer a missing VM or launch interactive elevation. The connection grant, provider login and BLACKICE saved chats are independent of native presentation.

## What has actually been measured

The **current `9787280b…` detached build** passed its five-second run at **1024×768** with **58.997 checksum-valid decoded marker updates/s**. All **30/30 clicks** changed the expected decoded pixels, with **p50 54.912 ms / p95 71.505 ms**. Its source fixture reported **61.518 unique paints/s**. These are decoded-surface results; the separate current presentation basis is buffered self-test plus hidden lifecycle, with no claim of current visible/DWM composition or physical input-to-photon latency.

The **historical `8258c793…` build** passed a five-second run at **1024×768**: **286 CRC-valid decoded marker updates over 5.000407 seconds, or 57.195 updates/s**. All **30/30 clicks** changed the expected decoded pixels, with **p50 58.372 ms / p95 75.298 ms**. The source fixture reported **61.921 unique paints/s**, and its final receipt reported `phase:"closed"` and 30 clicks. There were zero valid counter regressions. That motion report and its paired visual/lifecycle report bind the historical `8258c793…` helper and the runtime manifest listed above.

Historical comparison at the same guest resolution:

| Run | Source fixture cadence | Observed decoded content | 30-click decoded-surface latency |
| --- | --- | --- | --- |
| Revised 33 ms fixture | 30.313 unique guest paints/s | 141 distinct counters / 5.0078 s = 28.156/s | 30/30; p50 45.65 ms, p95 75.63 ms |
| Later 16 ms CRC fixture | 61.406 unique guest paints/s | 287 checksum-valid marker updates / 5.000207 s = 57.398/s | 30/30; p50 48.524 ms, p95 68.505 ms |

The first result was constrained by a roughly 30 Hz fixture; 28/s is not a demonstrated FreeRDP ceiling. Both higher-rate results count checksum-valid decoded markers, not monitor refresh or physical display FPS. Invalid/torn marker samples were excluded, with zero valid counter regressions; this does not prove whole-desktop frame atomicity. The bounded runs preserved the host foreground and published a final closed guest-fixture receipt.

Latency means **host submission to changed pixels in the decoded RDP surface**. It is not physical input-to-photon latency. Repeated EndPaint transactions are not counted as unique guest frames. A static guest desktop legitimately produces fewer updates.

Compatibility-view interaction is a different path. A later real UI request took about 4.28 seconds: its input handler forced a full hidden Hyper-V inventory probe before each command, while recent guest click bodies generally took only 17–100 ms (one took 515 ms). The input methods now reuse the existing **eight-second host inventory cache**, while reading fresh guest-agent state and preserving the same ownership fence; cold or expired inventory still probes and an unavailable/off result rejects input. Start/Stop/setup keep explicit fresh checks. This removes the deliberate per-input inventory launch, not every compatibility cost: its guest agent polls every 850 ms, host receipts poll up to 200 ms, and legacy console keys/types use one-shot hidden PowerShell. The detached native window sends physical USER input directly over its existing RDP connection and bypasses those compatibility round trips. Physical user input-to-photon latency remains unmeasured.

Earlier live checks established pinned-certificate authentication, protocol HYBRID (2), matching the paired guest desktop, agent input rejection during USER ownership, capture/input from the same native session and no helper foreground activation. Older Electron embedding probes tested a different presentation architecture; their success does not prove the detached window's visual presentation.

## Reproducible dependencies and build

Use Windows x64, Node.js 22+, Windows PowerShell, Windows `tar.exe`, Hyper-V management capability and an existing Windows guest. From the repository root:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/setup-workbench-freerdp.ps1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/setup-workbench-freerdp.ps1 -VerifyOnly
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/setup-workbench-freerdp-compiler.ps1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/setup-workbench-freerdp-compiler.ps1 -VerifyOnly
node scripts/package-workbench-freerdp.mjs --output .build/workbench-freerdp-runtime-openssl --smoke
powershell.exe -NoProfile -File scripts/build-workbench-freerdp-client.ps1
powershell.exe -NoProfile -File scripts/workbench-native-host-preflight.ps1
```

Use a fresh output directory for staging. `--verify-only` checks an existing stage. These setup/build commands do not launch a guest viewer, recreate a VM or change global OpenSSL configuration. The host preflight is read-only and is not display acceptance.

The committed inputs are:

- `docs/workbench-freerdp-dependencies.lock.json`: exact FreeRDP **3.32.2-1** and its **133** UCRT64 package archives, versions, SHA-256 values and provenance. Bootstrap is the pinned MSYS2 2026-09-27 archive. Installation replays locked archives without refreshing a moving package index.
- `docs/workbench-freerdp-compiler.lock.json`: separate GCC **16.2.0-6**, **19** pinned compiler packages, at `.build/workbench-freerdp-compiler/msys64`. It does not update the original `.build/workbench-freerdp` dependency root. Compiler verification checks package hashes, exact inventory and installed bytes against archive `.MTREE` records.
- `scripts/build-workbench-freerdp-client.ps1`: C++17 build against the original locked FreeRDP/WinPR headers/import libraries, with static GCC/C++ runtimes. `.build/workbench-freerdp-client-build.json` binds executable, source, compiler lock, runtime lock, runtime manifest and self-test. `-SelfTestOnly` rejects a stale binding.
- `scripts/package-workbench-freerdp.mjs`: recursive PE import closure, pinned dynamic OpenSSL provider/configuration, dependency/license hashes and smoke checks. The development stage contains **92 binaries plus one dynamic provider from 67 packages**, **86 license files**, and **137,400,805 bytes** excluding its manifest. It does not copy the whole toolchain.

The stage has `bin/`, `lib/ossl-modules/legacy.dll`, `etc/ssl/openssl.cnf` and `runtime-manifest.json`. Its generated config activates both default and legacy OpenSSL providers; a public empty-MD4 vector must pass before native connection. `OPENSSL_CONF` and `OPENSSL_MODULES` resolve relative to this runtime root and are passed only to the helper process. Runtime PATH is confined to staged binaries and Windows. The original pinned configuration is retained and derived bytes are verified.

`releaseReady` remains **false**. Nine selected archives omit license texts: FFmpeg, LAME, libtheora, libvorbis, libvpx, libx264, opencore-amr, x265 and xvidcore. Missing notices and applicable redistribution/source/relinking obligations remain unresolved. The public installer does not yet bundle this runtime. Loader smoke tests on this host are not clean-host installation proof.

## Local-preview gate and installed layout

`desktop/workbench-native-runtime.mjs` verifies current helper/source/lock/runtime bytes in development. Packaged operation uses `resources/workbench-native/native-display.json`, with confined relative paths for `helper`, `runtime`, `dependencyLock` and `acceptance`, plus their expected hashes. The runtime path names the stage root, not only `bin`. Packaged operation never falls back to a developer checkout or environment-selected receipt.

Local preview is bound to exact helper/runtime hashes and `scope:"local-preview"`, with `fullAcceptance:false` and `timingBasis:"decoded-surface"`. The recorder distinguishes visible-composition/lifecycle evidence, GDI front-surface temporal evidence plus hidden lifecycle, and buffered-presentation self-test plus hidden lifecycle. The visible path must verify the actual native top-level and guest pixels, unchanged ownership, close-to-hide with retained capture, same-session reopen/resize, no unintended foreground activation and bounded cleanup after launcher/pipe exit. Hidden alternatives retain their explicit presentation limits; they do not establish visible composition or an unmeasured temporal front surface. Every path must bind the exact current build. A CDP/Electron page capture can omit a native window and cannot establish these properties by itself.

For narrow development deployment, preserve the installed `prepareGuestAgent()` block unless its separate native-video bootstrap assets are deployed together. The repository block also reads `install-workbench-guest-video.ps1`, `resources/guest/workbench-guest-video.exe` and `workbench-rdp-preflight.ps1`; an installed app without those assets would fail that action. Do not remove these unrelated source changes merely to stage the detached-view delta.

## Deliberate live verification

Read the help first. The portable measurement command refuses execution without `--live`:

```powershell
node verification/measure-workbench-native-session.mjs --help
node verification/measure-workbench-native-session.mjs --live
```

It requires the existing running, paired, interactive guest, configured read/write workspace mounted at `W:\`, the current verified build/runtime and the caller's existing Hyper-V/VMMS authority. It does not request elevation or recreate the guest. Close another native preview before using this separate diagnostic helper. AGENT ownership must already hold; the tool never automatically Takes or Cedes control.

Defaults come from the repository and current BLACKICE profile/configuration. `--source-dir`, `--app-dir`, `--profile-dir`, `--workspace`, `--output-dir` and `--build-receipt` accept absolute overrides. The current profile's `desktop-runtime.json` identifies the running installed app and its validated local Browser CLI. A workspace override must match the configured share. No development VM GUID, certificate pin or user path is copied into the command:

```powershell
node verification/measure-workbench-native-session.mjs --live --profile-dir (Join-Path $env:APPDATA 'Relay') --source-dir (Get-Location).Path
```

The script verifies build/source/lock/runtime/fixture hashes, freshly discovers VM trust, stages one unique guest-only fixture and launches it once through the paired guest agent. It measures five seconds of decoded markers and 30 alternating clicks, verifies BMP bytes, closes its helper and awaits the fixture's immutable final `phase:"closed"` receipt in the same guest session. Launch uncertainty is not retried. Reports default to `.build/native-verification/<unique RunId>/`; existing output/run IDs are refused. The script does not terminate unrelated guest processes or log credentials/environment variables. The standard guest PowerShell launch path assumes Windows is installed at `C:\Windows`; adapt that path before testing a different guest installation.

A continuous owner/revision monitor and a fresh check before each input close the diagnostic on control change. The standalone helper's final check and command write are **not atomic with the server queue**; Take can race that interval. This is a limitation of the contained diagnostic. Product `/api/workbench/native/input` uses the exact server queue fence. Its isolated native owner-rejection check changes only that hidden helper's mode, verifies `INPUT_REJECTED`, then restores it; it does not grant global USER control.

The separate native-window visual/lifecycle probe runs in the repository's pinned Electron **44.7.2**. Install the locked JavaScript development dependencies with `npm ci` if needed. With AGENT already holding control and another native viewer closed, deliberately show an isolated test window without activation:

```powershell
$workbenchProbeReceipt = Join-Path (Get-Location).Path ('.build\detached-probe-' + [guid]::NewGuid().ToString('N') + '.json')
& .\node_modules\electron\dist\electron.exe .\verification\probe-workbench-native-electron.cjs --visible-composition "--profile-dir=$(Join-Path $env:APPDATA 'Relay')" "--output=$workbenchProbeReceipt"
```

The `--visible-composition` mode selects the detached window. Value options use `--name=value`, and output must be a fresh absolute path. This probe compares capture from the exact native top-level window with the decoded reference BMP, verifies standard window/client geometry, close-to-hide with capture/owner retained, same-helper reopen/resize, and bounded explicit/process-lifetime cleanup. It sends no host input or guest input by default. Add **`--wake-display` only for a deliberate wake test**: it records one benign guest MOVE, requires current AGENT ownership through the running app and monitors for ownership changes; it never Takes or Cedes control. No probe performs a VM start/shutdown or changes guest files. Its report distinguishes observed window composition from physical input-to-photon.

The guest fixture uses an absolute Stopwatch scheduler, actual tick/paint cadence metadata, binary markers and independent final publication compatible with the shared folder. It is verification code, not packaged product UI. Argument/build/trust/ownership/counter tests run without launching a VM fixture:

```powershell
node --test tests/measure-workbench-native-session.test.mjs tests/workbench-native-motion-fixture.test.mjs
```

The visible-evidence recorder command is retained for that separately measured path:

```powershell
node verification/record-workbench-native-preview.mjs --session-report <report> --embedding-report <probeJSON>
```

The current `9787280b…` evidence instead uses the hidden lifecycle and exact-build buffered self-test path:

```powershell
node verification/record-workbench-native-preview.mjs --session-report <report> --hidden-lifecycle-report <hiddenJSON> --buffered-self-test
```

The default output is `.build/workbench-native-acceptance.json`. All paths require real reports bound to the same helper/runtime, at least 24 checksum-valid decoded updates/s at 1024×768, 30 verified clicks, final guest cleanup, ownership rejection and no owned foreground activation. Natural user switches between unrelated applications are recorded truthfully. The visible path additionally requires composed pixels, retained hidden capture, same-session reopen/resize and surviving anchor-window destruction; an old embedded-only report cannot substitute. The historical `8258c793…` build passed that visible path. Current `9787280b…` passed the buffered-self-test plus hidden-lifecycle path, which explicitly records no visible-composition or temporal-presentation proof. No record is shipping acceptance.

## Remaining release work

Longer sustained motion, 1920×1080, physical input-to-photon latency, full keyboard/scroll coverage, clipboard, dynamic guest resolution, reconnect/relogin recovery and clean-host packaging remain open. Maximizing or resizing the native window is not dynamic guest resolution. Features never implemented by the embedded client are not newly supplied by detaching it. Keep explicit degraded-state reporting and the user's VM/application/workspace state throughout this work.

## Historical failures and references

The old PowerShell screenshot/JPEG path took roughly 244 ms per frame. Later GDI/DXGI and SIMD JPEG improvements were compatibility work, not native RDP acceptance. Built-in VMConnect embedding changed the host foreground and was disabled. Stock FreeRDP opened credential dialogs. The custom client removed those dialogs, staged OpenSSL's dynamic legacy provider after an MD4 failure, corrected NLA/extended-security settings, and used the supported classic bitmap path. A bounded explicit guest-only pointer MOVE first woke the sleeping console; this motivated the explicit Wake action. Embedded decoded pixels later remained healthy while Chromium obscured the native child, motivating detached presentation. These are historical diagnoses, not pending instructions to repeat unsafe probes or reconfigure the guest.

Primary references: [FreeRDP 3.32.2 Windows client](https://github.com/FreeRDP/FreeRDP/blob/3.32.2/client/Windows/wf_client.c), [authentication flow](https://github.com/FreeRDP/FreeRDP/blob/3.32.2/libfreerdp/core/utils.c), [CredSSP](https://github.com/FreeRDP/FreeRDP/blob/3.32.2/libfreerdp/core/credssp_auth.c), [Windows default credential acquisition](https://learn.microsoft.com/en-us/windows/win32/secauthn/acquirecredentialshandle--negotiate), and [OpenSSL providers](https://docs.openssl.org/master/man7/ossl-guide-libraries-introduction/).
