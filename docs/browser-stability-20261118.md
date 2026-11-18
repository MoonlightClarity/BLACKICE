# Browser stability: bounded repair before replacement

Target: ordinary usable browsing, adblocking, saved passwords, folder/tree tabs.
Full Chrome extension or every Chrome feature parity is not a release requirement.

## Existing foundations

- Electron 44.7.2 renders actual Chromium pages. Native live views, popups,
  downloads and ordinary permission callbacks already exist.
- Ghostery's bundled adblocker engine supplies request filtering, with
  EasyList/EasyPrivacy and per-site controls. It is not the Ghostery extension
  and does not provide cosmetic cleanup or scriptlets.
- BLACKICE Passwords supplies an encrypted local vault, save/generate/fill and
  human management. It is not Chromium's native password-manager service.
- The bundled tab-folder extension decorates existing shell tab rows using the
  host collection API. Its nested folders are not Chrome tabGroups.

## Change in this patch

The optional compatibility extension used to be a hard dependency for all
browser startup/navigation/popups. An unavailable or stalled patch must not
disable ordinary browsing. The loader retains one cached bounded attempt;
driver preparation now settles to ready or degraded. Status exposes
compatibility.state and compatibility.verified, with an explicit degraded
message. A late extension completion after timeout is not represented as a
verified recovery, and no duplicate installation is attempted.

Adblock, password storage, folder ownership and browser session persistence
are unchanged. This is not a browser rebuild or a migration.

## Remaining limitations

The compatibility content script still replaces showOpenFilePicker with
read-only synthetic handles, including on human pages, and disables conditional
passkey autofill. These are separate compatibility limitations, not fixed here.
A future native-picker change needs real file open/save/cancel and agent/human
transition coverage, not simply deletion of a script.

CEF Chrome-runtime feasibility was considered but not implemented or downloaded:
the latest scope does not justify a browser-stack migration solely for extension
parity. Existing profiles and the installed app remain untouched.

## Verification

The new browser-compatibility-degraded-live.mjs fixture uses a disposable profile
and an injected failed extension loader. It proves actual native startup,
navigation/rendering and popup creation while status remains degraded.

Focused unit/driver tests cover loader rejection, bounded timeout and late
completion, native view switching/interruption, adblock, password manager and
folder bridge. The real tab-folder fixture checks nesting, drag/drop, collapse,
select/close and restored membership. The real protection fixture checks network
blocking, exceptions and persistence using owned loopback servers.

No broad public-site reliability, password-account login, installed-package
behavior, long-running soak, or full application suite pass is claimed by these
targeted checks. Release integration must run its aggregate checks.
