# MiniCPM context, vision, and llama.cpp validation

Date: 2026-11-20. Source base: BLACKICE 2.40.64, commit
6db69114c5869e835c628bac0faeb0b1436e1054.

## Scope

This work implements managed-model context discovery before admission, matching
vision-projector launch settings, fresh image-capability discovery, and optional
thread/batch/KV-cache controls. It also compares a bounded set of real runtime
configurations on this machine. Language-model weights are unchanged; no LoRA or
fine-tuning was performed.

Hardware: NVIDIA Quadro RTX 3000, 6144 MiB VRAM, compute capability 7.5; Intel
Core i7-10750H; 32 GB RAM. Runtime: llama.cpp b12359,
commit b1b770d90d94cad9e9ea5b993bdbc383a522fb28.

Model: MiniCPM-V-4.7-1B-heretic-Q4_K_S.gguf. SHA-256:
0c91d961f2eb27e8b32bbcdbae45bcdc06002e55022c6ee66ba3bf4ce347116a. The language model has approximately 1.006 billion
parameters. Its native context is 262,144 tokens.

## Selected local profile

Use the bundled Vulkan executable. Keep the global executable override empty.

| Setting | Selected value |
| --- | --- |
| Requested context | 262144 |
| Parallel slots | 1 |
| Text-model GPU layers | auto; observed 25/25 offloadable layers |
| Flash Attention | auto; observed enabled |
| Key/value cache | q8_0 / q8_0 |
| Projector placement | CPU, mmprojOffload false |
| Fit target | 1024 MiB |
| RAM prompt cache | 0 |
| CPU polling | 0 |
| Generation/prompt threads | omitted; observed native 6/6 |
| Logical/physical batch | omitted; observed native 2048/512 |
| Thinking | native template default remains enabled |

Bind the matching projector through the exact model's mmprojPath override.
Its file lives outside the scanned language-model directory.

The matching publisher revision is
c353e931b31f4bb6217b84ff99f0d1b6da93d97d. Projector size is 1,108,763,232 bytes;
SHA-256 is
9e1672166a455f579b4a441590d93f13342a08ecc159719c8eb7a1eac101317f.
The download and checksum were verified before loading.

The selected profile allocated the full 262,144-token slot. Q8 K/V occupied
1632 MiB, compared with approximately 3072 MiB for full-context F16 K/V.
The approximately 1440 MiB reduction concerns the KV cache, not model weights.
Recurrent state, compute buffers, projector memory, and desktop GPU use are
additional.

## Bounded runtime comparisons

| Configuration | Result | Maximum sampled GPU used / minimum free |
| --- | --- | --- |
| Vulkan, F16 K/V | Coding request 27.85 s; lookup correct | 5748 / 208 MiB |
| Vulkan, Q8 K/V | Coding request 6.09 s; lookup correct | 4368 / 1588 MiB |
| CUDA 12.4, Q8 K/V | Two coding requests timed out before completion | 4968 / 988 MiB on retry |
| Vulkan Q8, GPU projector | Image correct, 11.20 s | 5518 / 438 MiB |
| Vulkan Q8, CPU projector | Image correct, 5.98 s | 4872 / 1084 MiB |

All configurations allocated the full context and used one slot. The two
completed coding timing probes generated approximately 72.4 and 135.7 tokens/s,
respectively. The 1558-token lookup prompt processed at approximately 235.1 and
257.1 tokens/s.

These timings include first-request initialization and use short generations.
They do not establish a general speedup ratio. Background desktop GPU usage
varied; physical free-memory figures are observations, not guaranteed reserves.
CPU projector placement was selected primarily for memory headroom. Its faster
single-image result does not establish that CPU vision is generally faster.

CUDA's first load took 68.69 s; its repeat loaded in 1.71 s. Both then exceeded
the 35-second coding-request limit. The repeat processed 177 prompt tokens in
approximately 29.8 s despite full GPU offload and enabled Flash Attention.
The cause was not established. The exact-build CUDA download was retained as
an optional candidate and was not selected as the active runtime.

The router's memory-breakdown report omits projector memory. The native model
loader does estimate the GPU projector separately and adds it to the fit target.
Native Vulkan/WDDM availability differed from physical nvidia-smi free memory,
so the measured margin informed the selection.

## Functional evidence

The real image fixture is a 720 x 400 PNG containing a four-character code and
two colored rectangles. Both projector placements returned the exact expected
observations: M7Q4, blue on the left, orange on the right. The prompt did not
provide those answers.

The loaded model catalog reported text, image, and video input modalities, text
output, and meta.n_ctx = meta.n_ctx_train = 262144. Only still-image input was
functionally tested; this is not a video-validation claim.

