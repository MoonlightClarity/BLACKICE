# Planning and Directory audit — 2026-11-12

> **Status: Historical documentation.** This preserved release-era design, evaluation, or migration record is **not current usage guidance or deployment evidence**. Do not infer present defaults, tool contracts, or installation state from it. See [current documentation](docs/README.md) and [source release notes](RELEASE-NOTES.md).

> **Superseded default (2.39.81 source):** New Chat module selections and Directory now default Off when unspecified; eight modules are user-selectable and delegation is a separate tool capability. The On-by-default and nine-module statements below describe the audited November 12 state only. See [current Planning controls](docs/MODULAR-PLANNING-ONTOLOGY.md).

## Explicit On/Off contract

Planning module policy version 2 stores Boolean values. Each of the nine modules has only On/Off controls. Directory also has only On/Off controls. New Chat drafts default to enabled modules and Directory On. Generic non-Chat workflows retain explicit admission rather than silently enabling Directory for unsupported shared graphs.

Legacy Mandatory, Optional and Auto module selections migrate to true; Forbidden migrates to false. Compatibility parsing is not a new policy state. Historical run records are not rewritten. New policies contain neither autoSelect nor four-state module values.

## Runtime corrections

Modular outcome assessment is connected to ordinary and Directory completion. An unfinished candidate can continue within the same execution rather than being accepted as completed or converted into a Directory error. Reporting-only corrections do not replay operational work. Dependency results survive context resets.

Completion assessment consumes full persisted dispatcher receipts, not UI excerpts. Directory synthesis receives source-linked actual tool evidence. Concurrent audit updates serialize the complete read/modify/write transaction and use unique temporary paths. A failed audit persistence operation does not falsely turn a successful external operation into a failed tool result.

Default cumulative model-call, planning-call and context-page quotas are removed. Fixed 9,000-character inference, 24,000-character synthesis and 64,000-character authority cutoffs are removed. Actual provider context capacity still applies. Explicit caller-supplied limits and structural plan bounds remain supported. No-progress handling is based on unchanged evidence rather than productive-turn counts.

Fresh source/context extraction remains isolated and cannot re-execute task operations. Attributed prior data is saved without a lossy summary model pass. The Context inspector exposes saved evidence and labels selected-run versus whole-conversation counters separately.

## Verification

The relevant regression selection passed 157 tests, skipped one and failed none. It includes the 23 focused tests for continuation, dependency handoff, Boolean policy migration, receipt preservation, report-only correction, and concurrent audit writes. Tests are in the repository's actual tests/*.test.mjs discovery path.

A live GPT-6 Luna local fixture ran with all nine module Booleans true and Directory On. Independent validation confirmed two completed records, one allowed missing-source disposition, an untouched disabled record and exact total 125. All five input/validator hashes stayed unchanged. The final conversation audit contained 42 unique indexed turns; its summary reported the same 42. The targeted repair used three Directory model phases plus a completion assessment. Full completion receipts remained available through the Context API and inspector.

## Important qualification

This was not an unassisted first-pass success: independent validation found BOM-prefixed output JSON after the initial live run. A targeted continuation in the same conversation repaired output encoding and executed the original unchanged validator successfully. The source tests were not edited to accept invalid output. The final result therefore demonstrates working execution, evidence handoff and targeted recovery, not perfect model judgment.

No real employer application was submitted in this acceptance test. These results do not establish real-world job-search throughput or universal completion accuracy. The current desktop installation was patched directly; this change does not include a newly packaged installer.
