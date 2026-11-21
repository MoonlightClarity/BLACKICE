# Reproducible native task calibration

This runner exercises frozen ordinary BLACKICE Chat requests through the native app and archives public execution evidence. Job search remains a diagnostic default case; immutable case files let unrelated tasks use the same capture, provenance and recovery path. The runner records observed effects for manual review.

## Legacy job-search diagnostic

Single application:

> Find one suitable job using my existing résumé and preferences. Apply through the employer’s site and verify that the application was received.

Two applications:

> Find two suitable jobs using my existing résumé and preferences. Apply through the employers’ sites and verify that both applications were received.

The runner supplies these exact strings. It sets Planning and Directory off in both the declared and effective mode fields. It creates no Goal and adds no attachments or résumé paths. Model and effort are explicit.

## Prepare a native instance

Use Node 22.23.5 or newer. Run the checked-out source corresponding to the installed app. The runner compares actual product modules byte for byte. For package.json only, it applies the same documented electron-builder normalization as the repository's release fingerprint, then compares every remaining field; it also retains both raw hashes.

The selected BLACKICE instance must have a normal window renderer and a connected provider. From the checked-out repository root, an existing-profile example:

```powershell
$trialRoot = (Get-Location).Path
$trialExe = Join-Path $env:LOCALAPPDATA 'Programs\BLACKICE\BLACKICE.exe'
$trialProfile = Join-Path $env:APPDATA 'Relay'
$trialOutput = Join-Path $trialRoot 'verification\jobsearch-repro\attempt-unique-001'

$trialArgs = @(
  '--profile', $trialProfile,
  '--executable', $trialExe,
  '--model', 'gpt-6-luna',
  '--effort', 'low',
  '--out', $trialOutput,
  '--profile-condition', 'existing',
  '--provider-account', 'reused'
)
```

Choose a never-used output directory for each new task. Confirm the model ID is available in the selected native instance. Another measured configuration is gpt-6.2-astra with high effort.

To exercise fresh installed defaults, use a never-used absolute profile path and launch the supported custom profile in normal window mode:

