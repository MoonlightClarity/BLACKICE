# Config coherence verification

Config separates General, Behavior & profile, Models, Passwords, Storage & Data, Troubleshooting, and App connections. Models separates accounts, local models, the catalog, and API setup. Operational task limits and access remain collapsed in General. Destructive and security warnings remain where needed.

Response choices belong to Chat, not Config. Chat persists Reasoning, Speed and Answer detail; Answer detail is prompt guidance, not a fixed response length. Choices reach new and continued agent nodes. Config saves omit defaultEffort, defaultServiceTier and verbosity. Existing non-Chat runtime defaults remain unchanged.

Verification for b58aac1: 312 focused Config, Chat, engine, runtime and actual HTTP provider-request tests passed. Request assertions verify explicit Chat default reasoning and standard speed suppress saved global overrides, while answer-detail guidance reaches the prompt. This checks dispatch behavior, not real-model compliance.

The disposable config-response-render.cjs fixture checks absent Config response controls, retained operational settings, Chat detail persistence across navigation and reload, and document bounds at 1200 and 390 pixels. Desktop pixels were inspected. Original tall narrow captures have a gray lower area and are not complete narrow visual evidence; integration uses a shorter viewport. Fixtures do not change the live app or user settings.

Run node --test tests/chat-answer-detail.test.mjs tests/next-settings-*.test.mjs tests/next-chat-*.test.mjs tests/response-defaults-http.test.mjs tests/engine.test.mjs tests/runtime-settings.test.mjs tests/next-context-controls.test.mjs.

Renderer: run tests/config-response-render.cjs using the existing official Electron executable and a new absolute output directory. It uses synthetic stores and a dedicated profile. Full aggregate and installed-app acceptance remain release-integration work.
