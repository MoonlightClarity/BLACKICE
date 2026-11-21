# BLACKICE 2.40.72

This release integrates the completed instruction, skill, ordinary Chat, browser observation, and local benchmark infrastructure changes on top of 2.40.68.

## Instructions, skills, and connector metadata

- Review all 36 existing bundled skills and add Modular Development as the 37th. Task procedures describe observable steps and results while attached tool definitions remain the authority for actual argument names.
- Add the New Skill button and the owner-facing creation endpoint, with revision-aware saving and discoverable saved skills.
- Refresh supported saved native conversation tool catalogs when their schema or description fingerprint changes, preserving conversation context.
- Publish the current 46-tool direct connector catalog, including current file discovery, planning modes, and explicit model-starting capabilities. An external client with cached descriptors must refresh its existing app's tools.
- Distinguish the default working directory from filesystem scope; preserve explicit absolute paths and computer-wide filename discovery.
- Honor null turn limits without implicit fixed no-progress turn caps. Explicit finite limits and actual failure evidence retain their existing behavior.

## Ordinary Chat and browser completion

- Route ordinary Chat through its current entry-point defaults and load applicable operational skills from the actual user task.
- Preserve saved task context for authorized continuation while distinguishing observed completed work, failed attempts, and unresolved waits.
- Improve execution review so concrete failure evidence is not mislabeled as a successful completion or an unsupported human-input requirement.
- Explain filtered browser observations as literal substring matches and supply an unfiltered same-tab recovery call when filtering hides all matches.
- Surface the exact pending file-chooser binding before large observations, including tab, document, URL, and chooser identity. The observation does not dispatch an upload.

## Local benchmark infrastructure

- Validate benchmark profile and workspace boundaries, instruction composition, Directory tool contracts, and saved outcome evidence.
- Preserve optional llama.cpp sampler settings through launch configuration.
- Include reusable benchmark controller code and self-contained synthetic fixtures. Historical machine/profile receipts remain local.
- The earlier MiniCPM context and vision configuration changes are included once through the integrated ancestry.

## Qualification and scope

Publication requires the complete current-source Windows test inventory, unchanged source/fingerprint checks, and the release workflow's exact-installer installation and native runtime validation. The release assets carry the corresponding source and installer evidence.

This integration does not run or claim the seven-task MiniCPM benchmark, tensor activation comparison, or a new live job application. The single-job lane's previously observed application outcome remains a result under its recorded test configuration, not a measured general reliability rate.
