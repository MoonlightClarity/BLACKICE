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

## Runtime behavior

- **Load** brings a downloaded model into the chosen runtime, optionally with an explicit context window.
- **Unload** releases runtime memory without deleting the weight files or conversation history.
- **Import & load** registers a new Ollama model from a local file/folder, then loads and registers it with BLACKICE.
- Local runtime APIs are bound to `127.0.0.1`; these endpoints do not upload model files to cloud providers.
- The feature requires Ollama or LM Studio to be installed and running. If neither is present, the panel reports both engines offline. The source/test integration works without installing either runtime.
- Ollama and LM Studio models vary in tool-calling support, context size and memory needs. Model availability does not by itself guarantee compatibility with every BLACKICE agent workflow.
