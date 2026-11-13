# BLACKICE 2.39.85 — Native autonomy and in-chat calibration

BLACKICE agents can manage other BLACKICE agent runs internally through `relay_agents`, while externally connected agents continue working.

- In-process launch of independent, saved agent conversations via the existing HarnessEngine.
- Explicit autonomy on/off in the Chat composer, **Off by default**, with calibration from saved conversation context before enabling autonomous continuation.
- Agent-to-agent `relay_agents` starts are manual by default; callers may explicitly opt into Goal mode with `autonomous:true`.
- Persistent Goal mode uses the existing continuation scheduler, original conversation identity, saved user directions and recovery receipts.
- Shared run discovery, inspection and live steering across internal and externally initiated runs.
- Stop and Goal set/update/pause/resume with revision binding, acknowledgement and duplicate-effect recovery.
- Parent/child run provenance stored in the existing engine snapshots; no separate agent execution database or controller process.
- Existing `relay_browser`, `relay_workspace`, Planning and external MCP access remain available.
- Agent tool catalogs honor saved historical snapshots and provider model-tool availability.
- Regression coverage: native-agent-control, engine, ConversationGoals, provider tool routing, Chat On/Off controls, calibration and hidden Electron renderer geometry.

This release changes only newly admitted agent turns. Historical conversations preserve their original tool catalog unless the existing documented handoff pathway establishes a fresh provider session. A successful launch receipt is not a completed task.

Initial release verification covers code tests and static checks. Installer signing, installation and public release gates remain separate.
