# Config coherence verification

Config separates General, Behavior & profile, Models, Passwords, Storage & Data, Troubleshooting, and App connections. Models separates accounts, local models, and API setup. Model discovery belongs to the specific connection being configured. Operational task limits and access remain collapsed in General. Destructive and security warnings remain where needed.

Response choices belong to Chat, not Config. Chat keeps model, reasoning and speed choices. Answer detail has been removed; describe the desired depth directly in the request. New and continued replies do not receive a hidden detail default. Config saves omit Chat response controls.

The loopback provider test checks that retired detail from a historical profile and a reopened Chat does not appear in real provider HTTP requests. Explicit Chat reasoning and standard speed remain independent. This checks dispatch behavior, not real-model compliance.

The disposable config-response-render.cjs fixture checks absent Config response controls, retained operational settings, absence of the retired Chat detail control across navigation and reload, and document bounds at 1200 and 390 pixels. Fixtures do not change the live app or user settings.

Run node --test tests/chat-answer-detail.test.mjs tests/next-settings-*.test.mjs tests/next-chat-*.test.mjs tests/response-defaults-http.test.mjs tests/engine.test.mjs tests/runtime-settings.test.mjs tests/next-context-controls.test.mjs.

Renderer: run tests/config-response-render.cjs using the existing official Electron executable and a new absolute output directory. It uses synthetic stores and a dedicated profile. Full aggregate and installed-app acceptance remain release-integration work.
