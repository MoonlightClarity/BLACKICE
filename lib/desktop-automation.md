# Background Windows automation

BLACKICE observes the current Windows session and operates supported application controls through `relay_desktop` without moving the physical pointer, injecting keystrokes, changing the clipboard, or requesting foreground focus. The same semantic actions are exposed in every task mode, with no per-action approval prompts or generic mutation gate. Actual capability is determined by the inspected control's accessibility provider.

The agent starts with `windows`, then `inspect` on an explicit window ID. Inspection returns a bounded accessibility tree, opaque element references and each control's supported actions. Refs remain stable across inspections of a live control, but expire after reconnecting the native worker or when a control is replaced. A stale ref never falls back to a screen coordinate or a different control.

Supported actions are `invoke`, `set_value`, `select`, `toggle`, `expand`, `collapse`, `scroll`, `scroll_into_view`, and `get_text`. Screenshots and window enumeration are read-only. Old coordinate-click, typing, key, and focus requests return guidance to use accessibility refs.

`set_value` accepts replacement text (including empty text to clear a supported field) or a finite number for a numeric control. `scroll` requires a scrollable ref and `direction` (`up`, `down`, `left`, or `right`), with optional `amount` (1–10 steps) and `unit` (`small` or `large`). An action's availability in the tool catalog does not imply that every control supports it: inspect the target, use the actions returned for that control, and verify the result after mutation.

For authorized native application launches and commands, `relay_workspace` provides the operating system shell. `relay_apps` provides its catalog of compatible private application sessions, while `relay_desktop` works with accessible controls in existing Windows applications. The private-session catalog is an adapter compatibility limit, not a global ban on other applications. Choose the adapter that supports the task, preserve unrelated user work, and respect stop, detach and cancellation across tools.

UI Automation actions use a native UIA2 client with `AutoSetFocus=false`, verified before use. The installed Windows UI Automation type library is imported in memory, so no Windows SDK or generated interop binary is required. Standard HWND text fields use `WM_SETTEXT`; standard buttons notify their actual parent with `WM_COMMAND/BN_CLICKED`. Standard native checkboxes update their check state through their control protocol before notifying the parent. These targeted protocols do not inject pointer or keyboard messages.

Some application providers activate a window themselves. Stock WinForms checkboxes exhibit this behavior, and updating their native check state does not update the managed `Checked` value. Relay therefore omits their toggle action and rejects a direct toggle attempt. Use an application integration for these controls. Other application actions can open a dialog or change focus as an application side effect. A mutation that observes a foreground change returns `DESKTOP_BACKGROUND_UNVERIFIED`, retaining the observation and possible completed effects rather than claiming successful background execution. The observation cannot distinguish provider behavior from concurrent user activity. Relay never tries to steal focus back or automatically replay the mutation. A task requiring guaranteed background behavior needs a contained application protocol or private application session; live UI Automation is not that isolation boundary.

Custom game/canvas surfaces, controls without appropriate accessibility patterns, secure desktops, and Windows elevation boundaries are not bypassed. A dedicated application or browser integration is needed for unsupported surfaces. UIA automatically setting focus is disabled; this is not an isolation boundary around arbitrary application code.

Desktop operations remain serialized. Stop, detach, or cancellation aborts queued work and terminates the native worker. An action already accepted by an application may have completed; inspect current state before retrying it.

## Verification

The regular desktop tests cover public tool dispatch of every semantic mutation, provider action metadata, explicit targeting, bounds, unimplemented physical-input requests, serialization, cancellation, stale worker isolation, and native helper recovery. An opt-in live test launches a dedicated stock WinForms fixture offscreen without activation; it never acts on existing user applications:

```powershell
$env:RELAY_LIVE_UIA_QA='1'
node --test tests/desktop-uia.live.test.mjs
```

The test verifies actual text, button count, native checkbox state, selection, expansion and scroll state, with the original foreground window and cursor position unchanged. It also verifies read-only and unsupported controls, stable refs, and expiration after reconnection.

Microsoft references: [control patterns](https://learn.microsoft.com/dotnet/framework/ui-automation/ui-automation-control-patterns-overview), [bounded element traversal](https://learn.microsoft.com/dotnet/framework/ui-automation/obtaining-ui-automation-elements), [disabling automatic focus](https://learn.microsoft.com/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-put_autosetfocus), [button notifications](https://learn.microsoft.com/windows/win32/controls/bn-clicked).
