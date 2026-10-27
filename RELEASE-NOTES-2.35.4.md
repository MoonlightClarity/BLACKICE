# BLACKICE 2.35.4 — Practical Planning and recurring-work continuity

This candidate packages the completed Planning and schedule improvements built after the earlier 2.35.3 source tag. The 2.35.3 tag is retained unchanged; 2.35.4 is the distinct release candidate.

## Planning and analytical judgment

- Planning is **On** or **Off**. On requires a durable, current-turn plan before operational tools or a final response; Off removes that automatic requirement while preserving historical notes, safety checks, and optional tools. Historical Auto and Maximal selections map to On. Planning depth and model reasoning effort remain independent.
- General-purpose metacognition puts the useful outcome ahead of proxy perfection. Saved plans can distinguish established hard gates, material barriers, adaptable gaps, externally stated requirements, preferences, and unverified facts, with source and evidence status.
- Optional judgment fields capture a consequential uncertainty, the next discriminating check, what constitutes enough evidence, reassessment conditions, observations, and transferable lessons. They do not themselves authorize work or certify a claim.
- Historical native conversation and Planning tool schemas remain compatible, including retry, context continuation, and existing work records.

## Scheduled work and continuity

- A recurring, non-parallel, single-agent cron or interval task can continue the previous saved conversation and Planning task instead of creating an unrelated conversation every occurrence. Other workflow shapes preserve their existing execution semantics.
- The Schedules workspace adds inspection and revision-checked editing. Saved results appear in a local Results inbox, independently of the job's execution state and a person's acknowledgement.
- Optional HTTP(S) webhook delivery records attempts and uncertain outcomes instead of claiming successful delivery from a queued job. Delivery is not automatically pushed into ChatGPT, and publishing external results remains an explicit choice.
- Scheduled-job changes do not retroactively mutate active jobs or rewrite their prior receipts.

## Release boundaries

- The complete current source test suite passed before versioning: 4,930 passed, zero failed, and eight optional integration cases skipped. This is historical pre-bump evidence, not a new 2.35.4 release receipt.
- Public release additionally requires fresh evidence bound to this exact source and Setup.exe, installation and uninstall integrity in an isolated Windows environment, verified profile backup/restore, and diagnostics redaction checks.
- The installed BLACKICE profile is not modified by creating or packaging this candidate. A GitHub draft is not a published release.
