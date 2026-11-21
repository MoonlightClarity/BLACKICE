# BLACKICE 2.40.73

This release integrates PR #22 and the ordinary Chat/application continuation fixes on top of 2.40.72. It preserves the later runtime fixes previously installed during diagnostic work.

## Ordinary Chat and completion evidence

- Preserve the current user request across ordinary Chat continuations and bind completion evidence to that request.
- Count completed native tool results accurately and distinguish started, nonterminal, failed, and unresolved work.
- Assess unfinished outcomes through a bounded, read-only reviewer using the selected model, effort, service tier, and delivered instructions.
- Support authorized recovery and report correction while preserving uncertain external effects. Unavailable assessment and persistent nonprogress remain explicit incomplete results.
- Preserve the modular controller's separate acceptance semantics while sharing the outcome assessment implementation.

## Browser and application history

- Surface supported application history in native browser observations, including custom application forms, while distinguishing exact matches from related origin/path context.
- Supply measured screenshot viewport geometry, device pixel ratio, and per-axis image scaling for coordinate actions.
- Reject screenshot captures whose geometry is unavailable or changes during capture.
- Update the bundled completion, job-search, and browser-navigation guidance for delegated writing, delayed confirmation, continuation after failures, and rendered browser obstacles. Existing owner-edited skills remain owner controlled.

## MiniCPM tracing and benchmark infrastructure

- Enforce benchmark deadlines and explicit workspace/Directory tool contracts in the host.
- Capture provider exchanges and expose native trace bindings for reproducible qualification.
- Include reusable trace, parity, lifecycle, and controller code plus self-contained synthetic tests.
- Keep native binaries, models, machine-specific traces, application evidence, and profile data outside the public source changes.

## Verification and qualification limits

Publication requires the final current-source Windows test inventory, unchanged source/fingerprint checks, and the release workflow's exact-installer installation and native runtime validation. Source and installer evidence accompany the release assets.

These implementation checks do not establish a live application success rate. The final ordinary Chat candidate still awaits fresh application and general-task calibration; earlier outcomes from other candidate versions do not qualify it. Delayed email confirmation and visible CAPTCHA solving have not been qualified on this final candidate.

This release does not run or claim the seven-task MiniCPM benchmark, long-context capacity qualification, or tensor parity results. Stopped capacity checks and paused automatic calibration remain stopped.
