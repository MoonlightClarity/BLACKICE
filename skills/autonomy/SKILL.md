---
name: blackice-autonomy-model-selection
version: 1
description: Advisory model selection and delegation guidance for autonomous BLACKICE conversations.
applies_when: autonomy_enabled
---

# Autonomous model selection and delegation

Autonomy is an operating mode, not a goal. The conversation's calibration and accepted user directions are the guide. Do not fabricate an objective, completion condition, or approval ritual merely because autonomous mode is on.

The user-selected **exact model allowlist** is the only new model-selection restriction. It must be enforced by the host on every actual coordinator continuation, model switch, and delegated worker launch. A model must never expand or edit its own allowlist. If a selected model is absent or unavailable, choose another eligible model; never silently fall back outside the allowlist.

For each useful action, determine the capabilities it actually needs: for example visual input, tools, long context, coding, browsing, or particular output support. Inspect current provider catalog descriptions, real tool availability, direct evidence, and recent results. Do not infer capability from model names alone or rely on a static model-specific capability matrix. When metadata is incomplete, use a low-cost reversible probe only if it helps; if a candidate fails, learn from the observed failure and switch to another whitelisted option.

Select models to benefit the user. Consider shared quota pools, free options, model strengths, estimated token use, latency and consequences of a failed attempt. Delegation is beneficial only when its expected saved time or task quality justifies consumption. Do not burn a high-value model quota for routine parallelism when a suitable whitelisted alternative exists. Preserve the existing conversation, progress and attribution when switching models.

Delegate bounded subtasks with relevant context and results, choose an eligible model for each, and integrate the answers. Avoid delegating a vision subtask to a model with no evidence of visual input support; prefer an eligible known-capable model or investigate first. Do not mistake tool-call success for task completion.

When no whitelisted model can perform a required step, continue other useful work or state the genuine limitation to the user; do not widen the allowlist, invent capability, or ask for routine approvals. Respect Stop and user changes immediately. The user may update calibration at any time.

## Operating scope

The saved scope is explicit: conversation, current goal, or BLACKICE-wide operator. Goals describe outcomes; autonomy governs initiative and model selection. They can be enabled together without two competing continuation loops.

Conversation scope covers this conversation and its delegated work. Goal scope is bound to the saved goal identity and ends when that goal ends; never transfer it to a new objective automatically. BLACKICE-wide scope makes this conversation the operator for authorized work across the application, not a command to restart every historical chat.

Use existing native capabilities rather than a second controller: relay_agents for native conversations and their goals; relay_control for workflows, execution settings and scheduled operations; native Swarm and Planning tools for coordination. Inspect actual live status and saved results before changing work. Remain responsive to user messages and Stop. A paused, expired or finished goal is not an excuse to bypass its boundary by launching an ordinary autonomous continuation.
