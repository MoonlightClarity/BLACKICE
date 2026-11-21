# Native MiniCPM qualification and comparison

This extension makes the existing benchmark controller durable and connects its evidence checks to observed provider and runtime data. Importing a controller or running its tests does not start a model. The native driver returns the exact BLACKICE operation to submit; the caller performs that operation and returns its saved receipt.

A coding comparison is valid only after the application instructions, tool boundary, model identity, context, sampler, runtime, and capture path have been observed and qualified. A passing fixture suite establishes implementation behavior for those fixtures. It does not establish a MiniCPM score.

## Stages and current source gates

| Stage | Responsibility | Evidence required |
| --- | --- | --- |
| Instruction/workflow qualification | Run the unscored D0 task against the actual model and current instructions | Exact first request, accepted adapter audit, observed run/thread/turn, saved files and public command, settled native evidence |
| Runtime qualification | Observe the actual loaded context and effective settings | Model and executable hashes, process/context identity, current startup receipt and matching runtime properties |
| Capture parity | Establish what changes when activation capture is enabled | Same instrumented binary, same request bytes and token sequence, explicit cache state, complete trace, controlled off/on comparison |
| Settings calibration | Choose a llama.cpp profile for the intended coding workload | Bounded repeated comparisons of latency, throughput, memory use, context capacity and correctness, with the chosen objective and profile recorded |
| Guarded campaign | Execute the frozen difficulty 1–7 comparison | Matching observed admission and final conditions, complete controller state, exact saved evidence for each arm |

## Observed results and qualification limits

The unscored D0 attempt reached the actual model but did not qualify the workflow. It never dispatched a source write or the fixed public command. The saved evidence contains 10 rejected command attempts, four rejected source-write attempts, repeated invalid Directory plan/focus calls, and successful reads. The model also misunderstood parts of the method. A tool-contract repair therefore does not establish that the model will complete the task.

The attempt is closed as `qualification-incomplete`, with `scorable: false`, no payload binding, and no policy qualification. Its original source scaffold, transcript, failed capture and raw initial payload are preserved. The failure-closure path verifies the exact owned terminal run and retained file hashes and cannot later promote this journal into a passing qualification.

Three infrastructure defects were exposed:

- The flat workspace and Directory tool schemas admitted combinations that the host rejected or ignored. The new model-facing action contracts declare each action's required and permitted fields and reject malformed calls before an effect. Internal and human Directory APIs retain their existing behavior.
- Cancellation depended on controller observation. Receipt collection delayed the cancellation request by 24.617 seconds beyond the fixed 300-second deadline. The candidate adds a request-bound absolute host deadline; cancellation, reporting and settlement remain distinct observations.
- A sleeping llama.cpp child destroyed its original context and loaded a new context on wake, while runtime properties still advertised the original startup receipt. The same PID and matching settings did not establish a current context. The original before/after receipts remain preserved, but their current-context qualification is superseded.

The capture was incomplete, and its descriptor was null. The cancellation released the final slot without a recorded task terminal. This was not a trace-capacity overflow: the child had used about 119.7 million bytes of its 268435456-byte per-process limit. No activation-statistics events were recorded in this metadata-only D0. Its trace cannot support an activation or weight-surgery comparison.

The original model has reported a 262144-token allocation at a qualified startup. That historical allocation is not proof that a later awake context retains a valid current identity. A historical application load also used the random-seed sentinel 4294967295; it remains historical evidence and cannot qualify a fixed-seed comparison.

### Runtime parity already observed

An earlier stock-versus-I/O-compatible baseline comparison passed for exact completion token arrays, chat/tool content, request bytes, effective runtime and sampler fields, chat template, loaded math libraries, GGUF identity and controlled child environment. The constrained tool-cycle probe also recorded an instruction-adherence failure: the model returned a sentence instead of the requested exact result string. Matching that deviation in both runtimes does not turn it into adherence.

A corrected metadata-only instrumented runtime subsequently matched that baseline. The earlier instrumented result remains failed because its streaming callback returned false after normal producer exhaustion. The corrected path was checked with the actual built server library: normal final-content and final-empty endings completed, while client resets during chunk writes and the final done call remained incomplete.

