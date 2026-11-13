# BLACKICE 2.39.82

## Direct llama.cpp server support
- Connects to an independently started local llama-server using its compatible API. Router mode is detected from documented server properties; single-model servers are not offered unsupported load/unload operations.
- Router load/unload requests verify the resulting model state. Sleeping models are labeled honestly. Context capacity uses reported per-slot model settings rather than treating the router memory pool as usable context.
- Adds direct server discovery to Local model settings while preserving current model/provider metadata and existing Ollama and LM Studio paths.
- This does not install llama.cpp, download weights, enable speculative MoE/GPU features, or change a conversation's selected model automatically.

## Repository documentation health
- Distinguishes current guidance, engineering references, and historical records; adds a documentation map, status register, and integrity check.
- Current Planning navigation is described accurately; earlier group-outline instructions are retained as a clearly labeled engineering reference.
- Source-version notes, published installers, and installed application state remain explicitly separate.

## Verification limits
- Adapter contracts were checked against official llama.cpp v1.0.0 source and exercised with source-shaped protocol fixtures. Focused lifecycle, context, catalog, and UI tests passed before combined verification.
- No real llama-server inference, model-weight loading, GPU benchmark, or universal speed improvement is claimed. Authentication-required or nonlocal server support is outside this change.
- The complete combined source suite and hosted installer checks are release gates; local installation remains separately verified and coordinated with active work.
