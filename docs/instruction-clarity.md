# BLACKICE instruction clarity and runtime alignment

This change updates BLACKICE 2.40.70 source at `28f8e0f51be0bc55e73eb9afab1bc1ebeea765e8` to candidate **2.40.71**. It addresses ambiguous instructions, descriptions copied from retired APIs, missing modular development, hidden turn limits, and confusion between the working directory and file-search scope.

## What changed

All 36 existing bundled skills were reviewed and rewritten. Modular Development is now the 37th bundled skill. Fifteen existing skills grew to supply missing steps or results; 21 became shorter. Length follows the explanation needed to perform the work.

| Surface | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Existing 36 skill bodies | 123,393 characters | 63,477 characters | 48.56% less text |
| New Modular Development | — | 3,569 characters | 559 words |
| All 37 current skill bodies | — | 67,046 characters | Includes the new skill |
| Five visual guidance files | 47,093 characters | 29,641 characters | 37.06% less text |
| Live 46-tool direct catalog descriptions | 23,567 characters | 20,777 characters | Some expanded for necessary fields and recovery |
| 65 measured native text blocks | 34,645 characters | 28,552 characters | Includes longer file-scope explanations |
| Saved common instruction default | 2,527 characters | 1,956 characters | Explicit schema authority and file scope |

These scopes overlap where adapters share a source. Their totals must not be added together.

Skills explain when to use them, what to inspect or change, and what result to check. The current attached tool definition determines action and field names. Copied tool-call schemas were removed from task procedures. Universal aesthetic mandates, repetitive policy paragraphs, and invented completion prerequisites were removed. Visual guidance now follows the user's brief and describes visible rendering defects and actual format limits.

[Modular Development](../lib/skill-library/modular-development.md) uses one coherent behavior at a time, a small behavior/files/check/status record when useful, saved implementation, an actual project check, repair of observed failures, and an integration check. A module can be a function in an existing file; new folders and wrappers are not mandatory.

## Reproduced defects and fixes

| Observed defect | Changed behavior | Verification |
| --- | --- | --- |
| A resumed native provider thread retained old tool definitions while receiving new instructions. | A canonical fingerprint includes descriptions, schemas, and current catalog variants. Supported saved native conversations use the existing context-preserving handoff when their original fingerprint is missing or differs. An unchanged catalog retains its thread. | Real engine fixtures cover Continue, Retry, description changes, schema changes, missing fingerprints, stable property ordering, task identity and saved context. Initial new regression: 1 passed, 3 failed; fixed cases pass. |
| Direct validation rejected the JSON Schema type arrays it advertised, including `maxTurns:null`. | The validator checks the permitted type alternatives. Valid null values reach actual handlers; invalid values still fail validation. | DirectExecutionAPI admission and handler tests, including Goal persistence and start-chat inputs. |
| Goals stopped after three or seven turns without verified progress even with `maxTurns:null`. | No-progress and repeated-operation observations remain recorded; those fixed turn-count stops are removed. Omitted limits default to null, and updating with null removes an existing finite cap. | A real-engine fixture remains active through seven unverified turns into turn eight. Explicit finite limits, observed waits, cancellation and completion remain covered. Actual execution-failure recovery is unchanged. |
| New-plan help advertised retired creation/edit recipes, and legacy help recommended an operation its handler rejected. | No-state help returns current `create_contract`; a current saved task returns `replace_contract`; a selected legacy task returns its actual legacy editing protocol. | Actual creation, read and replacement calls follow the returned help; saved legacy records remain editable. |
| Project fallback messages sent callers to retired task-method actions and nonexistent paging. | Recovery uses the project's supported `methods` / `get_method` interface and reports actual response limits. | Compact and oversized catalogs, oversized methods, and unsupported outline inputs exercise the real returned messages. |
| Browser and visual recovery text assumed adapter-specific tool names or helpers. | Recovery uses the attached operation and actual argument mappings. Visual feedback describes the image formats returned to that caller. | Native/direct browser recovery, live catalog reference checks, visual rendering and returned feedback tests. |
| Status claimed no model workers existed even when model-starting tools were registered. | Capabilities list the registered model-starting tools and derive modelWorkers from that list. The status call still correctly reports that it started no model or provider turn. | Real factory configurations and the public status route verify the capability list without executing a model handler or creating a job. |
| Guidance mentioned revision/ownership fields absent from a partial attached schema. | Guidance checks every field it names. Current ownership values map to `expectedOwnerKey`, `expectedUrl` and `expectedDocumentId`. | Partial-schema matrices remove each named argument; no absent-field recipe is returned. |