Those earlier passing comparisons preceded application restarts that changed the child-process environment. A separate fresh stock and I/O-compatible baseline chain was therefore run under the current environment; its results are reported below. The historical environment difference remains preserved and was not filtered away or replaced with an old value.

The first activation-enabled run failed on a legitimate zero-row tensor in the final Qwen3.5 attention layer. Its failed process, trace and non-comparable result remain preserved. Source repairs distinguish a real empty observation from measured activation statistics and convert a recorder abort into an explicit server error instead of entering the unrelated KV-retry assertion path. The final repaired binary's separately recorded live parity results are reported below.

### Frozen runtime build

The final position-aware native bundle was reconstructed in a separate fresh root from pinned llama.cpp commit `b1b770d90d94cad9e9ea5b993bdbc383a522fb28`. Its full 4,169-file source disposition, actual final link, empty subsequent build dry run, source/build/output identities, and original math-library identities passed the build gates. An independent readback verified all 4,169 actual source files and 4,283 distinct bound file references. The frozen binary reports build 12359 and GNU 16.2.0. All 19 original math libraries remain byte-identical; the loaded-library probe observed 34 load events covering those 19 unique libraries.

The model-free gates passed 10 lifecycle cases, 31 tensor callback cases, six decode-route cases, four actual HTTP-library cases, and read-only checks of all 321 GGUF tensor extents. The 24 position cases comprise four actual allocator/split cases, 18 rejected-representation cases, and two signed-boundary cases. The tensor callback fixture also obtains its row data from the actual allocator. The 19 recorder, six CLI/configuration, and 12 completed-build binding regressions passed. These are implementation and provenance checks, with explicit incomplete/error paths; model-output parity and coding results require separate runs.

The lifecycle fixture uses the production queue and snapshot helpers, a supported one-second sleep interval, and the Windows GGML timer initialization required by normal startup. Its earlier unsupported zero-interval timeout and missing-clock assertion failure remain preserved. The final fixture retained the five-second assertion and 30-second process limits; it did not require a production queue change.

The preceding frozen lifecycle bundle, its sources and build outputs, the pre-repair source snapshots, and earlier failed results remain unchanged. See [the native trace build instructions](../minicpm-live-trace/README.md) for the current fresh-root route. A model-free qualification cannot supply a live lifecycle or capture-parity pass.

### First live lifecycle attempt

The first real-model lifecycle attempt observed an awake context, sleep with a null current-runtime receipt, and a distinct newly published context after wake. Both independently copied current-publication brackets passed. The request reached its native terminal and the owned child settled, but the overall result remains incomplete: a row guard compared logical server text positions with expanded core positions as if their arrays had to be identical.

The pinned allocator expands a text position `p` from the server representation `[p,0,0,0]` to core coordinates `[p]` for one section or `[p,p,p,0]` for four sections. The captured token, task, slot, index, sequence, input-kind and output-mask joins agreed. This correspondence must be checked explicitly in lifecycle, measured-tensor, empty-tensor and native empty-output eligibility checks. Both raw arrays remain evidence; unsupported modes and other ownership contradictions remain failures.

The incomplete run and its exact pre-repair source are preserved. A separately labeled replay of 19 hash-bound saved inputs passed all 16 request-row position mappings and found no downstream collector failure. It records both the analysis time and the historical evaluation time, with `runtimeCurrent: false` and `newLiveQualification: false`. It does not rewrite or promote the old result. A new live attempt requires the repaired source and a separately frozen native bundle.

### Fresh live lifecycle qualification

A separately admitted live attempt with the final frozen bundle passed one complete awake/sleep/wake cycle and its native generation. The sleeping state exposed no current runtime receipt; wake published a distinct context before generation. Both independently copied publication brackets, all 16 request-row position mappings, and the request/task/HTTP terminal checks passed. The metadata-only trace contained four initialization microbatches, three request microbatches, and two sampled and accepted tokens. The owned process settled through its captured handle, and a later independent native process scan found no remaining model server or CLI.

