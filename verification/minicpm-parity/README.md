# MiniCPM runtime parity

This is unscored runtime qualification. It does not measure coding ability, sustained long-context accuracy, or throughput.

The fixed profile allocates 262144 context tokens, one slot, 6/6 threads, 2048/512 batch sizes, 25 GPU layers, Q8 KV and enabled flash attention. Sampling is explicitly seed 1234, temperature 0.8, top-k 40, top-p 0.95 and min-p 0.05. Image projection is absent and live vision/video flags must be false. Actual properties and source-proven startup logs must confirm the settings.

Run syntax/help and fixtures before any model invocation:

    node --test verification/minicpm-parity/parity-contract.test.cjs
    node verification/minicpm-parity/runtime-parity.cjs --help

Only the coordinating host schedules model loads. Each run needs full expected executable/model SHA-256 hashes, absolute paths, an unused loopback port, a new output folder, the explicit profile, and a fresh saved app/native-process admission. No other llama server or CLI process may be present. The runner uses only its own ChildProcess handle for cleanup.

The run saves exact request bodies, correlation IDs, received decoded HTTP body bytes, props, slots, startup stdout/stderr, actual process/loaded-module identities, all DLL and model hashes before/after, and a final result. Existing output is never reused. A failed probe remains on disk and returns nonzero.

The two native /completion requests use return_tokens:true and a tiny constrained grammar. Two actual tool cycles execute parity_echo locally, feed its result back, and demand a complete nonempty final answer with no further calls. Exact-answer instruction adherence is reported separately, including deviations and untouched text; it is not silently normalized or called task success. Thinking is explicitly disabled for these bounded transport probes. A raw generated tool-call ID is retained and mapped to a fixed host alias in the continuation so identical outputs produce identical follow-up bytes.

Native cache reuse uses tokens_evaluated minus timings.prompt_n; tokens_cached is current cache size and is not treated as reuse. Chat uses usage.prompt_tokens_details.cached_tokens. Slot cache is erased before the cold chat cycle. The pinned server requires --slot-save-path even for erase; each run supplies a new private slot-state directory. No slot save/restore request is made.

Original-versus-rebuilt comparison checks exact native completion token arrays and exact chat message/reasoning/tool-call content. Generated IDs have explicit mappings. Raw wire hashes and their differences remain visible; timestamps and timing durations are not output equality. Original compatible streams expose no native token IDs, which remains an explicit gap.

Activation off/on requires the same instrumented executable, unchanged metadata recorder configuration, and the same shared native outputDirectory. Only activationCaptureEnabled changes. The runner supplies BLACKICE_TRACE_CONFIG pointing at its saved config; it does not edit executable sidecars. Native request/task/accepted-token/logit/terminal joins are separate requirements. Missing native evidence cannot pass. Deliberate Windows shutdown is scoped to already-settled task spans, not an assertion of clean process-destructor events.

collectionComplete describes capture and cleanup. parityFindings describes exact cold/cached equality. instructionAdherence separately records whether the final answer was exactly parity-ok, and preserves any deviation. Results are correctness evidence. Compilation or activation tracing may affect elapsed time; no timing or throughput conclusions are produced.

## Text position correspondence

The pinned allocator expands a scalar text position `p` into `[p]` for one position section, or `[p, p, p, 0]` for four. The server's logical row remains `[p, 0, 0, 0]`. The shared `text-position-correspondence.cjs` validates those exact representations for explicit token rows, with signed 32-bit coordinates and no embedding input. It preserves both observed arrays and the expected expansion. Unsupported section counts, nonzero unused logical coordinates, altered expanded coordinates, or absent text-input evidence fail explicitly. Lifecycle, measured-tensor and empty-tensor collectors reuse this correspondence while retaining their other row checks.

The helper's source hash attributes the rule; it does not prove a running binary's source identity or task ownership. Those require the separately bound native source/bundle and trace evidence. Both runtime entrypoints include the helper in their run-receipt source inventories. Reanalysis with a corrected collector is a separate post-hoc artifact and cannot replace a failed live result or establish a new live pass.

The affected source gate uses no model:

    node --test verification/minicpm-parity/text-position-correspondence.test.cjs verification/minicpm-parity/lifecycle-observation.test.cjs verification/minicpm-parity/native-observation.test.cjs verification/minicpm-parity/runtime-lifecycle.test.cjs
