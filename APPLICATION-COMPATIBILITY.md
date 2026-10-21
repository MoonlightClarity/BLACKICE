# Windows application support in BLACKICE 2.22

BLACKICE can show and operate a compatible native application inside its Activity surface while its windows live on an inactive private Windows desktop. That is an application compatibility adapter, not a general Windows VM or a file/network sandbox.

## Actual checks on October 18, 2026

These checks used Windows 10 build 19045, the installed application versions below, fresh owned test profiles, and disposable documents. The helper launched an owned process into its job before resuming it. It never switched the input desktop or used the physical mouse, keyboard, or clipboard. Each test had a bounded lifetime and cleanup check.

| Application | Tested version | Observed result | Cleanup evidence |
| --- | --- | --- | --- |
| Classic Notepad | Windows 10 | Passed: owned 875 × 625 window, PrintWindow capture, 24 accessibility controls, exact semantic edit and readback | Owned PID absent after close |
| LibreOffice Writer | 25.8.6.2 | No private window within 15 seconds; five observed job processes exited | Job active count zero; all observed processes exited; complete diagnostics |
| Inkscape | 1.4.2 | No private window within 15 seconds; launcher exited with code 1, child with code 0 | Job active count zero; all observed processes exited; complete diagnostics |
| Krita | 5.2.16 | Two hidden owned windows, zero visible owned windows within 15 seconds; no usable editor surface | Owned process exited during close; job active count zero; complete diagnostics |
| Blender | 4.5 | Installed executable reports a console PE subsystem; current GUI-only admission rejected it before launch | No application process was launched |

The Notepad captured PNG was 11,402 bytes, SHA-256 `e73933ab5656fae5f03932d78c8b3cb238a9a291d479806238986ffcb34bdbc3`. The edit used the observed editor's semantic control and read back `BLACKICE verified private editor update.` exactly. The screenshot was captured before that edit.

Writer was checked with a separate LibreOffice UserInstallation directory and a supplied FODT file. A final flags-only retry removed `--nodefault`; it still produced no private window. Its observed exit 81 is LibreOffice's normal restart request, not sufficient evidence of a crash. The following loader descendants also exited. The tests do not establish why Writer and Inkscape exited or why Krita did not show its editor.

These are five application observations, including four larger apps and a Notepad baseline. They are not five successful integrations. No claim is made for arbitrary documents, sign-in flows, rendering workloads, GPU features, every Windows version, or every installed release.

## What the application now shows

**Activity → Applications → Application compatibility** exposes the tested versions and outcomes. It is informational: only the separately maintained available-app catalog can launch an app. That catalog continues to admit classic Notepad on supported Windows 10 builds.

Startup and cleanup details report a bounded, sanitized subset of the native evidence: startup phase, job/process counts, visible window count, exit codes, and whether observed processes exited. They omit process names, command lines, document paths, and window titles. Truncated or incomplete evidence does not produce a positive cleanup confirmation.

The startup observation window is 15 seconds, inside the existing 30-second launch deadline. An error distinguishes an exited launcher from a launcher still running when the startup wait ended. Closing an unbound failed-history row does not claim to have stopped a process. If only a cleanup request is known, the receipt says so.

## Is a hidden window necessary?

The current helper creates a separate Win32 desktop, binds its helper thread there, and asks the launched app to show its normal window on that inactive desktop. It does not hide or minimize the app on the user's ordinary desktop. Its startup flag is `SW_SHOWNOACTIVATE`, which asks the app to show without activation. BLACKICE receives frames and semantic-control results from the helper. The user's active desktop remains separate.