The observed startup snapshots before sleep and after wake both reported a total context allocation of 262144 tokens, six generation and batch threads, effective flash attention, Q8 K/V caches, and 25 GPU placements comprising 24 transformer layers plus the output layer. This establishes the recorded allocation and placement for the probe. It does not establish long-context coding quality, throughput, a useful prompt near that limit, or an optimal profile.

An earlier admission for this same frozen bundle stopped before model launch because unrelated BLACKICE work was active. That work was left untouched. Its failed admission and a separate observation of subsequent settlement remain preserved; the successful attempt used new request IDs and evidence paths. Neither outcome replaces the older incomplete lifecycle result or the original failed D0.

### Fresh live runtime parity

The final original-model chain passed all three controlled comparisons. These counts refer to recorded comparison conditions, not additional coding tasks, and must not be added to the source-test groups.

| Comparison | Result | Environment condition |
| --- | --- | --- |
| Stock runtime versus rebuilt I/O-compatible baseline | 31 checks passed; no differences | All 37 base child-environment variables matched |
| Rebuilt baseline versus instrumented activation-off | 40 checks passed; no differences | The sole raw environment difference was the explicitly bound trace-config addition |
| Same instrumented runtime, activation-off versus activation-on | 76 checks passed; no differences | The full 38-variable child environment, config path and trace directory matched; only the activation-capture bit changed |

Across the six recorded task spans, activation-off/on preserved the native prompt-token sequences, 86 accepted tokens, 86 sampled tokens, and all 86 full-vocabulary logit hashes, alongside the required request, output, runtime, sampler, template and identity checks. Eight full-vocabulary logit vectors were retained and hash-verified in each off/on run (eight corresponding pairs; sixteen files total). Later samples retain exact hashes; missing vectors do not supply a numerical-tolerance analysis. Raw HTTP response bytes remain separate, with their differences, generated-ID mappings and documented timestamp/timing exclusions preserved. No message or tool-argument text was stripped.

The activation-on request trace contains 8,721 measured tensor events and 15 separate empty events. All 91 request microbatches contain the 96 required anchor dispositions: 86 have 96 measured observations, and five have 93 measured plus three source-proven empty observations. A further 192 measured initialization events are recorded separately from request execution. No required disposition was missing or duplicated, and there were no unassigned tensors, failed microbatch attempts or observer issues. Empty observations contribute no invented activation statistics.

All owned model processes settled, and independent native scans were empty. These findings qualify the six recorded task spans and selected anchors. They do not establish continuous liveness, clean C++ destructor events after deliberate termination, or coding improvement. Both final-answer probes still failed the exact-answer instruction by adding the same sentence around `parity-ok`; matching that output across runtimes does not make it a task success.

The on recorder produced 18 native files totaling 23,810,096 bytes, below its 268435456-byte limit. Its expanded host analysis result is separately 77,597,243 bytes. Long coding runs still require capture-volume and collector-resource qualification at their chosen budgets. The short compatibility probes do not establish long-run capacity or throughput.

### Source checks and installation

Source checks are reported by group and exact revision, without adding overlapping suites into one total. A passing fixture gate does not establish a model score, a loaded application change, an optimal runtime configuration, or current live-capture qualification.

The saved source gates include 39 workspace-contract/profile checks, 50 Directory/engine checks, 39 final deadline/engine/provider checks, 124 current-context/collector/managed-route checks, 97 instruction-source/policy checks, and 57 position-correspondence/lifecycle/native-collector checks. The final helper test title/comment cleanup was checked with the same eight affected cases; those eight are included in the preceding scope. These groups overlap; they are not a combined test total. The native binary and live lifecycle qualifications remain separate gates, recorded with exact source hashes in the delivery evidence manifest. The independent workspace-contract review found and fixed a malformed action discriminator: an array such as `["read"]` could be coerced into a valid action during parsing. Its regression checks prove rejection before file or command dispatch. Directory tests also preserve strict rejection of a string-valued revision while proving that a valid call can omit the model revision echo and still obey the host's bound revision.

