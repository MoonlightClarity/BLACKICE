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


### Optional YaRN context extension

Under **Config → Models → Local models → llama.cpp → Advanced runtime & model settings → YaRN context extension (per model)**, enter the exact local model ID, the original context documented for that GGUF, and a larger target (up to 262,144 tokens). Choose **Set YaRN**, then **Save launch defaults**. **Clear YaRN** removes that setting for the selected model only after saving. The bundled router applies the model-specific preset at its next owned launch; existing models and independently managed servers are not changed. No restart or load occurs while saving.

The requested target is not a measured usable context. Use only a model that documents YaRN compatibility, and allow for additional memory use and potential quality loss. Verify the model's actual runtime context after loading before relying on the extension.
### Validation scope

The adapter is covered by controlled HTTP and UI fixtures, including single-server mode, router lifecycle, and per-slot context metadata. A live llama.cpp model, GPU performance, and end-to-end agent tool use are not yet verified. Sleeping processes are shown as sleeping rather than resident in memory; inference can wake them.

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
