# BLACKICE 2.39.1

This release packages the native Workbench, direct VM tools, chat repairs, provider updates, and operational Planning changes into a new Windows installer.

## Windows administrator launch repair

The Windows executable now requests `highestAvailable` rights. A manifest-only comparison on the Windows release runner reproduced GPU-child startup failure with `requireAdministrator`, then passed the original hidden-runtime checks with `highestAvailable`. The primary and restarted BLACKICE processes remained elevated, while restricted Chromium children ran without administrator rights. GPU and sandbox flags, working directory and ACLs were unchanged.

This preserves administrator availability on the tested host while repairing the observed launch failure. It does not establish compatibility with every Windows account, UAC configuration or visible desktop. Workbench still checks actual administrator tokens and Hyper-V access; guest permissions remain separate. The new 2.39.1 installer must be built and verified from its own source and embedded manifest. Earlier 2.39.0 artifacts and receipts do not verify this installer.

## Native Workbench

Workbench opens Windows in a separate native application with a blue BLACKICE icon. Its toolbar owns display wake, VM start and graceful shutdown, control handoff, fit, and clipboard settings. Text clipboard sharing follows the selected setting while the user controls and focuses the VM. The Workbench page in BLACKICE provides the launcher and setup controls.

BLACKICE agents can inspect and operate the existing VM through their exposed tools, retain native visual observations, verify guest effects, and return control. Ownership, revisions, output completeness, and durable execution identities prevent an uncertain transport result from authorizing a blind replay.

App Sync reports missing guest pairing or installation capability before host diagnostics. Paired batches revalidate current host and guest state before installation work is reserved or dispatched.

The native display remains a local-preview feature. Its exact accepted helper and runtime have decoded-motion/input, buffered self-test, hidden-session lifecycle, and toolbar evidence. Those observations do not establish physical input-to-photon performance or universal host compatibility. The installer must include and verify the native runtime and its dependency notices; a developer checkout is not required.

## Planning serves the user benefit

Planning follows **Infer → Feasibility → Plan → Think → Respond**. Inference separates the real user benefit from tasks and steps, uses the full session to identify wanted and unwanted outcomes, and preserves explicit constraints and authority. Feasibility checks actual resources and distinguishes confirmed blockers, repairable gaps, unknowns that need a cheap check, and apparent blockers that do not prevent progress.

The real benefit continues through planning, execution, and final review. BLACKICE should complete authorized routine work without unnecessary handoffs. Successful model responses, valid Planning calls, and verified task outcomes are recorded separately. Final review receives complete linked guest observations and retained native images, preserves material omissions, and checks the adopted requirements without adding optional bookkeeping as a new success condition.

Ordinary Planning and deployment checks discover the VM tools without waiting on an unrelated cold Hyper-V or SMB probe. Explicit VM tasks collect actual guest and viewer status before dependent work.

Two live tasks used BLACKICE's own VM tools: Firefox with advertising disabled and genuine uBlock Origin blocking verified, and a new 7-Zip installation with nested, spaced, Unicode, and binary fixtures archived and extracted with matching names, bytes, and hashes. These task observations remain separate from the fresh-installer verification attached to this release.

## Chat, providers, and model selection

Chat fixes cover duplicate response delivery, saved-history isolation, and scrolling. Provider configuration and per-chat model selection retain the existing provider work. The model picker presents model names and providers, with search and grouping; unsupported free-only, tools, vision, and context-window controls are removed.

## Windows installer verification

The release workflow binds the version and complete Windows source-test receipt to an exact source commit, builds the Setup executable, verifies its installed contents on a fresh Windows runner, and checks the actual tag and downloaded asset checksums before publication. Release assets identify the precise installer and verification evidence. Signing status is recorded accurately; an unsigned installer does not claim a verified publisher identity. Existing profiles and VM data are preserved by the established installer.

The same release provides `Blackice-2.39.1-Native-Sources.tar`, its source index, and checksums. The archive contains matching MSYS2 source packages, upstream sources, build recipes and patches for the shipped native dependencies, the native helper's build inputs, and checksum-verified registry sources from the original Rust lockfiles. Recipe supplements are labelled separately from observed lockfiles. The release verifies the actual archive contents and re-downloads these assets before publication.
