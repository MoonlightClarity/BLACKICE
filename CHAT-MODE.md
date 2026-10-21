# ChatGPT browser provider retirement

The experimental `chatgpt::chat-mode` provider has been removed. BLACKICE no longer starts an adapter that drives ChatGPT, reads its responses as a model transport, or offers browser-provider setup in its model picker.

## Supported ChatGPT workflow

Use the BLACKICE connection from ChatGPT. ChatGPT calls the authorized BLACKICE tools, inspects durable action receipts and returns the answer in the human conversation. Existing connection grants, OAuth, planning, file and browser tools remain supported. See [CHATGPT-CONNECTOR.md](CHATGPT-CONNECTOR.md).

BLACKICE's own scheduled and interactive workers use native Codex or a configured API model. The older reverse bridge/listener remains retired; it is not restarted by this change.

## Existing data

Saved conversations, drafts, task definitions, model defaults and `chat-mode-state.json` are preserved. A saved retired selection stays visible as unavailable with a clear explanation; it never silently falls back to another provider. Historical responses retain their original route label, marked Retired.

Select a supported model explicitly to continue a saved conversation through the existing text-history handoff. Old experimental thread IDs remain reserved and cannot be executed, steered or compacted through another provider. New model defaults and API connections cannot reuse the retired identifier.

The old `/api/chat-mode` status and action endpoints return authenticated `410 CHAT_MODE_RETIRED` responses and perform no browser actions. No legacy receipt is rewritten or acknowledged as part of retirement.

## Verification

Provider, storage, UI, HTTP and architecture regressions verify catalog removal, compatibility with saved defaults and drafts, no implicit fallback, no reverse browser initialization and continued availability of the ChatGPT-to-BLACKICE connector. The optional rendered retirement journey uses application-owned history fixtures, checks a narrow viewport and records that it performed no external requests or model turns.
