# BLACKICE 2.38.0 — Provider, planning, and Activity checkpoint

This release brings the provider configuration, planning workflow, saved conversation, and Activity changes since 2.37.0 into one Windows release.

## Release verification

The release page and attached evidence identify the exact source commit, full Windows source-test result, installer checksum, and fresh installer verification. Publication requires a passing receipt for the complete tested source inventory, a matching application fingerprint, and successful verification of the actual Setup executable on a fresh Windows runner. The release workflow checks the real tag target and re-downloads the primary release assets before publication to confirm their bytes still match those verified. Earlier release receipts do not substitute for these checks.

## Free model providers and saved conversations

Provider configuration includes keyless Kilo Free and Pollinations Classic presets, OpenAI-compatible endpoints, and saved model catalogs. Anonymous catalogs can be discovered and selected models saved without inventing an API key requirement. Saved providers and selected models survive reopening Settings and restarting BLACKICE. Provider readiness is determined from the saved application configuration and actual request results.

Each conversation retains its concrete model and provider independently of the default for new chats. Historical model evidence comes from the saved run and thread records; changing today's default must not relabel an earlier conversation. A pending model override belongs to its conversation. An unavailable model remains visible so a replacement is an explicit choice. If the saved evidence cannot establish a historical model, BLACKICE requires an explicit selection instead of substituting today's default.

The provider transport retains reported, partial, and unknown token usage distinctly. Bounded retries cover selected transient HTTP failures, and usage from an accepted failed stream is counted without silently replaying completed tools. Provider catalogs and model capabilities can change independently of BLACKICE; being listed as free does not establish anonymous access, tool support, or unlimited capacity.

## Planning and truthful completion

The Planning workspace presents editable requests and response cycles with feasibility, inference, concrete planning, execution, reassessment, and final response. Plans retain nested chronological substeps and Boolean branches. Feasibility checks distinguish missing evidence from evidence already covered by captured sources, allowing available work to proceed while genuine blockers remain explicit.

Completion reporting must preserve the distinction between a finished response, a held request, and a failed planning cycle. Completed planning attempts are included in live run token totals before settlement, using their recorded usage. Recovering a final response must update the original saved conversation and archive as well as the planning graph, without repeating completed external actions.

Planning response-only calls honor the configured output budget while preserving an explicit reserve; ordinary Chat output-reserve behavior is unchanged. A response whose coverage does not support its own answer can use the existing bounded format repair. Successful recovery clears stale cycle errors and updates the original conversation and archive without replaying completed operations.

Published schema 9 and 10 coordinator tools, worker tools, and instructions retain their exact historical definitions. The installed schema 11 and current schema 12 definitions remain compatible. Prior observations, attempts, and completed work are preserved.

## Observed installed acceptance

These checks used the existing Windows installation and profile after the selected stabilization runtime files were matched to source by hash. The host retained 2.37.0 package metadata. Verification of the fresh 2.38.0 Setup installation is a separate release-runner gate.

An existing Nemotron conversation continued successfully with the checked result 437 while the default for new chats was Laguna. Its displayed and executed model remained Nemotron. Conversation switching, reload, per-chat pending selections, unavailable models, and missing historical evidence also have dedicated source coverage.

A fresh free Nemotron planning task completed the inventory calculation 17 + 49 + 3 = 69. It used four successful local tool calls, no failed tools, one root response cycle, and six planning attempts. One failed Respond attempt was followed by a successful automatic format repair; no manual retry was needed. The verified output file, original conversation, and archive agreed. Recorded usage reconciled to 476,546 tokens across eleven samples: 231,914 planning tokens and 244,632 operational tokens.

A free Nemotron planning run recovered to the checked result 190 and published it into the original saved conversation and archive. Usage accounting included all seven recorded analytical attempts, and the three completed operational receipts were preserved without replay. These observations are bounded acceptance cases; they do not establish factual correctness for every model or unrestricted workflow reliability.

## Activity and continuity

Activity brings model runs and direct tool actions into one searchable view. It supports live status, filtering, selected evidence, navigation to the relevant workspace, keyboard use, and narrow layouts. Evidence labels distinguish raw results from summaries and preserve uncertainty when an operation did not establish success.

Saved history and context handling include Windows persistence and final-review context-size corrections. Drafts, tabs, existing provider entries, and recorded completed work remain part of the existing profile.

## Windows packaging

The release uses the established per-user `Blackice-2.38.0-Setup.exe` installer and existing profile identity. Installer inputs, source fingerprints, and installed-file verification agree on packaged runtime helpers. Local recovery copies are excluded without deleting them from the development workspace.

Signing remains optional. An unsigned installer is identified as unsigned and does not assert a verified publisher. The source and release assets exclude private profiles, conversations, API transcripts, and machine-specific recovery evidence.