The provider trace hook and repaired tool/deadline contracts are candidate source. The installed application does not gain them from passing source tests. Temporary D0 runtime settings were restored to their exact preimage and all owned model/router processes were settled. Another D0 requires a verified installation of the repaired source and a fresh attempt directory.

The source-version observer accepts only explicitly reviewed whole-source combinations. The currently installed ordinary-browser working-directory variant was reviewed separately and is still classified as legacy source: it does not contain the candidate benchmark repairs. An unfamiliar combination or an unaccounted prompt span remains incomplete.

A newly built runtime must carry a completed-build record binding its stable source, build recipes, toolchain, import inputs and generated build files to its actual executable and static libraries. A successful final link and an empty build dry run are required before fixtures or freeze can qualify that output. A changed source or output invalidates this record.

Settings calibration remains pending. The fixed full-context profile used for compatibility checks is not an established optimum. After runtime and capture qualification, use a bounded calibration with a declared objective and comparable workloads; keep startup cost, prompt processing, generation, peak memory and failures separate. Freeze the chosen profile and qualify the workflow under it before the seven-task campaign.

The seven scored tasks, comparison against the existing block edit, and all new weight edits remain unstarted.

## Components

| File | Contract |
| --- | --- |
| `controller/campaign-journal.cjs` | Typed, atomic state persistence with immutable identity, content/revision comparison, an exclusive writer lock, fsync/readback, and content-addressed evidence |
| `controller/campaign-driver.cjs` | Durable adapter around the existing guarded campaign API; persists the entire campaign envelope before returning an operation |
| `controller/campaign-driver-cli.cjs` | Native command interface for initialization, operation recovery, evidence attachment, conditions, and finalization |
| `controller/qualification-driver.cjs` | Separate first-D0 state machine; permanently unscored, with explicit irreversible failure closure and no path into a guarded campaign |
| `controller/qualification-driver-cli.cjs` | Native command interface for that first qualification |
| `controller/runtime-observation.cjs` and `context-publication-observation.cjs` | Normalize bound runtime observations and independently copied current-context lifecycle bytes; preserve missing data and contradictions |
| `controller/policy-observation.cjs`, `policy-contract.cjs`, `policy-source-versions.cjs`, and `prompt-composition.cjs` | Reconcile actual adapter delivery and reconstruct the entire initial prompt from reviewed source combinations and independent input evidence |
| `controller/managed-route-observation.cjs` | Validates the first unscored managed-router capture with explicit exclusive-route limits; it cannot manufacture a host HTTP-attempt identity |
| `../../lib/provider-exchange-trace.mjs` | Bounded durable provider HTTP request/response capture for admitted benchmark work |
| `../../lib/benchmark-workspace-contract.mjs`, `../../lib/task-action-directory-tool-contract.mjs` | Model-facing per-action schemas and matching validation before dispatch |
| `../../lib/benchmark-run-deadline.mjs` | Strict wall budget and immutable admission-derived deadline; host enforcement remains independent of receipt polling |
| `../minicpm-live-trace/` | Pinned llama.cpp instrumentation and build/capture contracts |
| `../minicpm-parity/` | Owned native runtime parity probes |

The journal accepts an explicitly typed state. A qualification journal cannot be read as a guarded campaign journal, and the reverse is also rejected. Dead-owner recovery preserves staged evidence and the old lock; it does not silently discard an unknown effect.

## Preparing an actual D0 qualification

Use a fresh owned attempt directory with the exact seven immutable scaffold files, a single initial `src/index.cjs`, and the external scaffold receipt. Keep the journal and all host evidence outside the model's workspace. The scaffold is unscored and has two public cases.

The configuration fixes the model, current BLACKICE connection, frontend origin, task text, workspace, context, budgets, method hash, and benchmark receipt. The only allowed command is `node test-public.cjs`. It requests Directory Actions on, Directory Mode off, Chat Planning off, Past Chats off, one agent, and no automatic compaction.

After creating those input files, initialize the saved journal:

```text
node verification/minicpm-infrastructure/controller/qualification-driver-cli.cjs init --journal "<journal>" --connection "<current-connection>" --config "<config.json>" --scaffold "<scaffold.json>" --observations "<initial-observations.json>"
```

