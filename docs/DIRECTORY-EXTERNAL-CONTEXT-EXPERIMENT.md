# Directory external context paging — isolated experiment

**Baseline:** BLACKICE 2.40.75, commit 3fc873c8394fb8381456c305cd91068ce9b98eac.
**Branch:** feature/directory-external-context-20261122.
**Scope:** isolated Chat-mode implementation and offline tests; no release, installer change, or automatic migration.

## Behavior

New Action Directory runs attach **relay_context_page**. A successful, large read-only tool result (over 12,000 UTF-8 bytes in an individual text block) is stored under the app data directory in task-external-context/<taskId>/. The model-facing result includes a short preview, the exact reference, returned byte count, and recovery instructions. Directory and the Goal wrapper process the original host result before substitution. Mutating tool results, skill delivery, and noneligible results remain unchanged.

The retrieval tool supports **list**, **read** by byte offset (up to 8 KiB per returned page), and bounded exact **search** (up to 8 MiB scanned per request, returning byte offsets). Saved text is UTF-8; nextOffset points to a valid character boundary. Reopened tasks can retrieve earlier outputs under the same task identity. References cannot read another task's archive.

At new Action Directory startup, the provider sees the bounded **promptView** rather than the complete saved ledger. This includes the objective, all action IDs/objectives/dependencies/states, current and recent work, explicit user-quoted requirements, qualification counts, unknown receipts, and recent host receipts. The complete persisted Directory snapshot remains available using the Directory action read tool.

This implementation is not attached to constrained benchmark profiles or retroactively attached to resumed native tool catalogs lacking relay_context_page. If disk archival fails, BLACKICE retains the original full returned response rather than yielding an unusable reference.

## Controlled comparison

The offline Engine fixture used the same input file and model/runtime mock for Directory Off (baseline) and Directory On (experimental):

| Measurement | Baseline | Experimental | Change |
|---|---:|---:|---:|
| Model-facing tool result | 25,825 UTF-8 bytes | 600 UTF-8 bytes | 97.7% smaller |
| Synthetic Directory startup state | 100,350 UTF-8 bytes | 10,673 UTF-8 bytes | 89.4% smaller |

Tests verified exact reconstruction of the original tool result, tail-marker retrieval without reading the entire result, retention of user-quoted Directory requirements, and preservation of the original Directory host receipt.

**These are controlled payload measurements, not token counts, provider-billed savings, latency gains, or measured improvements in real-task success.**

## Test commands

From the isolated worktree:

    node --test --test-reporter=spec tests/task-external-context*.test.mjs

Directory compatibility tests on Windows PowerShell:

    $files = Get-ChildItem tests -File | Where-Object { $_.Name -match 'directory' -and $_.Name -match '\.test\.mjs$' } | Select-Object -ExpandProperty FullName
    node --test --test-concurrency=4 --test-reporter=dot $files

## Explicit limitations

- This does **not** change native provider compaction, reconstruct a fresh provider thread on demand, or remove already retained provider messages. It reduces the size of new large tool observations and startup Directory material.
- It stores the full **tool text returned to the Engine**. A lower-level command that already truncated output cannot be restored beyond that lower-level cap.
- Action Directory retains its current 24-action and 256-receipt ledger bound. Long-horizon ledger rollover remains future work.
- References currently remain on disk until a later retention/cleanup policy is implemented; this branch is not a disk lifecycle feature.
- The branch does not prove that a closed model will choose the right evidence to retrieve. A realistic same-model, same-budget long-task comparison is necessary before promotion.
- Existing native sessions without the new tool continue with their previous tool catalog.

## Promotion criterion

Compare against unchanged 2.40.75 on task completion, evidence recovery, repeated work, context overflows, total model usage, tool calls, elapsed time, and disk growth. Payload reduction alone does not warrant release. Do not merge or install this branch automatically.
