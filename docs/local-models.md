# Local models in BLACKICE

BLACKICE can discover, load, unload and use models from local runtimes. The **Settings → Models → Local models** panel is separate from optional cloud API connections. A loaded model is registered in the normal chat model picker; adding it does not replace the selected default model or rewrite existing conversations.

## Ollama

1. Install and start Ollama so its local API is available at `http://127.0.0.1:11434`.
2. Open **Settings → Models → Local models**, choose **Ollama**, and refresh.
3. Choose an installed model and **Load & add to BLACKICE**.
4. To import local weights, expand **Import local weights into Ollama**. Supply an absolute path to a `.gguf` file, or a directory containing `config.json` and `.safetensors` weights, and a local Ollama model name.
5. Choose the registered model (for example `local_ollama::my-model`) from the BLACKICE chat model picker.

The importer creates a temporary Ollama Modelfile with `FROM "<absolute path>"` and calls `ollama create <name> -f <Modelfile>`. It does **not** request quantization. Existing GGUF precision is unchanged by BLACKICE; imported Safetensors are passed to Ollama in their source format. Ollama's supported architectures and import behavior depend on its installed version. For an FP16 workflow, supply FP16 weights; BLACKICE never adds a 4-bit or 8-bit conversion step.

## LM Studio

Start LM Studio's local server at `http://127.0.0.1:1234`, refresh the Local models panel, choose a downloaded LLM, then load it. BLACKICE uses LM Studio's native load and unload APIs and registers the chosen model through its OpenAI-compatible chat endpoint. If authentication is enabled on the local server, additional connection configuration may be needed.

## llama.cpp 1.0 (direct server)

BLACKICE connects directly to the official `llama-server` OpenAI-compatible API. Neither Ollama nor LM Studio is required.

1. Install a **llama.cpp v1.0.0 or compatible** `llama-server` build from the [official release](https://github.com/ggml-org/llama.cpp/releases/tag/v1.0.0). This runtime is **not bundled or installed automatically** by BLACKICE.
2. Put existing GGUF weights in a folder (for example `C:\Models`). From a terminal, start **router mode**:

   ```powershell
   llama-server --host 127.0.0.1 --port 8080 --models-dir "C:\Models" --models-max 1 --no-models-autoload
   ```

3. Open **Settings → Models → Local models**, choose **llama.cpp 1.0**, and refresh.
4. Choose an available model, then **Load & add to BLACKICE**. BLACKICE calls `POST /models/load`, confirms the model is loaded, and registers `local_llamacpp::model-id` without changing any conversation defaults.
5. **Unload** calls `POST /models/unload`; it releases the active model but never deletes its GGUF weights or saved BLACKICE conversations.

**Single-model mode:** An existing `llama-server -m "C:\Models\my-model.gguf" --host 127.0.0.1 --port 8080` is also supported. The already-running model appears in BLACKICE and can be added to Chat, but it cannot be unloaded through the router API; stop or restart its server process instead.

**v1.0 options:** Context length, CPU/GPU placement, speculative decoding, FP8 KV caching, and MoE expert caching are configured on `llama-server` itself, not by BLACKICE's load request. For example, `--ctx-size 8192` sets the startup context; `--models-preset` configures models individually. Advanced supported builds expose `--moe-cache-mib` and `--moe-cache-cpu-share`; these are opt-in and should be tuned to your machine instead of assumed faster. Changing such flags requires restarting the server and possibly reloading the model.

BLACKICE reads `GET /models` (router) or `GET /v1/models` (single process), sends inference through `http://127.0.0.1:8080/v1`, and does not change source weight precision or request quantization. The locally running server's model, template, and hardware determine tool calling and multimodal support; discovery is not a guarantee of successful agent use.

## Runtime behavior

- **Load** brings a downloaded model into the chosen runtime. Ollama and LM Studio accept an optional context window; llama.cpp takes context settings at server startup.
- **Unload** releases runtime memory without deleting the weight files or conversation history.
- **Import & load** registers a new Ollama model from a local file/folder, then loads and registers it with BLACKICE.
- Local runtime APIs are bound to `127.0.0.1`; these endpoints do not upload model files to cloud providers.
- The feature requires an external Ollama, LM Studio, or llama.cpp server to be installed and running. Offline runtimes are displayed as unavailable; the integration tests work without installing any of them.
- Ollama, LM Studio and llama.cpp models vary in tool-calling support, context size and memory needs. Model availability does not by itself guarantee compatibility with every BLACKICE agent workflow.