The native fingerprint refresh covers supported saved catalogs. Older incompatible task/catalog versions retain their existing explicit compatibility behavior. A native refresh does not rewrite historical execution captures or replay a completed external action.

## File discovery

The working directory supplies the default for relative paths and command execution. It is not a filesystem boundary.

A supplied absolute path is read directly, including outside the working directory. When the location is unknown, filename discovery can use relevant explicit roots or the tool's existing computer-wide default. Content search within one folder describes only that folder. An empty attachment catalog says nothing about whether a local file exists.

Pagination now follows the returned cursor while one exists. At the end, the model checks coverage, errors and skipped paths. `scanComplete:true` can coexist with `searchComplete:false` when traversal finished with gaps; this is not an instruction to keep requesting a nonexistent cursor.

Actual handlers and an engine-delivered native tool call were tested with outside-directory inputs, a complete narrow miss, broader discovery, and a finished traversal containing a missing-root error.

## Tools and the host

[Tool responsibilities](tool-responsibilities.md) maps the current capabilities to the choices the model needs to make.

The everyday interfaces are file discovery/read/write, commands, browser actions, attachments and relevant saved records. Communication, visual work, native applications and workers are task-specific capabilities. Provider setup, prompt/workflow administration, profile import and frontend debugging are specialized management surfaces.

Catalog selection and freshness, path resolution, traversal, durable job identity, receipts, revision checks and defaults belong in host code. This change implements catalog freshness and removes model-facing explanations of internal traversal bookkeeping. It does not claim that all administrative tools have already been hidden. The responsibility note labels optional-exposure recommendations separately from shipped behavior.

## Verification

The final integrated command was `node --test --test-concurrency=4` with the saved [79-file selection](../verification/instruction-clarity-test-selection.json).

**653 tests passed; zero failures, skips, cancellations or TODOs.** See the [result](../verification/instruction-clarity-integrated.json) and [TAP log](../verification/instruction-clarity-integrated.tap). This is an affected-scope integration run, not a claim that the entire repository suite ran.

The native metadata comparison checked 36 instances / 35 unique tool names. The live direct comparison checked all 46 tools. Input schemas and authorization scopes match the base when descriptive strings are excluded. A separate 54-definition direct/compatibility comparison overlaps the live catalog.

Historical catalog fingerprints now use immutable historical fixtures. Current tests check actual current shapes, delivered guidance and handlers rather than forcing production text to match old prose.

No live model/provider benchmark was run or claimed.

## Activation

The seven substantive saved skill overrides were updated through the owner editor; the unrelated custom test skill was preserved. Common instructions were also updated through the owner editor. The saved common text and all seven overrides were read back and match the intended source; the custom test skill remains unchanged.

BLACKICE **2.40.71 is installed and running**. The installer exited successfully; the installed application, packaged candidate, and source share fingerprint `5428c23b8786aa1523f2068370c150150eb6d544fb1f127a13de0688da3c47e9`. The same connection grant returned, and the live 46-tool catalog matches the candidate. The Skills UI lists 37 bundled skills plus the preserved custom test skill, and the displayed Modular Development body matches installed source. See [the activation receipt](../verification/instruction-clarity-activation.json).

The first installation attempt stopped before launching the installer because its process check counted the persistent connection helper as the main app. The completed attempt used native quit, the existing per-profile helper stop interface, and the verified NSIS installer. No application source change was needed for this correction.

The current external ChatGPT conversation still exposes cached older connector metadata: its workspace reader lacks current discovery fields, start-chat advertises retired Planning values, and a retired planning-cycle tool remains attached. The updated live server and native catalog are verified. BLACKICE cannot replace descriptors already cached by its external client; no supported client-refresh control was exposed in this session.
