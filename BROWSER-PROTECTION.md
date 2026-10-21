# Browser tabs and request protection

BLACKICE provides a tab strip and optional embedded ad and tracker filtering in **Activity → Browser**. Browsing starts unfiltered; people and authorized agents can enable filtering when wanted.

## Tabs

Enter an address and choose **New tab** to open another page. Select a tab to hold that page in the Activity viewer. The separate **Follow active page** control follows the page being used by the agent. Background browser work can continue while you inspect another tab.

Each tab has a close control. Closing the selected tab selects a neighboring page; closing a background tab keeps the current selection. Left/Right, Home and End select tabs from the keyboard, and Delete closes the focused tab. Long titles truncate within the strip, which scrolls inside narrow screens. The address field keeps a draft for each tab through status updates and tab switching.

Tabs share BLACKICE's existing contained browser profile and sign-ins. They do not attach to personal Chrome or Firefox windows. The existing saved-tab recovery continues to defer page loading until a restored page is used.

## Ad and tracker protection

Filtering starts disabled. Bundled snapshots of **EasyList** and **EasyPrivacy**, using the **Ghostery adblocker** engine, are ready for an explicit opt-in. The implementation filters requests in the contained Chromium browser session. It does not require a browser extension installation or a first-start download.

The Browser surface shows whether protection is ready, whether the current site has an exception, the observed blocked-request count, and filter-list status. In its protection controls:

- **Site protection** allows or blocks matching requests for the displayed site's exact origin. The server checks the current tab and origin again before saving an exception. If the page changed, inspect the new page and make the choice again.
- **Global protection** changes the saved setting for the contained browser.
- **Refresh lists** requests the two known HTTPS list sources, validates the downloaded data, and retains the last usable filters if retrieval or parsing fails. Refreshing does not enable filtering.

Site exceptions and global preference are saved in the BLACKICE profile. A person can change them through the browser interface, and an authorized agent can use `relay_browser` with `action: "protection"` and `operation: "status"`, `"global"`, `"site"` or `"refresh"`. Direct ChatGPT clients read status through `blackice_browser_read` and change preferences through `blackice_browser_action`, using their existing browser scopes. Site operations retain observed-tab and exact-origin checks.

If lists cannot load or the filtering engine throws while matching a request, the request is allowed and the filter error is reported. An unreadable preference file is preserved and the browser remains unfiltered. Blocked-request counters include only actual matches that were blocked while filtering was explicitly enabled.

### Saved preference migration

The previous settings format stored `enabled: true` both for an explicit global enable and for site-only edits that inherited the old default. It cannot distinguish those cases. Those legacy true values are loaded as disabled, with their site exceptions retained; legacy disabled choices stay disabled. The original file is preserved until the next explicit preference change. The current format persists new explicit opt-ins and restores them across restarts. Status identifies an ambiguous legacy enable as `preferenceSource: "legacy-default-disabled"`.

## Scope

Blocking prevents network requests that match the supported rules. It reduces exposure to matching advertising and tracking resources; it does not establish that a page, download, or other request is safe. A blocked counter records actual decisions by this browser's request hook, rather than estimating all ads on the page.

This integration uses network filtering. It does not add cosmetic page cleanup, third-party preload scripts, scriptlets, or the full uBlock Origin extension. It does not change other installed browsers or filter BLACKICE's model/provider traffic. Filtering is separate from web capability grants: BLACKICE grants Electron's permission-request, permission-check and device-permission callbacks by default. Operating-system authentication, website challenges, device selection and runtime support remain their own requirements. The contained browser retains its separate session and offscreen window behavior.

## Components and attribution

The bundled engine is `@ghostery/adblocker` **2.20.1**, built as unminified ESM with `FiltersEngine` and `Request` exports. Package sources and included licenses are preserved in `lib/vendor/adblock-source.json`. Decode its `data` field from base64 and gunzip it to read the original `records` and `files` objects. Integrity digests and complete notices are in `lib/vendor/ADBLOCK-NOTICES.md`.

EasyList and EasyPrivacy are attributed to **The EasyList authors (https://easylist.to/)** and distributed under **CC BY-SA 3.0**. Their original comments are preserved in the concatenated, losslessly compressed snapshots. The bundle records each source URL, original size and SHA-256 digest, along with its fetch time and the combined data digest.

Primary references:

- [Ghostery adblocker project](https://github.com/ghostery/adblocker)
- [EasyList and EasyPrivacy](https://easylist.to/)
- [EasyList licensing](https://easylist.to/pages/licence.html)
- [Electron webRequest API](https://www.electronjs.org/docs/latest/api/web-request)
- [Electron extension support](https://www.electronjs.org/docs/latest/api/extensions)

## Validation

The release checks combine model-level browser UI tests, real rendered Activity journeys, and an isolated Electron request-blocking fixture. The native fixture uses a disposable browser profile and controlled pages; it does not use personal sign-ins or infer general website compatibility from one test. See `UI-VALIDATION.md` and the update's acceptance reports for the exact completed checks.
