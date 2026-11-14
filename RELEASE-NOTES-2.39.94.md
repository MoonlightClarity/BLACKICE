# BLACKICE 2.39.94 source candidate

This is a prepared source candidate, not evidence of a published or installed release. The exact candidate still needs coordinated tests, packaging and installed-build verification.

The candidate separates conversation Autonomy from Goal Mode, including an exact-model allowlist for autonomous coordinator and worker dispatch. Native runtime discovery and result delivery include recovery paths for uncertain writes. Goal action recovery retains uncertain effects and offers a local operator reconciliation control; it does not promise exactly-once external effects.

Visual authoring and Directory planning receive additional guidance and controls. Local-model settings include on-demand llama.cpp configuration alongside official runtime download discovery. Local runtimes and model weights remain separately installed; native server startup, GPU operation and cleanup require verification on the target system.

This candidate incorporates the previously released 2.39.93 browser, Goal and llama.cpp download behavior. See the [2.39.93 notes](RELEASE-NOTES-2.39.93.md) for that release's scope and limitations.
