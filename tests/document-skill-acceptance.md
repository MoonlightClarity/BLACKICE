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


## Small paired handoff benchmark

Start here for a quick old-versus-new capability check. Use three preselected seeds (for example, holdout-a, holdout-b, holdout-c) and run both the nested-file case and its matched inline control under both catalogs: 12 independent turns total. The file prompt asks for a PDF dispatch code, a DOCX ticket code, and both values of one stated discrepancy. The PDF and DOCX contain synthetic, seed-derived values, not facts from an actual user. The inline prompt poses exactly the same comparison with the complete source text provided and needs neither file calls nor a skill. The fixture can be created with the exported writeHandoffFixture(directory, seed) in tests/fixtures/synthetic-handoff.mjs; it returns both prompts, exact file paths and expected values. Keep its return object outside the model workspace and pass only the selected prompt, never the answer key or target paths. Use a separate empty workspace for the inline case.

- **Control the difference.** First replay the old and new skill catalog contents against the same receiver and app revision, not two app releases with different find/read tools. Where the historical cutoff was the three original bundled skills, test the current code in two disposable copies with the skill library manifest entries empty for old and unchanged for new. The original three remain available in both. For other old releases, record the exact catalog fixture and verify both search/read bodies; if paired branches change file tools as well, label the result a whole-build comparison, not a skills effect. Do not load, suggest, or reward a specific skill in the prompt.
- **Match the receiver.** Use the same GGUF file and SHA-256, local runtime/version, backend, tool-call template, context and output limits, seed/sampling settings where available, system instruction, and dynamically offered tool schemas. Run in counterbalanced order (old/new then new/old). Start a fresh local chat and isolated data directory for every case; do not reuse sessions or model messages. Keep root equality between arms where practical and fixture-relative observations otherwise. Use a test receiver exposing only file discovery, workspace read, and skill search/read over synthetic data; if a matched attachment-list precheck is offered, return empty. Disable external providers, connectors, browser and shell execution rather than trusting a prose instruction. Record unexpected tool attempts as overhead and failures where relevant.
- **Record before judging.** Normalize ordered tool events to tests/fixtures/document-skill-acceptance.mjs with op, success, matches for files.find, target and returned text for workspace.read, and id and returned text for skills.read. Supply the engine's settled skillLoadReceipts separately: a successful read or metadata hit alone is not delivery. Use the final response body, not a rendered claim of what was read. Report first attempted action after one optional attachment check, first useful evidence tool, both correct and grounded answer counts, delivered relevant skill counts, extra calls and shell attempts. Report errors and denominators; do not turn a startup or provider failure into a missing-skill inference. Provider delay and tool delay, if available, are separate.
- **Interpretation.** Prefer more correct, grounded file answers or a shorter path to evidence at matched quality. Skill delivery is diagnostic, not success; a correct grounded no-skill result can beat a slower skill-loaded result. Inline should have no tool calls, including skill body reads. Test repetitions can uncover regressions but three seeds are not a statistical estimate.

The deterministic fixture command below exercises real find, PDF, DOCX, skill search/read and engine receipt plumbing with a scripted receiver. It shows the expected evidence shapes and no-skill versus skill-use overhead; it cannot measure whether a real model chose correctly.

    node --test --test-concurrency=1 tests/chat-handoff-ab.test.mjs tests/document-skill-acceptance.test.mjs tests/chat-document-read.acceptance.mjs

For a genuine local inference run, provide one already-authorized tool-capable GGUF and start the verified llama-server on loopback for a disposable profile and model directory. The CPU and Vulkan executables are runtime binaries, not model weights. Detect a working chat template and tool round-trip first; provider catalog visibility alone does not establish that tool calls work. If there is no approved and compatible weight or no working tool exchange, report the benchmark as not run. Do not fall back to a paid or external provider.
