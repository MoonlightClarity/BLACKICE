# BLACKICE 2.33.6: browser compatibility, responsive input and reliable restart

This update improves the browser and desktop tools used from ChatGPT and inside BLACKICE, with more complete browser-profile copying, steadier sign-in flows, faster browser previews, and a native restart command that can be verified and retried without restarting twice.

## Browser compatibility and input

- Copy a selected Chromium profile into an independent browser directory and connect it with the original browser executable. The copy preserves opaque credential databases, extensions, preferences, sessions, local storage, IndexedDB, service workers and CacheStorage. Import receipts record the copied bytes and specific omissions; failed or interrupted copies preserve the previous import.
- Keep configured Chrome, Neo and imported-profile connections available to authorized agents through their actual native tool catalogs. The contained browser remains a separate profile. Browser dialogs, folder organization and optional filtering are available through the supported tool operations.
- Grant the web capabilities exposed by Electron's permission and device handlers without adding per-site BLACKICE approval prompts. Ad and tracker filtering is an explicit preference; browsing starts unfiltered and filter failures allow requests to continue.
- Correct conditional passkey capability reporting before page scripts run, including frames, restored pages and popups. Electron no longer advertises the conditional passkey-autofill surface it cannot provide. Explicit passkey and security-key requests remain native.
- Follow adopted sign-in popups while preserving their opener and selected-page identity. Repair the zero-sized viewport that could leave an offscreen popup with a blank preview before a sign-in click; temporary viewport emulation is cleared before continuing.
- Accept ordinary bare addresses such as `www.linkedin.com`, as well as supported localhost and IP addresses, through one shared address normalizer in the browser UI, Activity and backend.
- Reduce Activity input delays by coalescing preview refreshes and avoiding native-browser discovery during contained-browser status requests. Ordered input, current-document checks, Stop and cancellation remain intact.
- Return meaningful browser error details instead of empty `{}` results, including through direct-action receipts.

## ChatGPT connection and action receipts

- Keep the credential-tool catalog stable and publish consistent OAuth metadata and catalog fingerprints for connected hosts.
- Preserve unexpired access tokens across refreshes, retain protected retry recovery for a lost refresh response, and distinguish expired or invalid bearer credentials from a fresh account-linking request.
- Add bounded authentication and token-outcome diagnostics to help distinguish server authentication failures from host-side interruptions. Diagnostics contain fixed categories and counts, not token values.
- Recover from proven transient Windows receipt-replacement errors with bounded retries. Each retry verifies the lease, unchanged prior receipt and uncommitted temporary bytes; changed or uncertain storage still fails without replaying the action.

## Native restart and Windows tools

- Make `--restart --request-id=<stable-id>` usable synchronously from an authorized command. A durable scheduling acknowledgment lets the exact originating command finish before handoff; completion is established by the native receipt and replacement process.
- Preserve the request ID across status checks and retries. An identical completed request returns the saved receipt instead of causing another restart.
- Keep Stop, cancellation and grant revocation available while restart preparation is pending. Unrelated unfinished work still prevents a restart; the originating command is identified by an executor-owned binding.
- Retain an explicit legacy-native handoff for one-time activation from older running versions. It is a compatibility path, separate from normal restart completion verification.
- Expose implemented Windows accessibility actions, including invoke, set value, selection, toggle, expansion and scrolling, through current control references. Unsupported controls and native access boundaries report their actual capability errors.

## Known limits and verification

The recurring ChatGPT permission interruption remains unresolved. In the investigated session, the host still reported **Allow all actions**, BLACKICE retained the same seven-scope grant, and a real OAuth refresh succeeded. Those observations do not establish the cause or prove the interruption fixed. Refreshing the existing BLACKICE connection can update stale host tool metadata; it is not a demonstrated cure for approval interruptions.

A complete profile copy does not guarantee a reusable website login. Chrome app-bound encryption, operating-system keychains, device-bound credentials and site policy can prevent authentication in a relocated profile. Connect Chrome can reuse the original session when requested; otherwise sign in normally in the selected browser. Platform permissions and website authentication requirements still apply.

Existing profile data, grants and durable receipts are retained. A downgrade must account for OAuth storage compatibility; restoring an older application file alone does not restore an older profile state.

Use this release's attached verification evidence for the exact version, application fingerprint and Setup.exe hash. Earlier test runs and installer receipts remain historical evidence. The Windows installer follows the existing optional-signing policy; its manifest states the actual signing status. A prolonged production soak and universal website compatibility are not claimed.
