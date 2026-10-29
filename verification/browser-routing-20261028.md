# Contained browser routing verification

## Observed conflict

A globally installed browseros-neo skill claimed automatic precedence over in-app browser tools. In a recurring task, the model selected that alternate browser and retained the selection in its own plan, despite an available BLACKICE contained browser.

The relay_browser handler itself was not forwarding calls to Neo. Its schema permits only the contained driver, and its runtime rejects an explicitly different browser.

## Changes

The developer routing playbook now carries the contained-browser default. Planning context preserves origin and last-update provenance, and the general harness distinguishes assistant-selected methods from actual user requirements.

When relay_browser is attached, the native provider runtime reads effective configuration for the task's working directory, preserves inherited skill entries and their ordering, and appends a scoped browseros-neo disabled-name rule last. This uses supported thread start/resume configuration; it does not rewrite the globally installed skill. Missing skill settings are valid, while failed or malformed configuration reads stop the new turn rather than replacing unknown settings.

## Verification performed during development

- The routing and provenance regressions failed before their corresponding changes.
- The final focused suite passed 37 tests, covering native start/resume, Relay-history continuation, inherited settings, ordering, prompt preservation and failure before model start.
- Native zero-turn diagnostics confirmed the disabled-name selector and last-matching-rule behavior, while preserving an unrelated disabled skill.
- A native thread start rejected an invalid skills.config type with a field-specific error and accepted the valid scoped array. The global skill configuration and installed skill file were unchanged.
- The tested runtime was installed and activated through a completed native restart receipt. The same connection recovered.
- An earlier user-directed plan correction had already restored contained browsing. That earlier behavior is not attributed to the later provider exclusion.

These diagnostics verify the configuration path and selector semantics. They do not directly expose the final model-facing skill catalog. Live browser behavior and external task outcomes are distinct evidence.

## Publication scope

The public checkpoint retains the implementation, synthetic fixtures and regression tests. Personal task records, prompt transcripts, machine-specific activation records and private evaluation outputs are retained outside public Git history. The sanitized release tree's implementation bytes are compared with the completed local development tree before release metadata changes.

Current source-suite and exact-installer results are recorded in the versioned release evidence.