Then request the next operation:

```text
node verification/minicpm-infrastructure/controller/qualification-driver-cli.cjs next --journal "<journal>" --connection "<current-connection>"
```

For `type: submit`, submit the returned `operation.arguments` to the returned tool without rewriting the expression or replacing its request ID. The exact operation is already durably committed before it is returned.

Persist the tool's unmodified admission envelope, then record it:

```text
node verification/minicpm-infrastructure/controller/qualification-driver-cli.cjs record-submission --journal "<journal>" --connection "<current-connection>" --admission "<admission.json>"
```

Read the admitted job until it is settled. Preserve every page if the result is paginated. Accept either its complete receipt or the ordered list of complete saved pages:

```text
node verification/minicpm-infrastructure/controller/qualification-driver-cli.cjs accept --journal "<journal>" --connection "<current-connection>" --result "<result.json>"
node verification/minicpm-infrastructure/controller/qualification-driver-cli.cjs accept --journal "<journal>" --connection "<current-connection>" --result-pages "<ordered-receipt-paths.json>"
```

These two forms are alternatives. A receipt that points to an oversized saved artifact is accepted first; retrieve and verify the artifact bytes and SHA before accepting its content with `--artifact`. The driver rejects missing, reordered, discontinuous, foreign, or changed pages.

The prepared request may be held before start. The request includes an explicit `input.benchmarkBudget.wallMs`, which is bound into the authored request hash and checked against the admitted run. The task deadline is fixed at the admitted native run's actual `createdAt` plus that budget; delay while reading the start receipt consumes it. Initialization and preparation do not consume it. Reusing a request ID with a changed budget is a conflict, not a fresh admission or an extension. The qualification driver does not independently freshness-check the installed instruction source while a request is held. Recheck source, connection, origin, and effective configuration before starting.

Continue the same next/submit/record/accept cycle for observe, cleanup, and collect operations. Follow the driver's result type. A pending admitted operation is recovered by its saved job ID. An operation with unknown admission is recovered using the identical saved request on the same connection. Do not create a new request merely because a response was lost.

The host deadline enforces cancellation independently of controller polling and checks expiry again before provider execution. It records actual enforcement lateness, cancellation errors and reporting errors. Host timers are not a hard-real-time scheduler. Cancellation remains distinct from settled execution, and the controller still has to verify settlement and preserve the final evidence. A restart does not resume generation or reset an admitted deadline.

The caller must settle owned work even when the task fails or a comparison condition drifts. It must never cancel an unowned run or infer successful cleanup from a timeout.

## Binding actual policy evidence

After collection, bind the exact initial provider payload file and its capture descriptor, attach the exact owned provider thread, and finish the policy assessment:

```text
node verification/minicpm-infrastructure/controller/qualification-driver-cli.cjs bind-payload --journal "<journal>" --connection "<current-connection>" --payload "<exact-request-body>" --capture "<capture.json>"
node verification/minicpm-infrastructure/controller/qualification-driver-cli.cjs attach-transcript --journal "<journal>" --connection "<current-connection>" --provider-thread "<thread.json>"
node verification/minicpm-infrastructure/controller/qualification-driver-cli.cjs finish --journal "<journal>" --connection "<current-connection>" --policy-input "<policy-input.json>"
```

The policy input supplies current source identities and source metadata. The driver supplies its own saved native run, provider thread, capture, binding, audit, and payload, rather than trusting substitutes in the input file.

The policy observer retains the complete ordered accepted-section description. It does not remove an unfamiliar section or normalize task-specific text until two prompts happen to match. Core, SOUL, active skills, USER metadata, workflow, Directory instructions, capability block, tool schemas, and the exact first user task all matter.

The entire first user-role prompt is reconstructed from the pinned composer and independently bound inputs, including fixed framing, workflow, identity, upstream state, task text, and fresh Directory state. System/developer messages and tools retain exact equality checks. An extra sentence before, between, or after accepted sections is an unmatched span and makes the observation incomplete. Missing or unsupported source versions, reordered sections, and forged stored coverage summaries also fail. Character offsets, UTF-8 byte offsets, exact text, and hashes are retained; unknown text is never silently removed.

