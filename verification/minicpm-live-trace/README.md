# MiniCPM live trace qualification

This directory owns a private, pinned llama.cpp rebuild and live instrumentation for the BLACKICE MiniCPM coding benchmark. It does not modify a model file. It is a verification tool, not an upstream llama.cpp contribution or a replacement app installation.

## Qualification state

The initial native Windows build and CLI gates passed on 2026-11-21, but its first actual model load failed. The unchanged GGUF loaded successfully in the original bundled server. Inspection found a CRT ownership defect: the rebuilt core consumed a UCRT `FILE*` from `ggml_fopen` through its own MSVCRT descriptor and close functions. An undecorated C export alone does not establish ownership compatibility. The initial binary gates remain historical evidence and do not qualify that baseline for inference.

The separate I/O compatibility module below repairs the filename path and explicitly rejects unsupported opaque file and LoRA inputs. Model execution, original/rebuilt equivalence, activation on/off equivalence, and actual cold/cached tool-cycle coverage remain separate gates coordinated by the campaign owner. A successful compiler or no-model fixture result does not establish those gates.

The pinned upstream source is `b1b770d90d94cad9e9ea5b993bdbc383a522fb28` (b12359). The portable toolchain is GNU 16.2.0 from w64devkit 2.11.0, CMake 4.5.1, and Ninja 1.13.2. Source and tool archives are hash-pinned in `build-inputs.json`.

| Preserved initial artifact | SHA256 | Bytes |
| --- | --- | ---: |
| Unmodified rebuilt baseline, `live-trace/baseline/bin/llama-server.exe` | `dbe74057c20e1dd8fc0588a647bd28f4d7c7bb86d11562e6597dcc580fe024d5` | 18,884,673 |
| Initial instrumented server, `live-trace/io-compat/preserved-original/instrumented/bin/llama-server.exe` | `947d381a2c5378fc36bbbd446622957187125b473e90a86d993ce138605acca7` | 19,195,556 |

| Preserved I/O compatibility artifact | SHA256 | Bytes |
| --- | --- | ---: |
| Compatibility baseline, `live-trace/io-compat-baseline/bin/llama-server.exe` | `383ce0d62688e3b040f70b7cc53b8a23b69fa31711f95b52e99e27a9b43c8996` | 18,854,579 |
| Instrumented compatibility server, `live-trace/io-compat-instrumented/bin/llama-server.exe` | `9e26454e91bfa8b40d22969c338a5bdaeeb9801566b2b9ab4c5fa38d58f95692` | 19,166,998 |

Both compatibility bundles passed the no-model I/O and request-parser probes, including all 321 tensor extents in the pinned original GGUF, and the CLI/DLL gates. The instrumented bundle also passed the 19 native and six CLI trace fixtures. These gates authorize controlled runtime parity collection; they do not establish model-output parity, live activation coverage, or coding scores.

Both binaries report their actual GNU compiler identity. The rebuilt core, common code, mtmd, and server use one C++ ABI. Original ggml, CPU, Vulkan, and libomp DLL bytes are retained. The DLL probe observed actual Windows load events and checked required paths and hashes; the additional I/O probe is necessary to validate the ownership and data-access boundary.

Generated dependencies, source, binaries, configuration fixtures, and command receipts belong under the separately assigned absolute `live-trace` evidence directory. They are not git source files. In the commands below, `$MiniCpmTraceRoot` means `<absolute-private-evidence-root>\live-trace`; `$MiniCpmOriginalModel` means the absolute original GGUF path supplied by the campaign owner. Actual machine paths are retained only in private command receipts.

## Current build from a fresh root

Use `fresh-build.cjs` for the current I/O, HTTP, empty-output, runtime-lifecycle, and text-position correspondence source. It uses source and tool archives pinned by the checked-in `build-inputs.json`, plus the original Vulkan DLL directory with its adjacent release manifest. The archives are fetched or read from the explicitly supplied cache; they are not checked-in files. The workflow does not require a previous build, a historical binary hash, or any private preserved receipt. Generated source, tools, fixtures, binaries, and receipts remain under the explicitly supplied new build root.

The original model is opened read-only by the I/O gate. No command below starts a model. Run each command through native Node in the assigned BLACKICE worktree, settle its process/job, and inspect its saved receipt before proceeding. A failed or uncertain command must be reconciled; it is not permission to repeat an unknown mutation.

