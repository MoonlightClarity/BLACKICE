# BLACKICE: three subscription-backed agent runtimes

**Product direction — October 31, 2026:** Agentic compatibility and low friction matter more than model catalogs. BLACKICE is a personal autonomous agent workspace, not an enterprise API aggregator.

## Supported runtimes

| Runtime | Subscription entitlement | Current result |
| --- | --- | --- |
| **Codex** | Official Codex CLI using a ChatGPT subscription | Stable default; native login and runtime connected |
| **Antigravity** | Official Antigravity CLI using its signed-in Google account | Live streaming, native file read and file write/read verified; wider compatibility pending |
| **Qwen Code** | QwenCloud monthly Token Plan or Alibaba Coding Plan | CLI installed and integrated; a subscription-plan credential is still required for a live model test |

The three names above identify **providers/runtimes, not models**. Antigravity and Qwen Code can each offer multiple selectable models under one connected subscription. In **Settings → Models**, refresh Antigravity to read the exact IDs advertised by the official `agy models` command. Qwen Code accepts a native `--model` ID and may expose saved IDs in its local subscription settings; the user can also enter an exact model ID when no listing API is available. A saved ID never implies entitlement until a model call succeeds. The new-conversation model picker lists each saved model under its actual provider.

Every saved native thread records **providerId and exact model ID**. Changing the default model later must never silently relabel or switch past chats. The historical `antigravity::default` and `qwen_code::default` routes remain compatible aliases for the CLI's provider-selected model, not evidence that a subscription is a model. Native login and package model catalogs are separate. Do not automatically switch from a subscription to a metered API or local inference server when quotas run out.

Saved API-provider configurations and historical conversations are retained but disabled and hidden from ordinary model choices. They remain accessible for compatibility in an advanced legacy section.

## Integration principles

1. Use official installed CLI executables and their account entitlements. Desktop app installations alone do not establish CLI readiness.
2. BLACKICE keeps conversation identity, planning, run history, orchestration and the working directory; native CLIs execute the actual inference turns. Persist the native session identifier to resume a saved conversation without silent provider switching.
3. Use the native file-edit-accepting or auto-edit mode for authorized normal tasks, and a non-editing plan mode for analytical response-only tasks. Do not silently enable broad unrestricted permissions. Pass long BLACKICE prompts through the official CLI stdin protocol, never as command-line arguments on Windows (which otherwise fail with ENAMETOOLONG).
4. Native model subscription quotas and resets belong to the provider. No unauthorized paid API fallback.
5. A successful process exit, key test or advertised catalog alone does not establish tool execution. Test real native tool events and independently inspect completed effects.
6. Prefer a stable small set of providers over supporting every changing model ID.

## Qwen Code entitlement

Qwen's free OAuth stopped on April 15, 2026. Fixed-cost routes include the Alibaba **Coding Plan** (dedicated coding.dashscope.aliyuncs.com or coding-intl.dashscope.aliyuncs.com endpoint) and QwenCloud monthly **Token Plan** (dedicated token-plan.maas.qianwenaiapi.com endpoint). Qwen Code manages its own plan key in its official settings. A regular pay-as-you-go API key or a separate Qwen Desktop login is not enough. BLACKICE shows Qwen Code as *installed but not configured* until a recognized plan is present.

## Remaining parity gate

Official CLIs can invoke their own filesystem tools; that is not yet the same as an official **BLACKICE dynamic-tool/MCP/ACP bridge**. Before advertising complete two-way parity, verify both native tool execution and delegated BLACKICE browser, file, planning, and other tool actions, with real receipts and account-level authorization. These checks are separate from a working inference response.
