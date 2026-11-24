# BLACKICE 2.40.82 — skill retrieval accuracy

This release improves BLACKICE's ability to discover applicable skills from
natural task descriptions even when the wording differs from skill titles.

## Changes

- Build a local SQLite FTS5 index of the effective, revisioned skill metadata.
  The index is disposable and in-memory; Markdown skill bodies and revisioned
  user edits remain the authoritative source. Search never reads packaged
  library bodies just to build the index.
- Combine keyword ranking with conservative, locally computed semantic concept
  vectors. Recognize common paraphrases such as "website interaction recovery"
  as the Browser Navigation and Continuity method.
- Preserve strong distinctive keyword matches ahead of generic conceptual
  matches, suppress unrelated matches, and rank title/domain evidence above
  incidental prose.
- Apply the same semantic matching to task-time discovery of owner-created
  skills, without turning diagnostics or skill reviews into operational work.
- Rebuild the search index when effective skill revisions change; retain
  revision, deletion, source, pagination and owner-edit behavior.
- No cloud calls, downloaded model, new installation dependencies, or new
  user-approval gates. Native SQLite FTS5 failure falls back to metadata and
  semantic ranking.

## Verification

Added a reproducible paraphrase-retrieval fixture (12 positive tasks and five
unrelated queries) plus revision and automatic-discovery regression cases.
Retained the 1,200-skill packaged-library pagination and contamination tests.
The fixture is a targeted accuracy check, not a general semantic benchmark.

Local installer, Windows source qualification, and installed-runtime checks
must be evaluated separately before claiming installation success.