```powershell
$MiniCpmBuildRoot = '<new-absolute-owned-build-directory>'
$MiniCpmOriginalVulkan = '<absolute-original-llama.cpp-directory>\vulkan'
$MiniCpmOriginalModel = '<absolute-original-GGUF-path>'

node verification/minicpm-live-trace/fresh-build.cjs init $MiniCpmBuildRoot $MiniCpmOriginalVulkan
node verification/minicpm-live-trace/fresh-build.cjs asset $MiniCpmBuildRoot source
node verification/minicpm-live-trace/fresh-build.cjs asset $MiniCpmBuildRoot w64devkit
node verification/minicpm-live-trace/fresh-build.cjs asset $MiniCpmBuildRoot cmake
node verification/minicpm-live-trace/fresh-build.cjs asset $MiniCpmBuildRoot ninja
node verification/minicpm-live-trace/fresh-build.cjs prepare $MiniCpmBuildRoot
node verification/minicpm-live-trace/fresh-build.cjs sources $MiniCpmBuildRoot
node verification/minicpm-live-trace/fresh-build.cjs equivalence $MiniCpmBuildRoot
node verification/minicpm-live-trace/fresh-build.cjs configure $MiniCpmBuildRoot
node verification/minicpm-live-trace/fresh-build.cjs build-step $MiniCpmBuildRoot
```

An existing absolute archive-cache directory may be supplied as the final argument to `init`. Each cached archive is still checked against the checked-in size and SHA256. Extraction uses Windows `System32/tar.exe` explicitly, including for the pinned compiler self-extractor archive; it does not execute that archive's self-extractor program or pick a different `tar.exe` from the compiler's PATH. Tools are extracted only into the owned root; no global installation is performed. Import-library generation uses short relative filenames inside the owned `imports` directory, so `dlltool` does not derive a long temporary filename from the absolute output path.

Repeat only the bounded `build-step` action until its result is `linked:true`. It selects at most three object targets and uses at most two compiler workers. The small final generated-file/link tail is allowed to settle together. Then run:

```powershell
node verification/minicpm-live-trace/fresh-build.cjs native-fixtures $MiniCpmBuildRoot
node verification/minicpm-live-trace/fresh-build.cjs lifecycle-fixtures $MiniCpmBuildRoot
node verification/minicpm-live-trace/fresh-build.cjs io-fixtures $MiniCpmBuildRoot $MiniCpmOriginalModel
node verification/minicpm-live-trace/fresh-build.cjs http-fixtures $MiniCpmBuildRoot
node verification/minicpm-live-trace/fresh-build.cjs freeze $MiniCpmBuildRoot
node verification/minicpm-live-trace/fresh-build.cjs gate $MiniCpmBuildRoot $MiniCpmOriginalModel
```

The output bundle is `bundle/bin/llama-server.exe`, with immutable `bundle/manifest.json` and `qualification-gate.json`. The manifest retains the binary, actual compiler/toolchain, full source content, CLI receipts, fixture identities, and observed loaded DLL paths/hashes. A passed gate authorizes a separately scheduled model qualification; it does not establish model parity, sleep/wake behavior under a real model, activation coverage, or benchmark scores. The coordinator owns all model runs.

The final build step preserves any previous unfrozen executable and forces an actual final link. Only a successful observed link followed by an empty Ninja dry-run can write `build-complete.json`. That record binds the exact source state, recipe and fixture sources, compiler binaries, import libraries, original math DLLs, generated build files, executable, and every static library used by the probes. Inputs must match before and after the link. Every fixture, freeze, and final gate revalidates that record; each fixture gate records its exact hash. Source changes, changed output bytes, missing completion, and successful no-op builds cannot qualify stale outputs.

The pinned upstream UI target normally runs on every build. `ui-source-patch.cjs` changes only the profile where both UI options are disabled: it requires no source/binary `dist/index.html` and tracks the actual generator, two templates, and CMake executable as dependencies of `ui.cpp` and `ui.h`. The enabled-UI branch retains the upstream command. The empty Windows output bytes are checked against the pinned generator/template result, which was also compared with the preserved pre-change build. This removes phantom pending work without embedding new assets or depending on private historical files.

`final-source.cjs` derives the final source from the pinned upstream archive and the checked-in pure I/O and trace patches. Its manifest accounts for every upstream file, every copied file, every replacement, and an explicit deletion list (currently empty). It rejects unaccounted file additions, deletions, or content changes. `equivalence` independently extracts the archive again, composes the final source, and compares the complete manifest with the actual build tree. It does not compare only a selected subset of hashes. Historical campaign preservation is separate from this fresh-root contract.

