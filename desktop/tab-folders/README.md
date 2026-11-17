# Bundled Tab Folders extension

The desktop app loads desktop/tab-folders as an unpacked Manifest V3 extension into its **app-shell default session**, not the agent browsing partition. It decorates the existing tabstrip, moving existing tab DOM rows rather than rendering a second browser panel. Native select/close listeners stay attached. A folder's menu opens a small inline editor; tab context menu and drag/drop change membership.

## Why a host bridge
Electron 44.7.2 does not implement Chrome tabGroups or tabs.group/ungroup/move/create. Its embedded webContents are BLACKICE tabs, not Chrome UI tabs. The extension therefore uses a small DOM protocol in browser-folders.mjs. The model carries existing tab IDs and collection membership; four existing collection actions are forwarded to /api/browser/action. The extension has no storage, credentials, tab permissions or separate folder database. Existing driver persistence and ownership stay authoritative.

Reference: https://www.electronjs.org/docs/latest/api/extensions
A disposable real Electron probe confirmed unsupported APIs. No full Chrome tabGroups compatibility is claimed.

## Fallback and packaging
desktop/electron-builder.yml explicitly includes all extension assets with asar:false. Failure to load the extension is logged, but ordinary tabs remain available. A server-served browser without this extension gets the ordinary ungrouped tabstrip, **not** the previous parallel folder panel. Collection data remains intact and is available when the desktop extension loads. No automatic install into other browsers.

## Verification
tests/fixtures/tab-folder-extension-live.mjs runs in a new explicitly supplied output directory and profile. It loads the actual extension under Electron and manipulates real hidden ElectronBrowserDriver tabs through BrowserWorkspace: nested folders, context-menu membership, drag/drop membership, collapse after refresh, rename/remove preserving tabs, native select/close, and persistence restore. Localhost synthetic pages only. No live profile, jobs, release or installer.

The previous host-panel assertions are preserved verbatim in tests/retired/browser-folder-host-panel.test.mjs.txt as historical evidence, replaced with bridge assertions and actual-extension tests. Pure hierarchy/legacy profile tests remain active.

Collapse/editor drafts are presentation-only and last for the current tabstrip instance. No extension-owned persistent state is added. Visual polish and actual installed-package verification remain release integration tasks.
