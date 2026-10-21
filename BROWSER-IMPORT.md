# Browser data import

## Use the browser's native chooser

Open **Workspace menu (⋯) → Browser → Import into Neo…**. BLACKICE requests the fixed `chrome://settings/importData` page in the installed BrowserOS Neo with its existing profile. The browser can come to the foreground for this explicit action.

Choose the source browser and profile in Neo, review the categories that this installed version offers, and confirm the import there. To decline an import, close the chooser before selecting Import. BLACKICE's receipt records only whether the request to open the chooser was dispatched; it does not claim that data was imported or that an account is signed in.

The destination is **BrowserOS Neo**. BLACKICE's contained Activity browser and its optional embedded ChatGPT tab share a different persistent Electron session. Imported Neo data does not sign those tabs in. The authenticated ChatGPT connector has its own OAuth grant and is independent of website sign-ins.

## Compatibility

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

## Local control and privacy

The handoff takes no URL, executable path, profile path, cookie values, or credentials from a caller. It uses the fixed installed Neo executable, existing Neo profile, and native import page. It is a local desktop action; remote clients and agent tools cannot request it. Repeated clicks during the same pending launch share that launch.

BLACKICE does not parse source-browser cookie databases, decrypt Chrome or Firefox credentials, export cookies, or copy the user's entire profile. Source/profile/category selection and the final import remain within the browser's own interface. Browser installation and account policies can restrict the available choices.

## Evidence and sources

Product tests cover the fixed launch target, local authorization, pending launch ownership, maintenance handling, and truthful interface states. Native acceptance opens the chooser in a disposable profile and must record its own observed outcome. It never selects a personal source profile or submits an import. Such a check proves that the chooser is available in that installed build; it does not prove real-account session persistence.

- [BrowserOS Neo documentation](https://github.com/browseros-ai/BrowserOS).
- [Neo's Chrome cookie importer](https://github.com/browseros-ai/BrowserOS/blob/ca125dcc264d0169389fb065b4e3979578f9819b/packages/browseros/chromium_patches/chrome/utility/importer/browseros/chrome_cookie_importer.cc).
- [Neo's Windows Chrome decryptor](https://github.com/browseros-ai/BrowserOS/blob/ca125dcc264d0169389fb065b4e3979578f9819b/packages/browseros/chromium_patches/chrome/utility/importer/browseros/chrome_decryptor_win.cc).
- [Chromium's native import route](https://github.com/chromium/chromium/blob/155.0.8059.26/chrome/browser/resources/settings/route.ts).
- [Chromium's Firefox importer](https://github.com/chromium/chromium/blob/155.0.8059.26/chrome/utility/importer/firefox_importer.cc).