The modules are deliberately separate: `io-source-patch.cjs` and `ui-source-patch.cjs` are pure source repairs; `final-source.cjs` composes and verifies source; `build-completion.cjs` validates the completed-build contract; `native-build-common.cjs` owns command receipts and observed identities; `fresh-build.cjs` prepares source and bounded compilation; `fresh-build-gates.cjs` owns fixture and freeze gates.

## Current runtime lifecycle contract

`blackice-runtime-snapshot.h` is the production publication/access helper used by traced `GET /props`. Every operation shares the route's existing `mutex_cache`. The immutable route metadata pointer is not replaced while HTTP handlers are running.

| State | Current properties |
| --- | --- |
| Awake, successfully published | `is_sleeping:false`, `blackice_runtime_state:"awake"`, and `blackice_runtime` equal to the exact current native startup receipt. |
| Sleeping | `is_sleeping:true`, `blackice_runtime_state:"sleeping"`, `blackice_runtime:null`; the historical receipt is retained only as `blackice_previous_runtime`. |
| Initial publication absent or failed; wake publication failed | Snapshot reads fail explicitly. There is no fallback to an awake historical receipt. |

The first publication occurs before HTTP readiness. On wake, the actual server queue calls the context reload callback before the route callback, then releases waiting requests. The route callback publishes the new context receipt and properties atomically before that release. Reusing the same context ID, changing process identity, missing or incomplete receipt data, or throwing during publication makes the snapshot unavailable.

A failed wake publication invalidates capture but lets the queue release its sleep barrier: upstream waiters otherwise wait only for `sleeping == false` and can hang during exception unwinding. Properties reads then fail, and the actual task-registration path rejects unhealthy or unpublished capture before decode. This is an explicit error path, not an awake runtime observation. Ordinary server behavior without trace configuration retains the upstream properties path.

`runtime-lifecycle-probe.cpp` exercises the same production snapshot and admission helpers, actual `server_queue` callback ordering, blocked concurrent reads, fresh context publication, stale/wrong-process receipts, and failed publication. The actual `common_json` boundary is explicit; the helper owns the receipt before inserting state fields into `ordered_json`. The fixture forces object growth and checks the full current and historical receipt. Its failed-queue case invokes the actual recorder invalidation path and proves waiter release, unavailable properties, and zero decode admission. Receipt/context metadata in this no-model fixture is explicitly synthetic. A live sleep/wake qualification is a separate, multi-context proof and must not be reported as the ordinary six-probe parity result.

## Text-position correspondence

The pinned allocator expands a text token's scalar position into `[p]` or `[p,p,p,0]`, using the actual one- or four-section core layout. The server retains its logical text array `[p,0,0,0]`; embedding positions have different semantics. Both raw arrays remain unchanged in trace events.

`blackice-text-position.h` verifies this exact correspondence for text rows with matching nonnegative signed32 token IDs and a signed32 negative embedding-row marker. It requires four signed32 logical coordinates with three zero trailing values, the observed core section count of one or four, and exact core coordinates. Signed positions are not restricted to nonnegative values by this representation check. All other tensor eligibility, task, slot, sequence, row-index and output-mask guards remain in force. Unsupported or malformed input rejects explicitly.

The existing native empty-output fixture now obtains its rows from the actual pinned `llama_batch_ext`, `llama_batch_allocr::init` and `split_simple` path, without a model. It exercises four nonzero prompt/decode and one-/four-section cases, eighteen representation rejections and two signed boundaries. The actual capture callback retains its previous cases and adds seven position/ownership negatives, for thirty-one tensor cases and the unchanged six decode-route cases. Fresh source equivalence includes the helper, and the native gate binds the exact upstream allocator source and helper hashes to the completed build.

## Historical I/O compatibility repair and gates

`io-compat.cjs` owns six hash-pinned source changes. `llama_file_fopen` converts UTF-8 filenames and opens them in the core CRT, which also owns descriptor lookup and closing. `llama_file` and the split-file existence probe use that helper. Normal and split GGUF metadata parsing continue through the original DLL's filename API; their metadata offsets and tensor layout are unchanged.

