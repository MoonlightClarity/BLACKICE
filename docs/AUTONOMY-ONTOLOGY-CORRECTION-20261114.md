# BLACKICE autonomy ontology correction — 2026-11-14

## Product requirement

Autonomy is a conversation-level operating mode, **not** a goal, a plan type, or a schedule. A conversation may have no explicit task and still have autonomy enabled. Calibration consists of saved user guidance and model eligibility; do not synthesize a permanent objective from the first message, require a done condition, or route the toggle through the Goal contract.

Autonomous mode lets the model drive BLACKICE itself, use its regular tools, make decisions, choose another model, and delegate tasks without routine human handoffs. Users retain a visible On/Off control and can revise calibration. Model switching must preserve the same conversation and historical model attribution.

## Only new hard enforcement: model allowlist

The user explicitly selects which **exact** model IDs autonomous operations may consume, including the coordinator, switched coordinator turns, and child workers. The host checks the allowlist immediately before each actual provider dispatch. A dynamic default alias or inherited model may never bypass it. No self-modification or wildcard expansion by the agent; unavailable eligible models do not trigger fallback outside the list.

The model-selection skill advises how to choose based on live provider capabilities, quota consumption, task requirements, and practical probes. A static model-specific vision/coding/tool matrix is **not** a host guardrail. If a whitelisted model proves unsuitable for a vision task, the agent should choose a better eligible model; no need to interrupt the user for ordinary routing. No model-specific quota estimates are hardcoded.

## Existing code and required integration

The 2026-11-13 visual-autonomy candidate uses `ConversationGoals`, `goal.objective`, `relay_goal`, and a Goal-backed chat toggle. That **does not** meet this ontology yet. It also makes delegated workers inherit the coordinator model instead of allowing independent permitted choices.

An isolated primitive and advisory skill have been added without changing the current runtime:
- `lib/autonomy-model-allowlist.mjs`: exact runtime selection validation without model capability taxonomy
- `skills/autonomy/SKILL.md`: advisory capability/efficiency guidance
- `tests/autonomy-model-allowlist.test.mjs`: positive and negative checks

Before integrating, separate persisted autonomy mode/calibration from user Goal records, provide a host-owned model whitelist editor in the chat, pass the policy into both coordinator continuation and worker dispatch, and add a model-selection action for enabled conversations. Preserve saved legacy Goal records and their existing semantics. Do not blindly rename all Goal types or change unrelated Planning modules.

Required acceptance: (1) enable autonomy in a conversation with no objective; (2) model chooses a permitted alternative for a vision task; (3) unlisted expensive model dispatch is rejected before token use; (4) a child worker uses a separately permitted model; (5) a missing provider does not silently escape the allowlist; (6) disabling autonomy prevents further automatic continuations; (7) switching retains transcript, user corrections and correct model attribution; (8) old Goal-mode data and current unrelated conversations still work.

## Integration status

This document and the three isolated files are a **candidate**, not a deployed feature. Current running BLACKICE 2.39.93 was not edited or restarted. No release or GitHub push was attempted; coordinate with the active reliability audit before merging.
