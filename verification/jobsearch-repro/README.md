# Reproducible native job-search trial

This runner exercises an ordinary BLACKICE Chat request through the native app and archives public execution evidence. It performs real applications when the agent follows the request. It does not fill employer forms, choose jobs, supply applicant answers, coach the model, or grade business success.

## Fixed task

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

Capture policy version 2 adds answerEvidence for completed successful native fill/type actions that match an earlier observed, current, nonsecret field. It retains complete cleaned requested text with field and operation provenance under the same capture budget. Missing or ambiguous metadata and secret fields remain redacted. Requested text, a successful field action and a final employer submission are distinct evidence; inspect later edits before drawing conclusions about the submitted answer.

A pass requires evidence of all applicable conditions:

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