The two coding timing probes explicitly disabled thinking, used temperature 0,
seed 1234, and a 256-token cap. Both returned the original buggy function as
final content, with finish_reason stop and 48 output tokens. They failed the
first-occurrence/order requirements. These timing settings were not applied to
normal chats.

A separate controlled coding check retained the same greedy sampler but restored
the native thinking default and allowed 2048 output tokens. It reached the cap
with finish_reason length before producing a final answer. This is a bounded
incomplete result, not a completed-answer accuracy score. The existing 8192-token
normal-chat output allowance was preserved. No reasoning-quality improvement
has been established by this work.

The corrected provider now loads the selected model before admission, refreshes
live capacity and modalities, holds a lease through the run, and releases it on
completion or failure. It recognizes the equivalent managed localhost and
127.0.0.1 routes without rewriting saved conversation addresses. It preserves
smaller explicit user windows and output limits. A stale error-learned capacity
does not supersede a freshly confirmed runtime allocation.

## Verification status

- Context/provider focused suites: 138 tests passed, zero failures.
- Launcher/settings UI focused suites: 43 tests passed, zero failures.
- Independent review corrected endpoint matching and fallback-capacity cases.
- Real provider/router/tool-image integration: passed. Cold managed startup used
  a 262144-token effective window in the first context event, refreshed a stale
  text-only catalog entry to include images, executed one real image tool call,
  and returned the correct code and both colors. The model lease count returned
  to zero and the isolated router was closed.
- Installed application activation: completed through the native restart
  mechanism while idle; saved launch-settings revision advanced from 13 to 14.
  The guided installed Chat validation passed with one successful relay_files
  image call and one image_url payload whose decoded SHA-256 matched the fixture.
  Its first context event used 262144 effective tokens, an 8192-token output
  reserve, 8192 tokens of headroom, and a 245760-token input budget.

The test covering an input estimate above 128k uses controlled inference. The
live tests prove allocation, short prompt behavior, and image transport; they
do not prove retrieval accuracy across a full 262,144-token prompt.


### Remaining Chat tool-use failure

The first installed Chat check used a natural request to inspect the attached
image. It made nine tool calls, seven of which failed. Its only image call used
the filename as attachmentId rather than the provided scoped file ID. The host
correctly returned ATTACHMENT_NOT_IN_TASK_SCOPE. The model then gave an
unsupported, incorrect visual answer. No image content reached that run.

A second installed check supplied the exact valid relay_files image call but
did not reveal the expected visual answer. It made one successful call, received
the original 6900-byte PNG, and correctly reported M7Q4, blue on the left, orange
on the right, and the LEFT/RIGHT labels. The decoded payload hash matched the
fixture, attachment blob, and attachment metadata.

This establishes installed image delivery and recognition with correct tool
use. It does not establish reliable unguided tool selection. Attachment scope
checks were preserved. The two initial Chat prompts contained approximately
41k estimated tokens including instructions and tool definitions, which is
relevant evidence for the next prompt/tool-catalog and coding-workflow phase.

## Evidence files

Machine-local scripts, logs, checksums, process-exit receipts, and result JSON
are in verification/minicpm-phase12 in the implementation worktree. Key files:

- tuning-summary.json
- recommended-minicpm-override.json
- projector-download.json
- cuda-download.json
- profile-vulkan-baseline.json and .log
- profile-vulkan-q8.json and .log
- profile-cuda-q8-cold.json and .log
- profile-cuda-q8.json and .log
- profile-vulkan-q8-vision.json and .log
- profile-vulkan-q8-vision-cpu.json and .log
- context-provider-tests.log
- provider-vision-integration.json
- installed-runtime.json
- installed-chat-vision-forensics.json
- installed-chat-guided-vision.json
- installed-overlay.json
- activation.json

## Primary references

- [llama.cpp MiniCPM-V 4.7 architecture, conversion, projector, and thinking](https://github.com/ggml-org/llama.cpp/blob/b1b770d90d94cad9e9ea5b993bdbc383a522fb28/docs/multimodal/minicpmv4.7.md)
- [Exact llama.cpp release](https://github.com/ggml-org/llama.cpp/releases/tag/b12359)
- [Matching model and projector publisher](https://huggingface.co/saidutta69/MiniCPM-V-4.7-1B-heretic/tree/c353e931b31f4bb6217b84ff99f0d1b6da93d97d)
- [Official MiniCPM-V 4.7 deployment guidance](https://openbmb.cn/docs/en/guides/minicpm-v/minicpm-v-4.7/deploy)

The next quality step is a small coding evaluation with executable checks and a
repeatable plan/edit/test workflow. Runtime tuning alone has not demonstrated
better underlying coding reasoning.
