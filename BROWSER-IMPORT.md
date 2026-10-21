# Browser data import

## Full selected Chromium profile

BLACKICE can copy a complete selected Chrome, Edge, Brave, or Neo profile into a separate browser directory and connect it through the official Chrome DevTools MCP server. The imported copy runs with the **same browser executable as its source**. It does not run inside Electron's contained browser.

The copy includes the selected profile directory, the user-data root's `Local State`, and other shared root data. It preserves the profile's bookmarks, history, preferences, opaque credential databases, extensions and their storage, sessions, local storage, IndexedDB, service workers, CacheStorage, File System data, and sync state. BLACKICE does not decrypt cookies or passwords, export them, inject them into another browser, or rewrite the copied `Local State` or profile preferences.

Automatic discovery covers ordinary Chrome, Edge, Brave, and Neo installations on Windows. Chrome, Edge, Brave, and Chromium have common macOS and Linux discovery paths as well. An explicit absolute user-data directory, profile directory name, and browser executable can be supplied through the library, including for disposable fixtures. Discovery reads profile names and filesystem metadata; it does not inspect cookie or password values.

### Import and connect

Close the source browser normally before importing. Chromium's user-data directory is shared by profiles in that browser, so another open profile in the same user-data directory can keep it locked. BLACKICE reports a running or locked source explicitly and leaves any previous import available. It never closes or kills the source browser.

Use the browser settings panel to select a discovered profile, import it, and connect the imported copy. The direct tools provide the same operations:

| Tool | Purpose |
| --- | --- |
| `blackice_profile_list` | List discovered source profiles and existing imports. |
| `blackice_profile_import` | Import the selected `sourceId`; returns the import's stable ID and snapshot metadata. |
| `blackice_profile_connect` | Connect an `importId` using its original browser executable and copied user-data directory. |
| `blackice_connected_browser_read` | Inspect connections and discover the native browser tools. |
| `blackice_connected_browser_action` | Call a discovered browser tool through the shared connection. |

The desktop CLI in `lib/browser-cli.mjs` reaches these same operations and durable action receipts without starting a model:

```text
BLACKICE browser profiles
BLACKICE browser import-profile --source=SOURCE_ID --request-id=import-001
BLACKICE browser connect-profile --import=IMPORT_ID --request-id=connect-001
BLACKICE browser tools --connection=IMPORT_ID
BLACKICE browser call --connection=IMPORT_ID --tool=TOOL_NAME --arguments-file=arguments.json --request-id=browser-001
BLACKICE browser job --job-id=JOB_ID
```

Use the IDs returned by the previous operation. `--profile-dir=PATH` selects the running BLACKICE profile when needed. A repeated request ID with the same arguments retrieves its saved receipt. The `scripts/browser-cli.mjs` entry point also works with Electron's Node mode. Existing Chrome can instead be attached through `BLACKICE browser connect-chrome --request-id=connect-live-001`; that uses Chrome's existing profile and its native connection setup rather than creating a copy.

### What is omitted

Every omission is returned as a relative path and reason in `omitted` and recorded in the snapshot manifest. Selection and cache rules are narrow:

| Omission | Reason and scope |
| --- | --- |
| Other profile directories | The operation imports the selected identity. Other named profiles, Guest Profile, and System Profile are reported as `unselected-profile`. Shared root `Local State` is preserved byte for byte, even when its profile index mentions other identities. |
| Ordinary browser disk/code/GPU caches | Only recognized cache directories directly under the user-data root or selected profile are omitted as `cache`. The selected profile itself is never excluded because its name resembles a cache. |
| Stale `DevToolsActivePort` | A process-specific debugging endpoint is not reusable in the new browser process; reported as `process-state`. |
| A LevelDB `LOCK` file | Omitted as `process-state` only when sibling `CURRENT` and `MANIFEST-<digits>` identify a LevelDB directory. |

Service Worker `CacheStorage`, worker scripts and registrations, arbitrary nested directories named `Cache`, and unrecognized `LOCK` files are preserved. SQLite `-wal`, `-shm`, and journal data are preserved. Crash reports and other non-cache root data are also retained. A source singleton lock (`lockfile`, `SingletonLock`, `SingletonCookie`, or `SingletonSocket`) causes an explicit busy error before publication, rather than being silently ignored. Links, junctions, and special files within copied data cause an explicit error; the importer does not follow them or silently drop them.

