# Document and skill acceptance

Use a fresh working directory and synthetic data. Do not use the installed profile, user documents, external browser, live connectors, or a paid provider.

## Deterministic checks (no model)

```powershell
node --test tests/document-skill-acceptance.test.mjs
node --test tests/chat-document-read.acceptance.mjs
node --test tests/goal-file-discovery-engine.test.mjs
```

The Chat acceptance probe intentionally fails before direct local PDF support. It invokes the real agent tools through HarnessEngine, with a scripted provider. The nested PDF and DOCX each contain a random marker not in the task: find the filename, then read that exact match. The first read must return the marker in two operations total, the assistant must return it, and no shell call or extraction artifact is needed. The script prescribes order; passing does not demonstrate model tool selection. The Goal harness separately tests real search pagination across an automatic successor; it does not test PDF reading in Goal mode. Separate reader tests cover attachments, continuation, corrupt files and image-only PDFs.

For catalog candidates, seed test-only catalogs with 25, 100 and 250 items. Include one relevant skill, one near-match, and shuffled unrelated entries. Query with task language instead of the exact skill name. Assert the relevant ID is in the bounded metadata-only result, requesting that ID returns its unique body marker, and no unrelated body is loaded or injected. Include unrelated search and nonexistent ID cases. Validate tool registration and loaded text separately from relevance. Skills are advisory; don't reward unnecessary skill loads.

## Model check (only after local provider is authorized and available)

Compare baseline and candidate on the same local model, context settings and fixture seeds. Disable external actions and use fresh isolated profiles. Run three task paraphrases in Chat and Goal for local documents, and three skill tasks at 25 and 250 entries with different ordering. Add a negative task whose work needs no skill.

Normalize ordered settled tool evidence into the scorer's events. Preserve operation, success, returned synthetic IDs/paths, output marker presence, and phase timing. Record first meaningful tool (one attachment-list precheck is fine), operations through successful read, shell attempts, terminal status, and which skill body was read. Do not award points for a narrative claiming an unobserved action. Keep provider latency and tool duration separate.

Initial smoke acceptance: at least 5/6 in each positive group, no shell extraction, no terminal extraction promise for readable files, and no body load on the negative control. These small counts are a release smoke signal, not a statistical estimate of reliability. Use identical scoring on baseline and candidate and report actual denominators, even when cases abort.