Opaque `FILE*` construction/model loading and both LoRA loading entry points reject with explicit `BLACKICE_IO_UNSUPPORTED_FILE_POINTER` or `BLACKICE_IO_UNSUPPORTED_LORA` diagnostics. The unqualified adapter implementation is excluded from this private build. The shared request parser also rejects nonempty adapter lists, covering per-request overrides and the adapter endpoint; an empty list continues to mean no adapters. `io-request-probe.cpp` verifies this behavior using the actual patched parser without a model or server. The installed BLACKICE runtime remains unaffected. LoRA experiments require a separate qualified implementation.

`io-compat-probe.cpp` initializes no model and calls no backend initialization. It opens the pinned GGUF read-only, compares independent Win32 and core sizes, seeks, boundary/interior reads and mmap bytes, and checks every parsed GGUF tensor extent. Small owned Unicode-path fixtures exercise both reading and writing. Invalid opaque pointers exercise rejection before dereference. The runner verifies model and original math-library hashes before and after the probe and rejects unsafe file-pointer imports in the rebuilt executable.

The following is the historical I/O-only transition. Its scripts deliberately reject a newer instrumentation hash; use the fresh-root workflow above for the current source. The saved historical script and inputs remain in the private preservation tree. Repeat a historical `build-step` only until its result says `linked:true`; each call builds at most three object targets with two compiler workers.

```powershell
node verification/minicpm-live-trace/io-compat.cjs preserve $MiniCpmTraceRoot
node verification/minicpm-live-trace/io-compat.cjs apply $MiniCpmTraceRoot baseline
node verification/minicpm-live-trace/io-compat.cjs build-step $MiniCpmTraceRoot baseline
node verification/minicpm-live-trace/io-compat.cjs probe $MiniCpmTraceRoot baseline $MiniCpmOriginalModel
node verification/minicpm-live-trace/io-compat.cjs freeze $MiniCpmTraceRoot baseline
node verification/minicpm-live-trace/io-compat.cjs apply $MiniCpmTraceRoot instrumented
node verification/minicpm-live-trace/io-compat.cjs build-step $MiniCpmTraceRoot instrumented
node verification/minicpm-live-trace/io-compat.cjs probe $MiniCpmTraceRoot instrumented $MiniCpmOriginalModel
node verification/minicpm-live-trace/io-compat.cjs freeze $MiniCpmTraceRoot instrumented
node verification/minicpm-live-trace/io-compat.cjs fixtures $MiniCpmTraceRoot instrumented
```

`preserve` keeps the initial instrumented bundle and existing receipts under `io-compat/preserved-original`; the initial `baseline` directory is untouched. The I/O-only bundles have separate `io-compat-baseline` and `io-compat-instrumented` directories, each with an immutable `manifest.json` containing source, executable, CLI, I/O-probe, and actual loaded-DLL identities. Neither is called an unmodified baseline. Private command receipts include failures and child exit observations. These no-model receipts do not assert model parity or live coverage; the campaign owner's runtime results are separate artifacts.

## Historical HTTP completion repair and gates

The first instrumented metadata run exposed a separate upstream HTTP-adapter defect. On normal stream exhaustion the adapter called `sink.done()` and then returned `false`. The pinned httplib implementation treats a false provider return as cancellation, even after the final bytes and HTTP terminator were written. Its resource releaser therefore correctly reported `false`. The failed live evidence and both I/O-only bundles are preserved.

`stream-compat.cjs` changes this adapter to return `true` after a successful provider invocation, including normal exhaustion. A failed `sink.write()` still returns `false`. The library retains its own checks on the writes performed by the void `sink.done()` call. No httplib, math-library, I/O-repair, or model bytes are changed by this correction.

The instrumented adapter records producer exhaustion, done invocation, chunk-write failure, and the raw library releaser outcome separately. It never infers the latter from status 200, generated text, `[DONE]`, or a done invocation. New bundles use separate `io-stream-compat-baseline` and `io-stream-compat-instrumented` directories and the manifest schema `blackice.minicpm.io-http-compat-bundle.v1`.

`http-stream-probe.cpp` links the actual server HTTP library and binds an ephemeral loopback port without initializing a model. `verify-http-stream.cjs` preserves raw request/response bytes and runs four cases: a nonempty final SSE chunk, an empty final provider call, an actual TCP reset before a gated chunk write, and a reset before a gated empty final call. The last case must remain incomplete even though the producer has ended and `sink.done()` is invoked. The old-library run reproduces the false callback on normal success before the source is changed. Both failure cases remain failures after the correction.

The historical HTTP transition used these commands before the later empty-output and lifecycle repairs. They require its preserved campaign inputs and are retained for audit; they are not the current build entry point. Each `build-step` selects at most three object targets with two compiler workers, then settles the small generated-file/link tail together; repeat until `linked:true`. All freeze targets are immutable. A failed or uncertain command requires receipt/job reconciliation before another action.

