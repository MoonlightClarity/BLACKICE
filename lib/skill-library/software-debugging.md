# Diagnose a software bug

Use when behavior is wrong and the cause is not established.

## Locate the first wrong result

1. Start from the exact error, failing test, or visible symptom. Search project contents for the literal error or symbol. Use the file-finding tool for filenames.
2. Read the relevant source or log range, supplying one path per call when the reader accepts a scalar path.
3. Follow the input across the few boundaries that can explain the failure: request, handler, saved state, response, display.
4. Compare plausible causes using an observation that differs between them.

For a local check, use the attached command tool with the actual project directory, focused command, and supported timeout. Read the exit code and output. A skipped assertion, missing dependency, or timeout leaves that check unverified. Build calls from the attached tool schema; declarations found while searching source describe code, not necessarily the running tool.

## Fix and verify

If asked to fix, repair the first boundary where expected and actual state differ. Rerun the failing case and a nearby case affected by the change. If the problem only appears in an installed build, check that build and route; a passing source test may not exercise packaging or saved state.

If asked only to diagnose, report the supported cause and the next check that would resolve any remaining alternative.

Example: a renamed folder reverts after reopening. A successful write and a fresh read both show the new name, but the UI shows the old name. Investigate the reload/cache path rather than rewriting persistence.

For an intermittent failure, preserve the build, input, timing, and observed trace. Failure to reproduce it does not show that it never happened.
