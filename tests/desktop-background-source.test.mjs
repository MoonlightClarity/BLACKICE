import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP_TOOL, DESKTOP_INSTRUCTIONS } from '../lib/desktop-tools.mjs';

test('the desktop backend has no physical-input or foreground-focus API path', async () => {
  for (const filename of ['windows-desktop.ps1', 'windows-uia.cs', 'windows-native-uia.cs', 'desktop.mjs', 'desktop-tools.mjs']) {
    const source=await readFile(new URL(`../lib/${filename}`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/\b(?:SetCursorPos|SendInput|mouse_event|keybd_event|SetForegroundWindow|SetActiveWindow|SetFocus)\s*\(/,filename);
  }
  const native=await readFile(new URL('../lib/windows-native-uia.cs',import.meta.url),'utf8');
  assert.match(native,/"set_AutoSetFocus", instance, 0/,'native UIA automatic focus is explicitly disabled');
  assert.match(native,/"get_AutoSetFocus"/,'native client verifies automatic focus was disabled');
  const actions=DESKTOP_TOOL.inputSchema.properties.action.enum;
  assert.ok(actions.includes('inspect')&&actions.includes('get_text'));
  assert.ok(!actions.includes('set_value')&&!actions.includes('invoke'), 'the generic tool exposes read-only actions');
  assert.ok(!Object.hasOwn(DESKTOP_TOOL.inputSchema.properties,'x')&&!Object.hasOwn(DESKTOP_TOOL.inputSchema.properties,'keys'));
  assert.match(DESKTOP_INSTRUCTIONS,/never use shell scripts or other tools to inject physical input/i);
});

test('known focus-taking WinForms checkbox actions are rejected rather than retried with input', async () => {
  const source=await readFile(new URL('../lib/windows-uia.cs',import.meta.url),'utf8');
  assert.match(source,/KnownFocusTakingToggle\(element\)/);
  assert.match(source,/WinForms checkbox provider activates its window/);
  assert.match(source,/"hwnd_edit_value"/);
  assert.match(source,/"hwnd_button_notification"/);
  assert.match(source,/No physical-input fallback is available/);
});

test('multiline native editors support semantic text replacement without ValuePattern or focus fallback', async () => {
  const source=await readFile(new URL('../lib/windows-uia.cs',import.meta.url),'utf8');
  const native=source.slice(source.indexOf('private static bool NativeTextControl('),source.indexOf('// Standard HWND controls'));
  assert.match(native,/pid != element.Current.ProcessId/,'native edit recognition verifies current HWND process identity');
  assert.match(native,/kind.Equals\("Edit", StringComparison.OrdinalIgnoreCase\)/);
  assert.doesNotMatch(native,/StartsWith/,'custom edit-like classes are not admitted to the providerless mutation path');
  assert.match(native,/readOnly = \(GetWindowStyle\(hwnd, -16\) & 0x0800\) != 0/,'read-only native editors remain immutable');
  const describe=source.slice(source.indexOf('private static ElementInfo Describe('),source.indexOf('private static string Short('));
  assert.match(describe,/if \(NativeTextControl\(element, out nativeReadOnly\)\)/);
  assert.match(describe,/if \(result.readOnly\) actions.Remove\("set_value"\)/,'native styles can revoke provider-advertised writing');
  const action=source.slice(source.indexOf('case "set_value":',source.indexOf('public static void Act(')),source.indexOf('case "select":',source.indexOf('public static void Act(')));
  assert.ok(action.indexOf('Pattern(element, ValuePattern.Pattern') < action.indexOf('NativeTextControl(element, out nativeReadOnly)'),'an existing provider read-only declaration takes precedence');
  assert.match(action,/if \(nativeReadOnly\) throw/);
  assert.match(action,/if \(BackgroundControl\(action, element, value\)\) return/);
  const write=source.slice(source.indexOf('if (action == "set_value" && edit)'),source.indexOf('bool button ='));
  assert.ok(write.indexOf('0x0800') < write.indexOf('ControlText(hwnd, 0x000C'),'WM_SETTEXT rechecks the live read-only style at dispatch');
  assert.match(write,/3000, out result/,'native editor mutations have a bounded acknowledgement');
});