```powershell
node verification/minicpm-live-trace/stream-compat.cjs preserve $MiniCpmTraceRoot
node verification/minicpm-live-trace/stream-compat.cjs compile-fixture $MiniCpmTraceRoot legacy
node verification/minicpm-live-trace/stream-compat.cjs http-fixtures $MiniCpmTraceRoot legacy
node verification/minicpm-live-trace/stream-compat.cjs apply $MiniCpmTraceRoot instrumented
node verification/minicpm-live-trace/stream-compat.cjs build-step $MiniCpmTraceRoot instrumented
node verification/minicpm-live-trace/stream-compat.cjs compile-fixture $MiniCpmTraceRoot instrumented
node verification/minicpm-live-trace/stream-compat.cjs http-fixtures $MiniCpmTraceRoot instrumented
node verification/minicpm-live-trace/stream-compat.cjs freeze $MiniCpmTraceRoot instrumented
node verification/minicpm-live-trace/stream-compat.cjs native-fixtures $MiniCpmTraceRoot instrumented
node verification/minicpm-live-trace/stream-compat.cjs apply $MiniCpmTraceRoot baseline
node verification/minicpm-live-trace/stream-compat.cjs build-step $MiniCpmTraceRoot baseline
node verification/minicpm-live-trace/stream-compat.cjs compile-fixture $MiniCpmTraceRoot baseline
node verification/minicpm-live-trace/stream-compat.cjs http-fixtures $MiniCpmTraceRoot baseline
node verification/minicpm-live-trace/stream-compat.cjs freeze $MiniCpmTraceRoot baseline
node verification/minicpm-live-trace/stream-compat.cjs gate $MiniCpmTraceRoot baseline $MiniCpmOriginalModel
```

The instrumented fixture checks raw callback facts as well as client bytes. The baseline fixture checks its actual HTTP path and client outcomes but has no recorder callback evidence; it does not claim otherwise. The consolidated gate rechecks original model identity, unchanged I/O source, math-DLL identities, preserved old bundles, and required native/CLI/DLL fixtures. It authorizes only subsequent controlled model parity collection.

## Modules and commands

Run the scripts with native Node in the assigned BLACKICE worktree. All directory arguments are absolute. Commands return a nonzero status on an unmet gate. Read the saved command receipt and settle the corresponding direct-tool job before retrying.

| Module | Responsibility |
| --- | --- |
| `prepare-build.cjs` | Fetch and hash-check pinned archives, extract into owned directories, verify pinned source files and compiler identities. |
| `pe.cjs` | Inspect x64 PE imports and exports to validate the C ABI boundary. |
| `build.cjs` | Create import libraries, configure the private build, compile bounded object groups with two workers, link, and inspect the server. |
| `dll-load-probe.cpp`, `probe-build.cjs` | Launch only the owned experimental `--list-devices` child under a Windows debug-event observer; record actual loaded DLL identities. No attach to BLACKICE and no model load. |
| `blackice-trace.h`, `blackice-trace.cpp` | Private trace sink, exact context/batch/tensor capture, runtime observation, durable request/task evidence, and native fixtures. |
| `apply-instrumentation.cjs` | Validate all upstream target hashes, preserve originals, apply exact counted changes, reject unowned source drift, and save source hashes. |
| `verify-instrumentation.cjs` | Run 19 native self-tests and six no-model CLI cases; check configuration bytes/hash, Unicode paths, absence/disable behavior, explicit early-exit status, and visible budget invalidation. |
| `io-compat.cjs`, `io-compat-probe.cpp`, `io-request-probe.cpp` | Preserve initial artifacts, apply the pinned I/O compatibility repair, build bounded object groups, verify model-file ownership/data access and actual request-parser rejection without model initialization, and freeze separate baseline/instrumented bundles. |
| `stream-compat.cjs` | Preserve I/O-only artifacts, require the actual-library defect reproduction, apply the HTTP correction, build bounded groups, and freeze/gate separate corrected bundles. |
| `http-stream-probe.cpp`, `verify-http-stream.cjs` | Exercise the real server HTTP adapter without a model; preserve normal and reset-path client bytes, producer cleanup, raw trace outcomes, and owned process settlement. |

