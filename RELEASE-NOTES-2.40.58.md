# BLACKICE 2.40.58

Windows candidate, separate from the 2.40.57 GitHub release.

- Directory preserves interrupted observations without counting them as unresolved external actions. A browser input rejected before dispatch can give the model one more chance to inspect the current tab. It never automatically replays the rejected input.
- The Chat picker checks saved GGUF paths and identifies missing files. Local loading waits for llama.cpp to confirm readiness.
- Filename search points the model to the local file reader. API and local runs with no attachments no longer receive the attachment reader. Adding attachments to a continuation refreshes the provider session while keeping the chat and task.
- Directory and tool receipts distinguish invalid actions from actions that did not run.

This does not establish the cause of the Windows hang or change local VRAM policy.
