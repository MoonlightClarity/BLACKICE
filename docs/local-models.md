# Local models in BLACKICE

BLACKICE can discover, load, unload and use models from local runtimes. The **Settings → Models → Local models** panel is separate from optional cloud API connections. A loaded model is registered in the normal chat model picker; adding it does not replace the selected default model or rewrite existing conversations.

Use **Remove** beside a saved local model in the Chat picker to take it out of the list, even if its file is missing. This keeps model files and chat history. To add the model to the picker again, load it from Local models.

## Ollama

1. Install and start Ollama so its local API is available at `http://127.0.0.1:11434`.
2. Open **Settings → Models → Local models**, choose **Ollama**, and refresh.
3. Choose an installed model and **Load**.
4. To import local weights, expand **Import local weights into Ollama**. Supply an absolute path to a `.gguf` file, or a directory containing `config.json` and `.safetensors` weights, and a local Ollama model name.
5. Choose the registered model (for example `local_ollama::my-model`) from the BLACKICE chat model picker.

The importer creates a temporary Ollama Modelfile with `FROM "<absolute path>"` and calls `ollama create <name> -f <Modelfile>`. It does **not** request quantization. Existing GGUF precision is unchanged by BLACKICE; imported Safetensors are passed to Ollama in their source format. Ollama's supported architectures and import behavior depend on its installed version. For an FP16 workflow, supply FP16 weights; BLACKICE never adds a 4-bit or 8-bit conversion step.

## LM Studio

Start LM Studio's local server at `http://127.0.0.1:1234`, refresh the Local models panel, choose a downloaded LLM, then load it. BLACKICE uses LM Studio's native load and unload APIs and registers the chosen model through its OpenAI-compatible chat endpoint. If authentication is enabled on the local server, additional connection configuration may be needed.

## llama.cpp 1.0 (direct server)

BLACKICE connects directly to the official `llama-server` OpenAI-compatible API. Neither Ollama nor LM Studio is required.