The historical initial build sequence is `prepare-build.cjs fetch`, `extract`, `verify-source`, followed by `build.cjs imports`, `configure`, bounded `step` calls, `link`, `inspect`, and `probe-build.cjs`. The historical original instrumentation entry point is deliberately bound to the initial baseline SHA above and does not establish I/O compatibility. Use `fresh-build.cjs` for a new corrected bundle. The historical migration scripts deliberately pin their own earlier inputs and cannot be chained from the current source without those preserved historical versions.

For reference, the historical instrumentation-only sequence was:

```powershell
node verification/minicpm-live-trace/apply-instrumentation.cjs $MiniCpmTraceRoot
node verification/minicpm-live-trace/build.cjs link $MiniCpmTraceRoot
node verification/minicpm-live-trace/verify-instrumentation.cjs $MiniCpmTraceRoot
node verification/minicpm-live-trace/build.cjs inspect $MiniCpmTraceRoot
node verification/minicpm-live-trace/probe-build.cjs $MiniCpmTraceRoot
```

These commands rebuild the experimental binary. Do not run them while a parity or benchmark process owns that binary. The coordinator launches all model runs.

## Activation protocol

The default configuration file is exactly `blackice-trace.json`, beside the experimental executable. An absent sidecar disables all recording. A present malformed configuration is a startup failure. No configuration is inferred from model text or requested settings.

An explicitly supplied absolute `BLACKICE_TRACE_CONFIG` environment variable selects another configuration file. Its source, path, exact UTF8 bytes, SHA256, and effective settings are recorded. It is read once per process. Context starts repeat the same configuration snapshot; no mid-run reread occurs. A managed router and each model child receive distinct process and context artifact names.

```json
{
  "schema": "blackice.minicpm.trace-config.v1",
  "enabled": true,
  "activationCaptureEnabled": false,
  "outputDirectory": "C:\\absolute\\owned\\trace-output",
  "tensorSelection": ["attn_norm", "attn_post_norm", "ffn_out", "l_out"],
  "maxBytes": 268435456,
  "logitVectorSteps": 8
}
```

`enabled` controls the whole recorder. `activationCaptureEnabled` controls selected tensor callbacks and their synchronization. Metadata, token, cache, and logit recording remain the same when that one activation flag changes. For the on/off comparison, use the same binary and configuration values, including the same output directory, changing only this flag. The absence of a sidecar is a separate all-recording-off condition.

`maxBytes` is a per-process total across recorder files, between 65,536 and 8,589,934,592 bytes. A 4,096-byte reserved error allowance permits an explicit invalid marker. The budget accumulates across every context and request in that process; it does not reset on sleep, wake, or a new agent task. Tensor reads are separately bounded to 64 MiB each. `logitVectorSteps` is 0–64 and controls full float32 logit files for the first sampling steps of each context; every available sampled logit vector is still hashed. Unknown configuration fields, anchors, duplicate anchors, relative output paths, and invalid bounds are rejected.

## Files and binding

All file creation is exclusive. JSONL records carry `schema: blackice.minicpm.live-trace.v1`, `event`, `at`, `pid`, `processId`, `processStartedAt`, `processSequence`, `fileSequence`, and `data`. `fileSequence` starts at 1 and increments without gaps within that file. Process sequence values span all files and therefore need not be consecutive inside one context file.

| Artifact | Contents |
| --- | --- |
| `<pid>-<processUUID>.process.jsonl` | Configuration snapshot, native HTTP request/response correlation, and process terminal observations. |
| `<pid>-<processUUID>.ctx-<contextUUID>.jsonl` | Exact task, cache, server batch, microbatch, sample, tensor, and context events. |
| Same context prefix plus `.startup.json` | Immutable native runtime-startup receipt, before host enrichment. |
| `<pid>-<processUUID>.request-<requestUUID>.body.bin` | Exact received HTTP entity bytes for an accepted inference handler. |
| Context prefix plus `.sample-<N>.f32` | Optional full raw logit vector: IEEE754 float32 little-endian, vocabulary token-ID order. |
| `<pid>-<processUUID>.invalid.json` | Explicit incomplete capture marker after a sink, budget, identity, mapping, or callback error, when the filesystem permits it. |

The request headers are `X-Blackice-Exchange-Id`, `X-Blackice-Attempt-Id`, and `X-Blackice-Request-Sha256`. The last value must match the exact received bytes. These fields bind only when all three are present and valid. Missing headers produce `unbound`, which is not sufficient for an admitted scored campaign. The router forwards the unchanged entity and host headers and adds `X-Blackice-Router-Request-Id`; the child records that native parent ID. The response echoes the native request ID and supplied attempt ID.