### Copy integrity and replacement

Each import is built in a new staging directory under BLACKICE's data directory. The importer hashes the copied files, verifies the source and destination bytes, checks the source directory structure and native lock markers again, and writes a manifest. It then renames the completed snapshot into place and atomically replaces a small metadata pointer. Import refreshes therefore retain the prior browser directory, including when that imported browser is open. A copy error, changed source, cancellation, or pointer replacement failure leaves the previous pointer and profile intact.

Metadata lives under `browser-profiles/` inside BLACKICE's configured data directory. The native browser payload uses the shorter `bp/` path:

```text
browser-profiles/imports/<stable-import-id>.json
browser-profiles/manifests/<stable-import-id>/<revision>.json
bp/<revision>/Local State
bp/<revision>/<selected-profile>/...
```

Each revision is an independent 96-bit random value encoded as 24 hexadecimal characters. The compact path leaves room for Chromium's deeply nested IndexedDB and CacheStorage filenames on Windows, where some native storage operations still encounter path-length limits. Metadata stays outside the native browser tree. Existing version 1 records retain their original paths and remain readable; the next import creates a version 2 compact copy and retains the prior one. An unusually long configured data directory or source-relative filename can still exceed a native browser's limits.

An interrupted process can leave an unreferenced staging or snapshot directory. It is not advertised as a completed import. A later import can recover an import lock whose owner has exited. Prior snapshots and interrupted directories are retained rather than deleted automatically; disconnect any browser using a copy before removing that copy manually. The native browser owns subsequent changes inside its imported user-data directory. A new import is a fresh source snapshot, not a merge of subsequent changes in the two browsers.

### Native behavior and authentication fidelity

The generated MCP configuration supplies `--executablePath`, `--userDataDir`, and the exact `--profile-directory` argument. It does not combine these with `--autoConnect`, `--channel`, or an isolated/incognito context. Its ordinary mode is a native headed browser; disposable fixtures can request headless mode.

The connection ignores Puppeteer's default flags that disable extensions, background component extensions, sync, background networking, client-side phishing detection, and IPC flooding protection. It also ignores the Linux `--password-store=basic` and macOS `--use-mock-keychain` defaults. This retains the installed browser's normal extensions, native secret-store integration, background behavior, and these native protections. Browser and enterprise policies still apply; this is an official automation connection, and it does not promise identical behavior for every automation-sensitive site.

Copying every relevant file does not prove that an account will remain signed in. Windows app-bound encryption can bind data to the browser application and machine. Operating-system keychains, hardware-bound keys, device-bound sessions, and website session policy can also affect portability. Running the same installed browser under the same operating-system account avoids introducing a different browser's encryption implementation, but it does not establish that every copied credential is usable. Import metadata therefore reports `authentication: "unverified"`; check an actual account page or server response before claiming a working sign-in. Password databases and cookie stores remain opaque throughout the copy.

### Library interface and tests

`BrowserProfileStore` in `lib/browser-profile.mjs` exposes `init()`, `discover()`, `list()`, `status(id)`, `import({sourceId, signal})`, `connection(id, options)`, and `close()`. Explicit imports use `{browser, userDataDir, profileDirectory, executablePath, signal}`. `connection()` returns a normalized official MCP configuration without spawning a browser. The server, direct tools, and CLI share the resulting connection; there is no separate browser permission or per-action approval layer in this library.

Run the disposable unit fixtures with:

```sh
node --test tests/browser-profile.test.mjs
```

They cover byte preservation of opaque browser databases and durable storage, exact non-default profile selection, reported omissions, source preservation, native source locks, changing source files and directory structure, cancellation, failed publication, an actual interrupted subprocess, import-lock recovery, concurrent imports, link and path rejection, compact Windows path budgets, snapshot ownership and collision handling, legacy record compatibility, discovery, and native launch arguments. `scripts/browser-profile-smoke.mjs` performs the separate native-browser regression using a newly created synthetic profile and loopback-only fixture. Synthetic success does not establish personal-account portability.

Primary references for the profile-copy behavior and its limits:

