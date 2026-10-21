# BLACKICE 2.31.0

## ChatGPT Chat Mode

Experimental Chat Mode now has a production response adapter grounded in the public ChatGPT WebMCP and rendered-message contract inspected on October 20, 2026. It combines observed message metadata with scoped text from the exact conversation and checks the transcript again before accepting a completed answer. Reasoning summaries, controls and hidden content are excluded; code indentation and line breaks are preserved.

Owned conversations support text follow-ups when the exact conversation, model, reasoning preference and transcript fingerprint match. New tasks start fresh conversations. Stop targets the owned operation once and waits for settlement. Unknown outcomes remain durable and block automatic replay. The **I reviewed the last response** recovery action acknowledges one exact pending attempt without resending it.

The dedicated contained ChatGPT tab now has a purpose marker and one reserved slot alongside the eight ordinary browser tabs. Setup never adopts another tab by URL. The route remains text-only, with no BLACKICE attached tools, images, steering or compaction.

The inspected contained profile was signed out. A guest diagnostic did not produce an answer, and no subscription-backed production completion is claimed. Source review, controlled runtime tests and native Chromium transcript checks are distinct from a successful authenticated turn. See [CHAT-MODE.md](CHAT-MODE.md) for the exact contract and evidence.

## Himalaya email

- Folder discovery returns provider mailbox IDs and display names separately. Choosing a folder sends its exact ID, including when labels are duplicated.
- Raw message reads now also return decoded headers, plain text, MIME attachment descriptions, bounded warnings and truncation information. The original RFC 5322 source remains available.
- The reader displays plain text, escapes message content and never loads message HTML or remote images. Attachment descriptions do not download attachments.
- **Reply as local draft** fills the observed reply address, subject and quoted text. It protects an existing composer; **New draft** is the deliberate replacement action. Save remains explicit and local.
- Parser handling covers MIME alternatives and related roots, encoded headers, quoted-printable and base64 bodies, charsets and extended filenames. Limits bound message text, parts, nesting and attachment descriptions.
- The installed Himalaya 2.2.1 interface is exercised with a disposable local Maildir. No user mailbox or external delivery is part of that proof.

Email still supports read-only mailbox operations and durable local drafts. Sending, moving/deleting mail and uploading drafts are outside this release's email contract. Existing browser OAuth and external TOML setup remain available. See [EMAIL.md](EMAIL.md).

## Typed knowledge

Knowledge records now support Note, Fact, Assumption and Decision types, source references and directed supports/contradicts/informs/supersedes links. The UI adds type filtering, source and link editors, readable summaries and full revision undo.

Validation is atomic with the saved revision. Links may target knowledge in the same working folder or global scope. Self-links, duplicate links, missing new targets and scope moves that break incoming links are rejected. Deleting a target preserves historical references. Existing notes remain readable and older clients preserve metadata they do not edit.

## Integration and verification

The new email reader and Chat Mode transcript module are included in static serving, packaging, installed-file checks and application fingerprinting. Native UI acceptance covers readable mail, unsent reply drafts, knowledge links and the production transcript reader, alongside the existing Planning, browser, remote-access and OAuth journeys.

This is a local runtime update. Existing public installer archives are not rebuilt by it. The accompanying completion handoff records the actual regression counts, native acceptance outcomes, installed fingerprint and backup location.