Some HTTP rejections happen before upstream reads an entity. They are recorded with `bodyObserved: false`, null body/hash fields, and a headers-only binding status. They cannot bind a model task. No empty-body hash is substituted for unread bytes.

`task_registered` records `serverRequestId`, `taskId`, `completionId`, the actual post-template `promptTokenIds`, rendered prompt, and resolved generation parameters. `task_slot_assigned` records the assigned slot and actual sampler seed. Subsequent task identity follows the native task and slot IDs.

## Runtime receipt

The startup schema is `blackice.minicpm.runtime-startup.v1`. It includes unique `id` and `startupId`, actual process identity, model ID/path, build, `runtime`, `fieldSources`, projector load/path observations, actual layer-device placement, configuration hash, trace path, and explicit completeness/drop fields. `/props.blackice_runtime` contains the same native receipt object. Matching only a PID is insufficient after context reload; match startup ID and process start time as well. During sleep, the current props field is null and only the separate previous-runtime field retains history. A context that has ended cannot qualify as the current awake context.

Context, thread, batch, and microbatch values use native getters. Flash attention uses the resolved context parameter after reserve initialization. MiniCPM hybrid attention-cache types use the actual cache getters. GPU layer count counts real GPU/IGPU layer devices, including the output layer; unresolved meta-device placement stays unknown. Projector load and path are observed, while its placement is explicitly marked unknown by this collector. The host independently enriches model/executable hashes and the full runtime bundle identity without presenting those additions as native observations.

## Exact computation correspondence

`server_batch_begin.data.rows` contains view row, server row, task, slot, token, positions, output flag, prompt/generation distinction, and embedding-row marker. `microbatch_begin` records the actual core tokens, position sections, sequence IDs, output mask, and original view indices from the native batch allocator. Warmup microbatches have `batchId: 0` and `phase: initialization`; they are not task evidence.

`tensor_statistics` has startup, batch, and microbatch IDs. It intentionally has no single `taskId`: one tensor can cover rows from several tasks. Join each `perToken.microRow` to its `microbatch_begin` row, then use that row's `batchRow` to join the server batch and native task. A missing or unsupported mapping invalidates capture. Never assign an entire mixed tensor to a task by proximity or output text.

The selected four anchors are observed across all transformer layers. Every value in each selected contiguous float32 tensor contributes to per-token finite/zero/NaN/infinity counts, mean, RMS, and maximum magnitude; the complete raw tensor bytes are also hashed. Individual neuron values and full model weights are not dumped. Missing, duplicated, unsupported, or oversized selected tensors are explicit failures. This supports a measured layer-activation comparison; it does not establish a semantic explanation for reasoning or show dense weights switching on and off.

`sample_logits` records sampled token ID, batch row, raw full-vocabulary logit hash, optional vector artifact, and numerical statistics. `accepted_token` records each token passed to the server token processor. A terminal sampled token need not be decoded again. Returned `/completion` token arrays, SSE content, sampled tokens, accepted tokens, and later decode tokens are separate observations and must not be treated as interchangeable.

Cache evidence includes actual clear/remove/copy/keep/shift/divide operations, maintenance preparation/application, chosen cached prefix length, and hashes of actual saved/restored state bytes. It covers hybrid recurrent state as well as attention cache operations. External session-state file import/export is explicitly rejected while this trace contract is enabled; internal prompt-cache state transfers remain supported. Single-completion text requests are the qualified target. Multimodal embedding input and multiple completions are explicit unsupported capture paths.

## Completion and failure rules

Request acceptance/body evidence, startup receipts, task terminals, slot release, HTTP generator end, and response observations are flushed to disk. A task span requires its matched request, `task_terminal` with `traceComplete: true`, `slot_release` with `hadTaskTerminal: true`, and matching HTTP response/generator events. Check task outcome separately from trace completeness. A 200 header or generator completion alone does not prove semantic success or client receipt.

For streaming `http_generator_end`, require `transportProviderSuccess: true`, `producerExhausted: true`, `sinkDoneCalled: true`, `chunkWriteFailed: false`, and `complete: true`. `transportProviderSuccess` is the unchanged raw httplib releaser boolean. `producerExhausted` means `next()` returned false and is observed before attempting any final chunk write. `sinkDoneCalled` means invocation only; it does not report the result of the library's internal trailer writes. A false raw releaser outcome cannot be overridden by the other fields.