Windows desktop objects contain windows, menus, and hooks; only one desktop in an interactive window station is the active input desktop at a time. Window-message delivery is scoped to a desktop. Ordinary windows and dialogs created on the private desktop stay on that desktop when activated. These properties provide the foundation for keeping application interaction away from the user's desktop. See Microsoft's [Desktops documentation](https://learn.microsoft.com/en-us/windows/win32/winstation/desktops), [Window Stations documentation](https://learn.microsoft.com/en-us/windows/win32/winstation/window-stations), and [ShowWindow flags](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindow).

The native helper preserves the same desktop rights and owned-job restrictions as the prior version. Launching suspended, assigning the owned job, verifying ownership on each operation, and retaining kill-on-close behavior are part of its contract. The large-app failures do not justify silently removing those boundaries.

## Observe as its own desktop environment

**Observe can present a desktop environment whose normal application windows and dialogs operate separately from the user's foreground desktop. A VM is not a prerequisite.** The native Windows boundary must back that interface; drawing a desktop or window manager in the Observe page alone does not establish it.

There are two distinct Windows approaches:

| Approach | What it provides | What remains to build or verify |
| --- | --- | --- |
| Inactive Win32 desktop in the existing session | The current boundary for owned application windows, dialogs, and semantic controls; the user's input desktop remains active | An Observe window list and layout, owner/modal relationships, dialog routing, and measured capture/control support for each app |
| Independent interactive Windows child session | A separate interactive desktop within a local loopback Remote Desktop session, tied to the existing user session | Native session integration, an agent in that session, display/input transport, lifecycle and cleanup, and actual application compatibility tests |

The first approach can be extended with an Observe window manager that tracks and presents the owned windows on the existing private desktop. A normal modal dialog can remain inside that desktop and be represented in Observe. UI Automation exposes a [window interaction state](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationcore/ne-uiautomationcore-windowinteractionstate) for a parent blocked by a modal window, where the app supplies that information. This does not require moving the dialog onto the user's desktop.

The second approach lets Observe embed the session's view and reuse Windows' native window manager for application stacking, focus, dialogs, and interaction within that session. Microsoft's [Child Sessions documentation](https://learn.microsoft.com/en-us/windows/win32/termserv/child-sessions) describes a local loopback session connected through the Remote Desktop ActiveX control. Only one active connected child session is supported at a time. This is a fuller interactive environment than creating another desktop object within the existing `WinSta0`.

Microsoft's [Power Automate picture-in-picture guidance](https://learn.microsoft.com/en-us/power-automate/desktop-flows/run-desktop-flows-pip) makes the distinction explicit: its child-session mode supports physical mouse/keyboard and UI-heavy work; its same-session virtual-desktop mode is oriented toward UIA/selectors and does not support physical UI actions or screenshots. That product is a reference for the architecture, not a dependency installed or enabled by BLACKICE.

### What 2.22 actually implements

**BLACKICE 2.22 implements neither a child-session adapter nor an Observe window manager.** The native helper can enumerate multiple owned visible windows, but the current application UI requests inspection and capture without selecting a window, so the backend uses the first returned window. There is no window switcher, desktop composition, owner/modal relationship model, or automatic routing to a blocking dialog. This release exposes the supported editor text and preview path plus compatibility and cleanup evidence.

Creating an inactive desktop does not provide a second independent physical input stream or guarantee continuous rendering by an arbitrary app. The current [PrintWindow capture](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow) relies on the target app processing the request and rendering its content. The documented API does not make every application a compatible offscreen renderer. The recorded larger-app failures do not establish a particular rendering, desktop, job-restriction, or profile failure as their cause.

The next bounded step is to track owned windows and dialog relationships and present them within Observe, then verify capture and semantic interaction for that workflow. A child-session backend can provide the fuller desktop environment when the required applications need independent interactive input and presentation. Both remain follow-on work, not capabilities claimed by this release.

### Read-only host readiness check

On October 18, 2026, a separate read-only check reported Windows 10 Pro build 19045 and an installed `mstscax.dll`. `WTSIsChildSessionsEnabled` succeeded and returned false; `WTSGetChildSessionId` reported no existing child session (`ERROR_NOT_FOUND`, 1168). No machine setting was changed and no child session was created. This inventory identifies a possible native integration path; it is not a successful child-session launch, rendering, input, or application compatibility test.

## Adapters for different applications

| Application or task | Preferred direction | Why |
| --- | --- | --- |
| Web content | Embedded/offscreen browser renderer | The host controls rendering and input and can display the result directly inside BLACKICE |
| Document conversion, analysis, rendering, or other supported batch work | Application API, command line, or a specific automation adapter | Avoids dependence on native window visibility and focus for that operation |
| Compatible classic Win32 apps and their ordinary dialogs | Existing private-desktop adapter, extended with owned-window management and measured capability checks | Retains the current window boundary and builds on the working semantic-control path |
| Apps requiring independent interactive rendering and physical input | Native Windows child session whose desktop is presented inside Observe | Reuses a normal Windows desktop and its window manager while keeping session input and presentation separate from the user's desktop |

Electron's [offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering) produces browser content as a bitmap or shared GPU texture. That capability belongs to the renderer BLACKICE hosts; it cannot turn every unrelated executable into an offscreen-renderable app.

Reparenting an arbitrary app window into BLACKICE does not establish a separate desktop or session. Microsoft's [SetParent documentation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent) also records style and DPI-awareness constraints. The recommendation is a common Observe surface backed by explicit native adapters. A VM remains an optional stronger environment when a task needs it; it is not required simply to give Observe its own desktop view or to investigate the Windows child-session path.

## Reproducible evidence

The release evidence includes `probe-blackice-large-app.mjs`, source hashes for the four helper/runtime files used by each final probe, individual `verification.json` records, and the Notepad capture's dimensions, byte count and SHA-256. The image itself remains an internal verification capture. Failed attempts remain identifiable. Owned fresh profiles and disposable fixtures are separate from user documents and saved BLACKICE settings.

Final probe directories in the owned Windows work folder were:

- Notepad: `app-notepad-lWLITD`
- Writer: `app-writer-IsXBUU`
- Inkscape: `app-inkscape-4HEgfS`
- Krita: `app-krita-pd6A6V`
- Blender: `app-blender-sEpu9i`

These probes used an owned, disposable verification work folder on the test machine. Its location is not a product dependency.