An accepted adapter audit establishes delivery, not that the instruction content is desirable. A separate semantic review remains required. An exclusive-route bootstrap capture is labeled separately from authoritative host attempt binding. The former cannot pass as a native attempt trace.

Every qualification result retains:

```json
{
  "scorable": false,
  "purpose": "instruction-workflow-qualification",
  "policyReviewRequired": true
}
```

Complete capture of a failed model task remains evidence of that failed task. It does not become a coding success. Keep `agentCompleted`, workflow evidence validity, policy delivery completeness, and later trace comparability as distinct findings.

## Closing an incomplete qualification

An incomplete or null capture cannot be repaired by inventing a capture descriptor or binding an unqualified payload. After the exact owned terminal run is settled, all pending effects are resolved, and its provider transcript is attached, close the failed qualification explicitly:

```text
node verification/minicpm-infrastructure/controller/qualification-driver-cli.cjs finish-incomplete --journal "<journal.json>" --connection "<same-connection-id>" --failure-observation "<observation.json>" --snapshot-manifest "<snapshot-manifest.json>" --reason "<specific failure reason>"
```

Optional `--payload` retains exact raw bytes as unqualified evidence. Without it, the recorded manifest payload copy is retained when available. Optional `--observations` attaches supporting evidence. All retained files are copied outside the model workspace, bound to their SHA-256 and byte counts, and checked again when the closed journal is read.

This command requires an explicitly failed observation and an exact snapshot manifest. It rejects unsettled or foreign runs, pending effects, a claimed successful capture, changed source evidence, or an existing payload/policy binding that closure would erase. It does not edit the model's source files.

Exit code 2 means the unqualified outcome was successfully recorded; exit code 1 means the closure operation failed. Read the returned `failureClosed`, `phase` and saved journal receipt. A closed journal's `next` operation emits no further action, and later payload binding, policy qualification or promotion is rejected. A new attempt requires a new journal and a fresh workspace.

## Guarded campaign operation

Use `campaign-driver-cli.cjs` for the comparison after qualification. Initialization additionally requires the frozen `--manifest` and explicit `--arm original|edited`.

The driver persists the whole campaign envelope, including the manifest, observations, immutable bindings, and nested controller. Admission and finalization require fresh matching observed conditions. Missing observations are not defaults. A later restoration of settings does not erase an already observed drift.

The runtime observer requires a startup receipt bound to the actual process, model, binary/build, and unique loaded context. Current qualification additionally requires an awake runtime publication and an independently bound lifecycle prefix bracketed by matching fresh properties. An ended context, sleeping child, failed publication, changed receipt, incomplete prefix or missing proof is incomplete evidence. A matching PID and old startup artifact are insufficient. On successful wake the instrumented runtime publishes the new context's receipt before admitting inference; a failed publication never returns the previous receipt as current. Settings saved in the application are not proof that those values were applied. In particular, requested automatic GPU placement or flash attention is not an observed effective value.

The comparison fixes the sampler seed and other sampling values, context, KV types, threads, batch sizes, GPU placement, flash attention, parallelism, projector choice, output reserve, and application/provider configuration. Null or unavailable observations must remain explicitly unresolved.

The current starting profile uses full context, six generation and batch threads, batch/ubatch 2048/512, 25 requested GPU layers, Q8 KV, one slot, and a fixed seed. It is a candidate profile for controlled verification, not an established optimum. Settings calibration must use unscored runs with a stated objective and must be separated from the scored comparison.

## Provider and activation capture

Provider capture is enabled only by the host context for an admitted benchmark run. It is restricted to a loopback compatible-provider endpoint. Ordinary provider requests receive no trace headers or artifacts. The native Codex and Vibe paths reject benchmark capture before delegation because those transports do not supply this capture contract; ordinary native execution retains its existing behavior.

The host serializes the actual request body and saves its exact UTF-8 bytes before dispatch. Every logical exchange has a distinct ID; every HTTP attempt, including a permitted transient retry, has a distinct attempt ID. The headers are:

- `X-Blackice-Exchange-Id`
- `X-Blackice-Attempt-Id`
- `X-Blackice-Request-Sha256`

Response entity bytes are captured before UTF-8 decoding and SSE parsing. Request, opened-attempt, response, and settled-exchange artifacts remain recoverable after a write failure. The normal existing once-only 502/503/504 retry policy is preserved. Network failures and accepted streams are not replayed to repair evidence.

Capture is bounded. Limits, read limits, missing readers, truncation, cancellation, I/O failures, and unsettled attempts are recorded explicitly. They cannot produce a complete exchange. The original provider failure classification is retained when inference itself failed.

For the first D0 before the host hook is installed, the managed-route observer may establish only an observed exclusive generation route. It requires the exact owned run/thread, current R3 runtime input, independently observed child birth and router ancestry, exact request bytes, complete applicable traces and terminals, and a stable read of the bounded trace window. It keeps `/v1/chat/completions/input_tokens` observations separate from exact POST `/v1/chat/completions` generation requests. Sparse application run snapshots cannot prove continuous global absence of other activity. The descriptor always retains `bindingTier: "exclusive-route"`, `providerExchangeBinding: "unbound"`, `scorable: false`, and `traceComparable: false`.

Streaming transport completion must retain separate producer-exhaustion, `sink.done()` invocation, chunk-write-failure, and raw HTTP resource-releaser outcomes. A done call returns no success value and is insufficient by itself. HTTP logger/status metadata may be recorded before the body has been written. Nonstream generator completion establishes its narrower content-generation scope and is not independently transport proof.

Native activation capture must link the exact HTTP entity to the post-template prompt tokens, actual evaluation batches/microbatches, selected tensors, sampled tokens/logits, and cache state. A pre-routing rejection that never read the body cannot claim to have observed an empty request body. Unsupported tensor row mapping, selected-tensor omissions, dropped events, overflow, and incomplete terminal spans invalidate affected capture.

The model is dense: an activation trace does not mean each weight is selectively switched on or off. Any conclusion about a weight edit requires a controlled comparison with preserved identities and complete evidence.

## Parity and reporting

Run the original bundled runtime and a precisely identified rebuilt baseline separately against the same exact GGUF to expose compiler/build differences. Preserve a failed unmodified rebuild rather than relabeling a repaired binary as unmodified. This candidate's GNU core originally crossed a Windows CRT boundary by using a foreign `FILE*`; its I/O-compatible baseline keeps file opening/use/closing in one CRT and retains the original filename-based GGUF parser and math DLLs. Unsupported opaque-file model/adapter inputs and unqualified LoRA loading fail explicitly in the experimental build. Those restrictions do not change the installed runtime or establish any LoRA finding. Compare activation-off and activation-on with the same instrumented executable and metadata recorder; only the activation switch may differ.

Both activation runs use the same explicit trace-config path and output directory, immutable per-run snapshots, and the exact same complete child environment. Publishing the on configuration requires the saved off preimage; only `activationCaptureEnabled` changes. Baseline-to-metadata comparison records the trace-config environment variable as an explicit instrumentation treatment. A per-command application restart capability is omitted from owned model children after its source is pinned; only the key, value hash, and reason are retained. Every other child environment difference remains visible and blocks an unexplained comparison.

Preserve raw request and response bytes. Generated tool-call IDs may differ across processes. If a fixed alias is used to make a follow-up request identical, retain the original ID and the explicit mapping; do not silently rewrite model content or tool arguments.

Native completion token IDs, chat tool behavior, prompt tokens, cache reuse, logits, and wire metadata are distinct observations. Stock chat token IDs may be unavailable. Timing or created-at differences prevent raw-wire identity even when generated content agrees. Compilation and traced runs do not establish untraced throughput.

Each probe owns its server process and has a bounded cleanup budget. Preserve failed probes and prove the owned process has settled. Keep machine-specific configurations, prompts, raw receipts, and model data outside the reusable source package.

No seven-task score, causal claim about the existing block edit, or LoRA conclusion follows from these infrastructure tests alone.
