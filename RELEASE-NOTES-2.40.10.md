# BLACKICE 2.40.10

Candidate source notes, not an installation or publication receipt.

In **Config → Local Models**, BLACKICE shows and prepares the default `models` folder under its profile data. It is the same folder used by the bundled llama.cpp router. Keep an existing custom folder or clear the custom value to use the default. No model files are moved or downloaded.

**Discover folder models** asks the actual router for its catalog. It may start or replace BLACKICE's idle router, but not interrupt a model with an active lease. Independently managed llama.cpp, Ollama and LM Studio retain their own storage. Catalog detection does not prove model inference or GPU acceleration.

The diagnostic capture selector now says **Diagnostics**. Turning it on does not change how the model runs. This candidate does not include the action-oriented Directory or three-module Planning rebuild.
