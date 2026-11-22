# BLACKICE 2.40.75

This release completes the browser, conversation-continuity, Directory and local-model integration prepared in 2.40.74, and fixes issues found in its final integration review.

## Integrated changes

- **Connector discovery:** an expected OAuth Bearer challenge with the matching protected-resource metadata can pass the public discovery check. Empty, Basic or mismatched challenges still fail. Discovery success remains separate from authorization and a real tool result.
- **Provider persistence:** unrelated provider/default updates preserve legacy saved local-default representation. Explicit local-model selections and deliberate clears retain their existing meaning across reloads.
- **Model menus:** internal Codex entries such as `gpt-reserve` and `codex-auto-review` are hidden from ordinary advertised choices. Saved selections remain identifiable instead of silently switching models.
- **Browser recovery:** contained input preserves evidence when covered or ambiguous controls prevent dispatch, supports native month inputs, and offers **Close all unused tabs**.
- **Chat and Directory:** bounded tool-result continuity, acknowledgment deduplication after payload eviction, current-user origin across compaction, scoped workspace-check progress, and current valid-choice hints for rejected Directory calls are integrated. Composed compaction coverage checks these interfaces together.
- **Local tools and runtime:** explicit code-artifact tools, streamed compatible-provider reasoning continuity, and the pinned MiniCPM QX4 llama.cpp tool-schema repair are included. The optional local profile preserves existing owner choices.
- **Skills:** browser-navigation, completion and modular-development guidance is included; effective owner edits retain priority. Skill loading/delivery is checked separately from a model's ability to carry out the guidance.
- **Documentation:** the README, configuration and connector guides, browser references, release instructions and documentation index now describe current controls. Earlier Planning/onboarding records are visibly historical. The release workflow is documented as manual-dispatch only.

## Verification boundaries

The release bundle records the exact source commit, application fingerprint, installer filename and SHA-256, source regression results, native Windows observations, effective-skill delivery and installation identity. These observations have different scopes: source tests do not prove native execution, and delivered guidance does not prove model improvement. No real job submissions are part of this release qualification.

## Still in active development

- **MiniCPM benchmark qualification.** The shared runtime and harness fixes are included. A completed, reproducible benchmark score and a validated comparison of sampler/thinking settings remain pending. The retained benchmark helpers and local receipts are not a portable, qualified public reproducer.
- **Long-running Chat and Directory recovery.** Current-user continuity and rejected-call recovery have specific regression coverage. End-to-end reliability across long tasks and providers still needs validation.

The closed-source context-management proposal and weight-modification ideas remain research outside this release. No finished closed-source context-management system, unattended job-submission rate, or scored model gain is claimed.
