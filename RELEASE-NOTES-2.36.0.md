# BLACKICE 2.36.0 — Restart, browser and agent-workflow checkpoint

This release brings together the restart, browser compatibility and general agent-workflow changes since 2.35.6.

## Restart and startup

- Settings exposes **Force restart**, and the connected restart tool accepts an explicit force option. Managed force pauses automatic queues, attempts to interrupt owned work and browser activity, and records confirmed or uncertain effects. Unsaved work in private application sessions may be lost.
- On Windows, the native restart command supports an emergency fallback for a nonresponsive instance. The fallback identifies the intended process and profile before requesting termination and relaunch; the result can be uncertain, and the replacement must be checked after reconnecting. A running app, its profile and its launch mode remain distinct. Emergency claims are not recovered by the normal native restart-status command.
- Startup now shows completed initialization stages, the current stage and its elapsed time. The display is a progress indicator, not an estimated completion time or a guarantee that a long-running stage is advancing.

## Browser compatibility

- The contained browser is the default starting point for agent browser work; existing connected browser sessions remain available when a task needs them.
- Filtered reads retain bounded references from the same document, while navigation, replacement and detached or changed elements invalidate stale targets. Screenshot-relative pointer input is available for visible controls, and managed Chrome connections expose their supported vision input.
- The contained browser supports site-created popups, spellcheck and operating-system handoff for external protocols. User task tabs and the reserved calling conversation remain separate control targets.
- Explicitly selected files can be staged for managed imported Chrome profiles when the adapter cannot read the source path. Staged files remain available for the connection lifetime because a website may read them after the upload tool returns.

## Planning and representation

- Shared guidance asks the agent to represent the person being helped, advance their actual objective, make reasonable inferences from the available record and select material appropriate to the audience. Background experience and a desired direction are distinct, and adjacent opportunities need not be excluded.
- Independent useful actions need not wait for a comparison that is only needed to prioritize them. Ordinary steps necessary to an authorized outcome do not acquire separate confirmation requirements.
- Oversized bounded knowledge searches return the supported maximum with explicit limit and truncation metadata. Overlong planning evidence receives an exact length and recovery guidance rather than requiring the agent to repeat completed work.
- A portable opt-in representation evaluation supports fictional local cases and records provenance. The model-behavior samples are limited: neither the guidance nor a tool call establishes universal judgment quality. No automatic independent reviewer or blanket review gate is introduced.

The Windows installer is distributed under the project's existing release policy. Exact-candidate test and installer verification are recorded separately; a source test or packaged installer alone does not establish successful installation.