1. The Windows x64 installer includes a pinned **llama.cpp v1.0.0** runtime; no separate runtime installation is needed. Other platforms or custom setups can use a compatible `llama-server` from the [official release](https://github.com/ggml-org/llama.cpp/releases/tag/v1.0.0). Model weights remain separate. See [bundled runtime provenance](BUNDLED-LLAMA.md).
2. Under **Models → Local models**, click **Load GGUF file…** and confirm the file to load it immediately. To return to a saved model, select it and click **Load**. Switching does not require deleting the previous model or its weights.
3. **More options** contains folder discovery, runtime setup, and tuning. Discovery starts or refreshes the owned idle router without loading a model. The router may unload cached weights when it restarts. BLACKICE does not create a missing custom folder. Unavailable saved files are skipped when launching other models; their entries are retained if the files return.

For an independently managed server, follow this separate path:

1. Put existing GGUF weights in a folder (for example `C:\Models`). From a terminal, start **router mode**:

   ```powershell
   llama-server --host 127.0.0.1 --port 8080 --models-dir "C:\Models" --models-max 1 --no-models-autoload
   ```

2. Open **Config → Local Models**, choose **llama.cpp**, and refresh. An independently managed server supplies its own catalog and does not use the BLACKICE folder setting.
3. Choose an available model, then **Load**. BLACKICE calls `POST /models/load`, confirms the model is loaded, and registers `local_llamacpp::model-id` without changing any conversation defaults.
4. **Unload** calls `POST /models/unload`; it releases the active model but never deletes its GGUF weights or saved BLACKICE conversations.

**Single-model mode:** An existing `llama-server -m "C:\Models\my-model.gguf" --host 127.0.0.1 --port 8080` is also supported. The already-running model appears in BLACKICE and can be added to Chat, but it cannot be unloaded through the router API; stop or restart its server process instead.

**v1.0 options:** Context length, CPU/GPU placement, speculative decoding, FP8 KV caching, and MoE expert caching are configured on `llama-server` itself, not by BLACKICE's load request. For example, `--ctx-size 8192` sets the startup context; `--models-preset` configures models individually. Advanced supported builds expose `--moe-cache-mib` and `--moe-cache-cpu-share`; these are opt-in and should be tuned to your machine instead of assumed faster. Changing such flags requires restarting the server and possibly reloading the model.

BLACKICE reads `GET /models` (router) or `GET /v1/models` (single process), sends inference through `http://127.0.0.1:8080/v1`, and does not change source weight precision or request quantization. The locally running server's model, template, and hardware determine tool calling and multimodal support; discovery is not a guarantee of successful agent use.

## Runtime behavior

- **Load** brings a downloaded model into the chosen runtime. Ollama and LM Studio accept an optional context window; llama.cpp takes context settings at server startup.
- **Unload** releases runtime memory without deleting the weight files or conversation history.
- **Import & load** registers a new Ollama model from a local file/folder, then loads and registers it with BLACKICE.
- Local runtime APIs are bound to `127.0.0.1`; these endpoints do not upload model files to cloud providers.
- Ollama and LM Studio need an installed and running external server. BLACKICE can start its included llama.cpp router on demand; independently managed servers can still be used.
- Ollama, LM Studio and llama.cpp models vary in tool-calling support, context size and memory needs. Model availability does not by itself guarantee compatibility with every BLACKICE agent workflow.


### Context capacity and active memory

For managed local llama.cpp models, BLACKICE loads the selected model before checking the conversation budget and image capability. It refreshes the running model's per-slot context capacity, so an unloaded model's fallback estimate does not remain the admission limit. The same preparation applies to manual compaction. Existing conversations keep their saved provider address and model.

`ctxSize: 0` asks the runtime to choose the model's native context. A requested or advertised maximum is not proof that this much context was allocated: GPU fitting can reduce it, and parallel slots can divide it. BLACKICE uses the actual per-slot limit and preserves a smaller explicit user context setting. The input budget also reserves room for output and safety headroom.

### Vision projector (per model)

Some multimodal GGUF models, including MiniCPM-V, need a separate matching projector GGUF. Under **Advanced runtime & model settings**, enter the exact saved model ID and the absolute projector path in the per-model vision section, stage the setting, and save the launch defaults. Store the projector outside the scanned language-model folder so it is not offered as a standalone chat model.

The matching language model, projector, chat template, and runtime build must all support the same architecture. A projector from another model is not interchangeable. The optional placement setting selects GPU or CPU vision encoding; leaving it unspecified retains the runtime default. CPU placement can preserve GPU space for language inference and context, at the cost of image-encoding time.

Saved settings take effect at the next owned launch. Independently managed servers retain their own launch configuration. Once the live model reports image support, the compatible provider can send images returned by BLACKICE tools through its existing image transport.

The stored override is:

```json
{
  "modelOverrides": {
    "exact-model-id": {
      "mmprojPath": "C:\\ModelProjectors\\matching-mmproj-F16.gguf",
      "mmprojOffload": false
    }
  }
}
```

### Optional llama.cpp tuning

Advanced launch settings support these optional values globally or inside an exact model's `modelOverrides` entry. Blank optional controls omit the setting and retain the runtime's default.

| Setting | Runtime option | Purpose |
| --- | --- | --- |
| `threads` | `--threads` | CPU threads used during generation |
| `threadsBatch` | `--threads-batch` | CPU threads used during prompt processing |
| `batchSize` | `--batch-size` | Logical prompt batch size |
| `ubatchSize` | `--ubatch-size` | Physical prompt microbatch size |
| `cacheTypeK` | `--cache-type-k` | Key-cache precision |
| `cacheTypeV` | `--cache-type-v` | Value-cache precision |

Supported cache names are validated before saving, but usable combinations still depend on the runtime, model architecture, and attention backend. KV-cache quantization changes inference-state precision; it does not rewrite the model weights. `cacheRamMiB` controls the separate RAM prompt cache and does not select KV-cache precision.

Tune a small set of configurations on the actual machine. Keep the model, prompt, sampling, output allowance, and parallel-slot count fixed when comparing speed. Record actual context allocation, offloaded layers, memory headroom, time to first answer, prompt/generation throughput, and answer correctness. Cold initialization and steady inference need separate measurements. Include a real image when sizing a vision configuration: the runtime's fit estimate may not include all projector memory.

A faster backend or larger window does not by itself improve coding accuracy. Keep reasoning/thinking behavior and answer quality visible when evaluating generation settings.

### Optional YaRN context extension

Under **Config → Models → Local models → llama.cpp → Advanced runtime & model settings → YaRN context extension (per model)**, enter the exact local model ID, the original context documented for that GGUF, and a larger target (up to 262,144 tokens). Choose **Set YaRN**, then **Save launch defaults**. **Clear YaRN** removes that setting for the selected model only after saving. The bundled router applies the model-specific preset at its next owned launch; existing models and independently managed servers are not changed. No restart or load occurs while saving.

The requested target is not a measured usable context. Use only a model that documents YaRN compatibility, and allow for additional memory use and potential quality loss. Verify the model's actual runtime context after loading before relying on the extension.
### Validation scope

The adapter is covered by controlled HTTP and UI fixtures, including single-server mode, router lifecycle, context admission, image capabilities, and per-slot context metadata. A bounded MiniCPM-V 4.7 check also verified real managed-router startup and image-tool delivery with a full 262,144-token allocation; see [the measured profile and validation limits](minicpm-context-vision-runtime-20261120.md). This does not establish maximum-window recall or general coding quality. Sleeping processes are shown as sleeping rather than resident in memory; inference can wake them.

Candidate bundled-runtime implementation and verification: [Bundled llama.cpp](BUNDLED-LLAMA.md). This is not an installed-release claim.

### Read-only prerequisite check

From a source checkout on Windows x64, run:

```powershell
node scripts/inspect-local-model-prerequisites.mjs '<installed-or-built-llama.cpp-directory>' [local-llama-port]
```

The default server port is 8080. This command validates the bundled runtime and
runs its existing device enumeration. Independently, it uses BLACKICE's normal
llama.cpp catalog client to detect available model IDs on the specified local
server. It reports counts rather than model names, and does not start a server,
load weights, submit a prompt, download anything, or change profile settings.

The JSON separates an empty catalog from an unavailable catalog, and a failed
Vulkan probe from a successful probe with no devices. Stage durations are for
triage, not performance benchmarks. Exit 0 means both prerequisite checks
detected something; exit 1 means at least one did not. An available CPU runtime
can still work even if the GPU prerequisite is not met. Neither a catalog entry
nor GPU enumeration proves inference or GPU offload. Those are marked
`not_tested`. Use the separate isolated runtime fixture for inference/runtime
lifecycle tests.

## A separate local default

In **Settings → Models → Local models**, choose an available registered llama.cpp model under **Local default model**, then select **Use as local default**. **Clear local default** removes this preference. This setting uses the managed compatible route at `http://127.0.0.1:8080/v1`; custom inference endpoints and other provider types are not eligible.

Chat displays the selected model as **Local · model name**. Choosing it saves the concrete `provider::model` identifier through the existing model picker. Changing the local preference leaves the app-wide default and models already selected in existing chats intact. The choice still follows normal provider visibility, activation, availability and removal checks.

The preference records a saved registration, not proof that weights exist or a model is loaded. Missing or disabled models remain visibly unavailable; use the existing **Add GGUF** setup to restore a model, choose another, or clear the preference. Saving or clearing the preference does not load a model, download weights, or initialize a MiniCPM calibration profile.

The local-session-only `POST /api/local-models/default` accepts `{ "model": "local_llamacpp::model-id", "expectedLocalDefaultModel": null }`; `model: null` clears the preference. Supply the current nullable preference as `expectedLocalDefaultModel`. A stale value returns `409` without changing it. `GET /api/local-models` includes `localDefaultModelStatus` (`model`, `eligible`, `reason`) and minimal `localDefaultChoices` for registered eligible models. `eligible` describes registration and routing; it is separate from runtime/file availability. The ordinary app status includes the same preference status.
# MiniCPM setup for Local

When the bundled MiniCPM setup is available, **Set up MiniCPM for Local** opens the existing Local models settings and prepares its pinned model and vision projector. The two original assets total 1,756,723,456 bytes (about 1.64 GiB). Setup verifies existing configured files at their actual locations, including model and projector files stored in different folders. Correct renamed files are reusable because verification checks their size and SHA-256, not their basename. A configured missing or mismatched file is reported; it is never silently replaced or repointed.

Only an asset without a configured path is prepared in the managed models directory. Downloads are explicit and verified before exclusive publication. Opening the app or viewing settings never starts a download or loads a model.

Setup initializes per-model runtime settings only when that model has no override entry. An existing override, including an empty object, is preserved exactly. The result reports when those existing settings prevented the supplied defaults or projector configuration from being applied. Existing global settings, hardware auto-fit, provider policies, and other models remain in place. A genuinely new llama.cpp provider uses the native provider-default output policy, including when its ID requires a suffix.

The separate Local preference is initialized only if it has never been configured. Explicitly selecting or clearing it records that choice, including clearing an already-empty preference. An existing selection or deliberate clear is preserved. Setup does not change the app-wide/cloud default, select a model in the current chat, rewrite old chats, or activate a model. Selecting the concrete Local model later uses the existing activation checks.

Each setup has a saved intent and stage receipt. A failure or cancellation can leave verified files, saved launch settings, or a registered model from an earlier completed stage. The result reports those effects; it does not claim that the settings and provider stores form a single transaction. Retrying an uncertain intent reads or joins that same operation. A confirmed failed or interrupted setup can be retried with refreshed expectations and a new intent; already verified assets are reused. Interrupted work does not resume automatically at startup.