```powershell
$trialProfile = Join-Path $trialRoot 'verification\jobsearch-repro\profiles\fresh-unique-001'
if (Test-Path -LiteralPath $trialProfile) { throw 'Profile already exists.' }
Start-Process -FilePath $trialExe -ArgumentList @("--profile-dir=`"$trialProfile`"", '--show-inactive') -PassThru
```

Set --profile-condition fresh in that attempt's arguments and wait for native provider startup. A fresh app profile has separate identity, instruction edits, history and contained-browser storage. It still shares the Windows filesystem and can reuse the authenticated account-level provider context. Declare provider-account separately. Do not describe a new conversation alone as a fresh profile.

Record the original applicant sources and normal application-history state separately. Only genuine prior outcomes belong in duplicate-avoidance history. Record any such history copied into a new profile by exact source and hash. Do not inject a test answer packet.

### Choose the working directory

The native app profile and a task's working directory are independent. To use an existing folder, add the same optional --cwd selection to every command for that attempt:

```powershell
$trialWorkingDirectory = Join-Path $env:APPDATA 'Relay\workspace'
$trialArgs += @('--cwd', $trialWorkingDirectory)
```

Choose any existing absolute directory containing the normal task files. The runner records the app's startup working directory separately from the selected run directory, freezes that choice, and verifies the recovered run's effective directory. It sends the selection through the ordinary native workflow and input cwd fields, as normal Chat does for its Local working folder setting. A fresh native profile can therefore share the original working files while retaining its separate profile state; record that shared-files condition in the attempt's provenance.

When --cwd is omitted, the runner continues to use /api/status.cwd. The original job prompts, legacy configuration hashes and saved-admission recovery remain unchanged. Invalid directories and changed selections fail before admission; a recovered run with a different effective directory is an explicit mismatch.

## Frozen ordinary-task cases

An optional --case-file selects an immutable case for the same native runner. Job search remains the default diagnostic when no case file is supplied. The case file contains only this schema:

```json
{"schema":"blackice.calibration.case.v1","id":"ordinary-summary","task":"Review the notes in this folder and save a concise summary in summary.md.","artifacts":["notes.md","summary.md"]}
```

Use an absolute case-file path. The id is a lowercase slug, task is a nonempty verbatim string of at most 16 KiB, and the complete UTF-8 JSON file is limited to 64 KiB. The optional artifacts array contains at most 16 distinct relative file paths using forward slashes, without drive prefixes, backslashes, or . and .. segments. Keep case specifications, expected results, rubrics, and attempt outputs outside the task working directory.

Add --case-file $trialCaseFile to every preflight, start, inspect, and collect invocation for that attempt, together with the selected --cwd. Omit --jobs for an explicit case. The runner submits only task through ordinary Chat; the id, artifact list and evaluation metadata remain observer inputs. It snapshots the original case bytes as base64 plus their SHA-256 in manifest.json, checks source bytes before admission, and uses the saved snapshot for recovery after admission even if the original case file changes or disappears. All available catalogue skill content identities participate in effective preflight provenance.

Declared files are observed before admission and after the exact run settles. artifacts-before.json and artifacts-after.json use schema blackice.calibration.artifacts.v1 and bind caseId, caseSha256, phase, runId, cwd, observedAtUTC, limits, and files. Each complete file row records its relative path, raw byte count and SHA-256; UTF-8 text is retained within 256 KiB per file and 4 MiB total. The existing text and structured secret sanitizer can redact text, which is explicitly marked. UTF-8 BOMs are recognized for structured sanitization. If parsed JSON cannot be sanitized, text is omitted with textOmitted set to sanitization-failed while its raw byte count and hash remain available. Binary content, missing files, directories, read errors and limits remain explicit states. Paths resolving outside the task directory are reported without reading their contents. The observations have journaled hashes and are reused unchanged after collection; a changed saved archive is an error.

These observations establish what was observed, not whether the task was done well. Compare actual artifacts and public behavior with the ordinary request, its explicit limits, and the separately frozen evaluator criteria. Controlled fixtures establish behavior on those fixtures; real external outcomes still require native external confirmation. Preserve every failed case and any effects it produced. The historical runner directory, storage schema and request prefix remain stable so earlier attempts retain their original interpretation.

## Run and recover

From the task root:

```powershell
node .\verification\jobsearch-repro\runner.mjs preflight @trialArgs
node .\verification\jobsearch-repro\runner.mjs start @trialArgs
node .\verification\jobsearch-repro\runner.mjs inspect @trialArgs
```

Inspect the saved preflight before starting: native process/profile binding, installed-source parity, effective defaults or owner overlays, provider readiness, and explicit model/effort. Provider startup may still be asynchronous; the preflight records its state.

Start requires an EventSource-open receipt followed by a fresh observer-health check. It saves an exclusive durable admission intent before posting the ordinary Chat request. The native workflow uses mission_chat_<attempt> so the engine classifies it as ordinary Chat; the independent stable request ID is jobsearch_<attempt>.

Repeat inspect against the same attempt while it runs. Do not send task coaching. When the exact run is settled:

```powershell
node .\verification\jobsearch-repro\runner.mjs collect @trialArgs
```

For two-job continuity, add --jobs 2 to every command for a new attempt. The predeclared observation budget used by this evaluation is 20 minutes for one job and 40 minutes for two. Reaching an observation budget does not mean the task succeeded; reconcile any uncertain effects before another attempt.

If admission or a tool response is uncertain, keep the same output directory and inspect its saved request/run. A missing response is not proof that admission failed. Re-running start after a saved admission intent performs inspection instead of posting a second task. Do not create a replacement attempt to bypass an unresolved admission.

A native process change invalidates the original in-memory observer assumption. The runner reports that change. Capture time/capacity/connection failures remain visible.

## Evidence and manual verdict

Each attempt records its exact prompt/configuration, native process, source fingerprints, effective instruction and skill identities, provider/profile declarations, durable operation journal, run inspections, and complete bounded public capture. The decoder reads only the selected public frontend result and verifies oversized artifact hashes and sizes. Private reasoning and credentials are excluded.

The current observer uses schema 4 and redaction policy public-native-actions-v4. Version 4 retains ordinary source-code, documentation and code-description prose while protecting credential, OTP and security-code fields, including ambiguous Code and Enter code labels. An active observer with another schema is rejected without replacing or relabeling its evidence. Archived captures retain their original schema, policy and interpretation.

Version 3 introduced normalized public native command, file, image and collaboration items. Unsupported public item bodies produce identity-only limitation records. The generic sanitizer and private-reasoning exclusions are unchanged. Version 2 introduced answerEvidence for completed successful native fill/type actions that match an earlier observed, current, nonsecret field. It retains complete cleaned requested text with field and operation provenance under the same capture budget. Missing or ambiguous metadata and secret fields remain redacted. Requested text, a successful field action and a final employer submission are distinct evidence; inspect later edits before drawing conclusions about the submitted answer.

For the legacy job-search diagnostic, a pass requires evidence of all applicable conditions:

- The unchanged ordinary task and declared model/modes reached the provider.
- The agent used the user's real existing materials and honored the actual requested scope.
- The selected exact employer/requisition was reconciled against available prior application history. A blank form alone does not establish that no earlier application exists.
- The first application form and uploaded material are independently inspectable.
- A submission made for the current request has a native employer confirmation tied to that exact role. A model's success statement alone is insufficient.
- No public question or permission request, live coaching, fabricated confirmation, prior confirmed duplicate, or unresolved critical external effect occurred.
- The public capture is complete enough for the conclusion. Redacted field values limit word-for-word factual auditing; state that limitation rather than claiming an unavailable audit.

Preserve every failed attempt and any actual external outcome it produced. Later progress does not erase a displayed question or a duplicate. Previous confirmations do not count as new submissions. Evaluate repeated single-job runs at the same product/prompt/configuration, then two-job continuity. Record fresh-default behavior separately from owner-profile behavior.

## Focused harness checks

```powershell
node --check verification/jobsearch-repro/capture.mjs
node --check verification/jobsearch-repro/runner.mjs
node --test verification/jobsearch-repro/capture.test.mjs verification/jobsearch-repro/runner.test.mjs
```

These checks exercise observer integrity, real ordinary-Chat classification, exact task/modes, recovery, generated-manifest comparison and archive consistency. They use offline fixtures and establish no real submission verdict.

Local profiles, raw captures, applicant material and attempt outcomes are intentionally excluded from source commits by this directory's ignore rules.
