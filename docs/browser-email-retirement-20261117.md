# Built-in browser retirement cleanup (2026-11-17)

Base candidate: 150d76ad8a1adc09b457bffd4140722a33a0b0e3, not installed .101.

Normal server startup already retires Himalaya/Thunderbird: no default email store/OAuth adapter and /api/email returns EMAIL_RETIRED. The old composer launcher had no callers. It is now removed. Browser email uses ordinary contained-browser actions; no dedicated replacement composer or special send wrapper is introduced.

Firefox was still initialized as a lazy desktop adapter, discovered profile metadata and exposed conditional manual UI/disconnect. This patch removes that registration, desktop import/init, router selection, UI section and HTTP disconnect route. The built-in relay driver retains popup, folder, credential, upload and ordinary action forwarding. Unsupported old adapter names fail normal argument validation, not a new approval/history gate.

Historical opt-in tests for Firefox, Himalaya and the old native composer are archived as .txt under tests/retired and excluded from active test discovery. Legacy implementation helpers and their unit tests remain unwired; their presence does not qualify them as current features. The former multi-browser router test source is archived; contained router, popup and retirement coverage remains active.

No user profiles, saved credentials, mail records or live browser/task state were touched. The separate manual password-manager export destinations remain unchanged; Firefox there is not an automation adapter.

Validation: 73/73 focused tests across browser router, UI, workspace and historical composer helpers; new tests cover no external adapter registration/calls, ordinary webmail action forwarding, and source wiring retirement. No live mailbox/send, real provider, UI automation, installation or full suite run.

Release implication: this changes the source candidate and must be integrated, rebuilt and qualified before replacing the already-built .102 artifact. Old opt-in fixture skips must not be described as missing qualification of the current email/browser architecture. Actual contained-browser sign-in and webmail flow still need their own relevant acceptance.

Review correction: retained active single-driver tests for unknown targets, contained show behavior, changed-event listener cleanup, idempotent/concurrent close failure sharing, folder creation without an active tab and releaseOwner forwarding. Original historical multi-browser fixtures remain unchanged.
