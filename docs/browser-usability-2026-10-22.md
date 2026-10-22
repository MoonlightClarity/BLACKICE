# Browser usability update — 2026-10-22

## Behavior

- Browser opens with compact tabs, Back, Forward, Reload, and the address field above the page. Secondary controls are grouped under Browser tools, leaving more of the first viewport for the website.
- The new-tab button opens a local address draft. A backend tab is created only after submission. Escape, Cancel, and returning to an existing tab preserve that tab's unsent address.
- Reload navigates the selected page through the existing reload action. Refresh preview remains a separate capture-only control.
- Mouse wheel and trackpad gestures reach the page under the pointer, including horizontal movement and nested scrolling panels. Queued gestures retain their accumulated distance, page identity, and position. Preview updates occur during scrolling without taking keyboard focus.
- Resizing reveals the selected tab and its close button. Deliberate horizontal tab-strip scrolling survives ordinary preview updates. At narrow widths, the address field remains usable and the website starts in the first viewport.
- An overdue preview no longer leaves page input stuck when an IME composition ends. The regression verifies subsequent typing, focus, and later preview updates.

## Verification

The final candidate was verified on Windows with Node 24.13.0 and Electron 44.7.2. UI acceptance used the actual frontend in a disposable Edge profile with controlled fixture pages. Native scrolling used a real hidden Electron page and a local fixture server.

| Verification | Result | Coverage |
| --- | --- | --- |
| Seven regression suites | 213 passed; 0 failed, cancelled, or skipped | Command validation, native adapter, browser rendering, tabs, keyboard input, folder tree, rendering performance |
| UI acceptance | 66 checks passed; 8 screenshots | 1440, 1100, 780, 390, and 320 pixel widths; native form submission; drafts; tab closure; reload versus capture; wheel cancellation and delivery |
| Native scrolling acceptance | 8 checks passed | Both axes, nested scrollers, reversal, document scrolling, trusted cancellable events, stale-document rejection, owned-tab closure without desktop focus |

The UI run observed no uncaught frontend errors, external website requests, or model calls. Candidate files were unchanged during acceptance. Both disposable browser verification environments closed their owned pages and removed their temporary profiles.

Two acceptance-driver corrections were made during validation: Enter now includes the native character event required for implicit form submission, and event cancellation is sampled after dispatch rather than in an early capture-listener microtask. Final checks retain trusted-event and cancellation assertions.

### Commands

Run the regression suites from the repository root:

```sh
node --test --test-reporter=tap tests/browser-policy.test.mjs tests/browser-contained-driver.test.mjs tests/observe-browser.test.mjs tests/observe-tabs.test.mjs tests/observe-keyboard.test.mjs tests/browser-tree-ui.test.mjs tests/observe-render-performance.test.mjs
```

Run UI acceptance with an available Edge installation:

```sh
node scripts/verify-browser-usability.mjs --candidate . --stage after --out /path/to/ui-evidence
```

Run the native wheel fixture with a raw Electron executable:

```sh
node scripts/verify-browser-rebuild.mjs --wheel-only --electron=/path/to/electron --out=/path/to/native-evidence
```

### Verified production files

| File | SHA-256 |
| --- | --- |
| `desktop/browser-driver.mjs` | `2963a14dcff9d08071283b49b2fdcf8d94e0649a0fd4c3c85ac52fd4c993fd18` |
| `lib/browser-command.mjs` | `9949879449730804ac3900b97e88150e28e14f941ec890e70bafc6b0c0f8c3fd` |
| `public/observe-ui.mjs` | `143d1d95c91e7484602d233813018e9e59183bcdc9a7833692f00c3d9f557559` |
| `public/observe.css` | `ab35058826a95f47bd9f553f722e99227d75aca6703132f692736e0cfe132fbc` |

## Approval-prompt tracking

The user reported during this task: **task 1 after removing classification hints still required an approval prompt, and they clicked Always allow.**

The permission issue remains open. This result does not establish whether Always allow persists into a subsequent task. The next separately initiated task is the next persistence check.

This browser update does not modify the public tool catalog or connector package. The catalog source file remains at SHA-256 `ca78957bb25341c57622c805d70d80497d4f03d3f6c745cf2f9df0ea2663cf5e`; the prior classification-removal baseline is preserved.