For nonstream generator events all four transport/producer/done/write fields are explicitly null. The event describes prepared response content, without asserting transport completion. `http_response_observed` is the library's pre-write status/header observation and may precede body generation, task completion, and the streaming generator terminal. Require its matching identity/status, but never impose an after-body ordering or treat it as client receipt.

Overflow or an I/O/callback/identity/mapping error cannot become a complete trace. If the disk cannot even save an invalid marker, stderr plus missing required terminals still make the capture incomplete. The invalid marker is a first-failure snapshot: its dropped counter is not a final count of all later suppressed writes. Retained files remain an incomplete prefix. Failed compute attempts are recorded as failed; an observed retry is not silently mistaken for a successful first attempt.

A graceful main return records `process_end`. Upstream direct `exit()` paths record `process_exit_without_main_return` with an unknown exit code and `complete: false`; an independent host exit observation is needed. Forced termination does not run either handler. For deliberately terminated standalone qualification processes, wait for all required task/slot/HTTP events before termination, retain the host termination receipt, and scope any validity claim to those settled task spans. Do not claim whole-process clean completion.

Tracing changes synchronization and host/device transfer costs. Its timings are not inference-performance benchmark results. Original bundled parity and same-instrumented-binary activation on/off parity must pass before a weight-surgery comparison is admitted.
## Empty output rows and terminal trace errors

The pinned Qwen3.5 decoder selects output rows before the last layer's
`attn_post_norm`, `ffn_out`, and `l_out` anchors. A request microbatch can contain
real prompt tokens while selecting no output rows. Those three tensors then
have no elements. This disposition is distinct from a measurement of zero
activation values.

The recorder emits `tensor_empty` only for the source-proven case: architecture
`qwen35`, default graph, zero MTP layers, the actual final model layer, one of
those three post-selection anchors, F32 shape `[modelEmbeddingSize, 0, 1, 1]`,
strides `[4, 4*modelEmbeddingSize, 0, 0]`, and zero bytes. The context must already
be published, the server batch ID must be positive, and every actual microbatch
row must map to its observed server row with an explicitly present, all-false
output mask. Initialization, missing masks, source mismatches, other layers or
architectures, `attn_norm`, and unsupported descriptors remain rejected.

The empty event retains the native descriptor and source-mask proof. It contains
no `perToken`, statistics, raw-data hash, or backend read. It does not increment
the measured `tensorEvents` counter. `microbatch_end` now records separate
`measuredTensors` and `emptyTensors` maps alongside the complete
`observedTensors` anchor map. `context_end.emptyTensorEvents` is separate from
measured events; `tensorBackendReadCalls` counts the actual tensor-get call sites.
Actual model architecture, layer count, MTP layer count, and embedding size are
bound through `context_start`, the immutable startup receipt/current props, and
each empty event. `microbatch_begin.outputMaskObserved` distinguishes an observed
false mask from a missing mask.

An unhealthy recorder still invalidates capture and stops ordinary trace writes.
Its decode-abort result now enters the server's explicit task-error, active-slot
release, and prompt-clear path, then throws before the KV-capacity retry. This
does not fabricate a complete trace after an I/O or coverage failure. The
invalid marker, stderr and client error remain failure evidence. The existing
handling of unrelated, healthy-recorder aborts is outside this narrow repair.

`blackice-decode-error.h` is the actual classifier and cleanup helper used by
the server and the model-free native fixture. The private CLI
`--blackice-trace-empty-self-test <new-absolute-output-directory>` exercises the
actual callback with GGML-created tensor descriptors, 20 rejected empty cases,
and a CPU-buffer control with 93 measured anchors plus three empty observations.
The fixture uses synthetic model metadata and counted slots; it loads no model.

`empty-output-compat.cjs` is the historical R4B3 migration runner. It provides bounded `apply`, `build-step`,
`native-fixtures`, `http-fixtures`, `freeze`, and `gate` actions under a supplied
owned trace root and requires that campaign's preserved inputs. Use the fresh-root workflow for new builds. Builds use at most two compiler workers. Its historical bundle is
`io-stream-empty-compat-instrumented`; the qualified baseline and previous
instrumented bundle remain separate and immutable. The gate verifies actual
CLI/DLL loading, original GGUF/math-DLL identities, native callback/error-route
fixtures and the four existing real-HTTP stream cases. A passing model-free
gate qualifies the new binary for a separately scheduled model parity run;
it does not establish model parity, live activation coverage, or benchmark scores.
