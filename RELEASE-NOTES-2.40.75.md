# BLACKICE 2.40.75

This release completes the browser, conversation-continuity, Directory and local-model integration prepared in 2.40.74, and fixes issues found in its final integration review.

## Integrated changes

- **Optional connector HTTPS port:** [@jweter's PR #24](https://github.com/MoonlightClarity/BLACKICE/pull/24) adds explicit local CLI opt-in to Tailscale Funnel HTTPS **10000**, preserving existing routes, the **443** default and saved **8443** addresses. An enabled HTTPS route must be disabled before switching ports.

- **Connector discovery:** an expected OAuth Bearer challenge with the matching protected-resource metadata can pass the public discovery check. Empty, Basic or mismatched challenges still fail. Discovery success remains separate from authorization and a real tool result.
- **Provider persistence:** unrelated provider/default updates preserve legacy saved local-default representation. Explicit local-model selections and deliberate clears retain their existing meaning across reloads.
- **Model menus:** internal Codex entries such as `gpt-reserve` and `codex-auto-review` are hidden from ordinary advertised choices. Saved selections remain identifiable instead of silently switching models.
- **Browser recovery:** contained input preserves evidence when covered or ambiguous controls prevent dispatch, supports native month inputs, and offers **Close all unused tabs**.
- **Chat and Directory:** bounded tool-result continuity, acknowledgment deduplication after payload eviction, current-user origin across compaction, scoped workspace-check progress, and current valid-choice hints for rejected Directory calls are integrated. Composed compaction coverage checks these interfaces together.
- **Local tools and runtime:** explicit code-artifact tools, streamed compatible-provider reasoning continuity, and the pinned MiniCPM QX4 llama.cpp tool-schema repair are included. The optional local profile preserves existing owner choices.
- **Skills:** browser-navigation, completion and modular-development guidance is included; effective owner edits retain priority. Skill loading/delivery is checked separately from a model's ability to carry out the guidance.
- **Harness instruction delivery:** fresh coordinator and response-only Planning prompts put the current request first while retaining the full authority and context; resumed-session and worker framing are preserved. Effective skill IDs, revisions and exact read routes are supplied, and queryless discovery explains pagination. These changes improve instruction delivery and have regression coverage; they do not establish a model-quality gain.
- **Release qualification tooling:** the tracked availability-retirement helper preserves the authenticated responder's raw state through validation, records a caller-owned stop intent, and reconciles the one stop attempt without replay. Composed tests cover the former normalized-state/wire-state mismatch. Native process admission and retirement proof remain the qualification controller's responsibility; this does not change ordinary app shutdown, the updater or NSIS.
- **Documentation:** the README, configuration and connector guides, browser references, release instructions and documentation index now describe current controls. Earlier Planning/onboarding records are visibly historical. The release workflow is documented as manual-dispatch only.

## Verification boundaries

The release bundle records the exact source commit, application fingerprint, installer filename and SHA-256, source regression results, native Windows observations, effective-skill delivery and installation identity. These observations have different scopes: source tests do not prove native execution, and delivered guidance does not prove model improvement. No real job submissions are part of this release qualification.

## Still in active development

- **ChatGPT connection and hosted schedules ([#25](https://github.com/MoonlightClarity/BLACKICE/issues/25)).** The direct MCP route is implemented, and custom MCP connection creation is available across personal tiers. Qualify each BLACKICE account/endpoint route with matching OAuth and actual tool receipts; discovery alone does not prove execution. Hosted ChatGPT scheduled runs remain unverified. A public listing is a separate possible distribution route and is not shipped or approved.
- **MiniCPM benchmark qualification.** The shared runtime and harness fixes are included. A completed, reproducible benchmark score and a validated comparison of sampler/thinking settings remain pending. The retained benchmark helpers and local receipts are not a portable, qualified public reproducer.
- **Long-running Chat and Directory recovery.** Current-user continuity and rejected-call recovery have specific regression coverage. End-to-end reliability across long tasks and providers still needs validation.

The closed-source context-management proposal and weight-modification ideas remain research outside this release. No finished closed-source context-management system, unattended job-submission rate, or scored model gain is claimed.