- [Chromium user-data directory layout and concurrent instance limitations](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md).
- [Chromium Windows process singleton lock implementation](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/process_singleton_win.cc).
- [Official Chrome DevTools MCP configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md).
- [Puppeteer's native Chrome launch defaults](https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/node/ChromeLauncher.ts).
- [Chrome's Windows app-bound encryption design](https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html).
- [Chrome device-bound session credentials](https://developer.chrome.com/docs/web-platform/device-bound-session-credentials).

## Neo's native import chooser

Open **Workspace menu (⋯) → Browser → Import into Neo…**. BLACKICE requests the fixed `chrome://settings/importData` page in the installed BrowserOS Neo with its existing profile. The browser can come to the foreground for this explicit action.

Choose the source browser and profile in Neo, review the categories that this installed version offers, and confirm the import there. To decline an import, close the chooser before selecting Import. BLACKICE's receipt records only whether the request to open the chooser was dispatched; it does not claim that data was imported or that an account is signed in.

The destination is **BrowserOS Neo**. BLACKICE's contained Activity browser and its optional embedded ChatGPT tab share a different persistent Electron session. Imported Neo data does not sign those tabs in. The authenticated ChatGPT connector has its own OAuth grant and is independent of website sign-ins.

### Native chooser compatibility

BrowserOS Neo includes native Chromium importer changes. Its public documentation advertises Chrome logins, bookmarks, and extensions. That is an implemented browser feature, rather than a guarantee that every item in a Chrome profile can be copied into any other Chromium application.

The source inspected for this implementation is BrowserOS commit `ca125dcc264d0169389fb065b4e3979578f9819b`, based on Chromium `155.0.8059.26`:

| Source data | What the inspected importer supports or limits |
| --- | --- |
| Chrome browser data | Neo extends Chromium's native chooser and importer with Chrome-specific categories, including cookies and extensions. The installed browser determines which choices are available. |
| Newer Windows Chrome sign-in cookies | The inspected Neo cookie importer explicitly skips app-bound `v20` cookie encryption. Sharing Chromium does not remove this restriction. |
| Device-bound sessions | The inspected code skips known Google device-bound cookies because the corresponding binding state is not transferred. Other websites may also require a fresh sign-in. |
| Firefox browser data | Chromium's Firefox importer covers categories such as bookmarks, history, passwords, homepage, and autofill. The inspected implementation does not import Firefox session cookies. Saved passwords and an already authenticated website session are different things. |
| BLACKICE contained browser | This action does not transfer data into Electron's separate session. Existing contained sign-ins remain owned by that session. |

After importing, open the intended site in Neo and check its actual account state. A transferred cookie or password record alone is not proof that a website accepted the session. This release does not promise seamless import of all Chrome or Firefox sign-ins.

### Native chooser control and privacy

The handoff takes no URL, executable path, profile path, cookie values, or credentials from a caller. It uses the fixed installed Neo executable, existing Neo profile, and native import page. It is a local desktop action; remote clients and agent tools cannot request it. Repeated clicks during the same pending launch share that launch.

This native-chooser action does not parse source-browser cookie databases, decrypt Chrome or Firefox credentials, export cookies, or perform the full-profile snapshot described above. Source/profile/category selection and the final import remain within the browser's own interface. Browser installation and account policies can restrict the available choices.

### Native chooser evidence and sources

Product tests cover the fixed launch target, local authorization, pending launch ownership, maintenance handling, and truthful interface states. Native acceptance opens the chooser in a disposable profile and must record its own observed outcome. It never selects a personal source profile or submits an import. Such a check proves that the chooser is available in that installed build; it does not prove real-account session persistence.

- [BrowserOS Neo documentation](https://github.com/browseros-ai/BrowserOS).
- [Neo's Chrome cookie importer](https://github.com/browseros-ai/BrowserOS/blob/ca125dcc264d0169389fb065b4e3979578f9819b/packages/browseros/chromium_patches/chrome/utility/importer/browseros/chrome_cookie_importer.cc).
- [Neo's Windows Chrome decryptor](https://github.com/browseros-ai/BrowserOS/blob/ca125dcc264d0169389fb065b4e3979578f9819b/packages/browseros/chromium_patches/chrome/utility/importer/browseros/chrome_decryptor_win.cc).
- [Chromium's native import route](https://github.com/chromium/chromium/blob/155.0.8059.26/chrome/browser/resources/settings/route.ts).
- [Chromium's Firefox importer](https://github.com/chromium/chromium/blob/155.0.8059.26/chrome/utility/importer/firefox_importer.cc).
