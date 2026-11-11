# Retired automatic Planning boundary

The former forced Inference/Feasibility/Plan/Think/Respond orchestrator is not an execution path. Retiring it does not remove current modular graph primitives or independent operational-effect receipts.

## Current behavior

- Current graph CRUD, full-program revision checks, explicit single-module responses, and native/direct graph tools remain available.
- A generic module group whose kind is `cycle` is not a legacy workflow by itself.
- Historical host-owned orchestration records are readable. Public graph edits, new responses, review attempts, module starts and format repairs cannot turn them into current executable work.
- Exact previously saved idempotent receipts remain recoverable without execution. Changed same-ID arguments remain conflicts.
- Cancellation and truthful settlement of already admitted work remain possible; cancellation does not undo completed effects.

The archive classifier uses host orchestration metadata: a diagnostic capture, a viability definition, a response-cycle root or stage-node mapping. A saved explicit `plan_only` intent is also non-executable. Caller-chosen module names and kinds do not confer or remove execution authority. An edit is checked against the stored record before applying XML or other replacement fields, so removing visible metadata cannot unlock an archived graph.

## Retired entry points

New automatic cycles, cycle runs, plan editing/adoption/continuation, viability answers that resume work, and legacy canonical diagnostic capture/run return HTTP 410 with `PLANNING_CYCLE_RETIRED`. Internal orchestration and readiness service entry points reject too. The old direct cycle tool is not advertised; a stale direct call can only recover its already recorded owned receipt, otherwise it is retired.

Stale `plan_only` values remain visible on historical records and are rejected before Engine admission, retry, continuation, or dispatch. A higher-precedence `automatic` value must not hide a saved no-execution setting. New modular requests do not accept the obsolete automatic-cycle creation option.

The browser removes automatic cycle actions and presents saved pipeline results as read-only. Backend rejection is authoritative even for old mounted pages or stale connectors.

## Independent safety and scheduling

Generic workflow dispatch, Cronjobs, application history, operation identity, duplicate prevention, uncertain-effect recovery and durable effect evidence are separate concerns. Removing the planner must not remove those controls or silently restore readiness gates to schedules. UNKNOWN execution outcome is not an unknown personal fact.

## Verification scope

Retirement tests use synthetic providers and disposable saved records. They verify assembled authenticated HTTP admission, direct durable receipt replay, native control denial, stored archive mutation/repair denial, Engine and UI stale-mode handling, and positive current graph/module behavior.

Obsolete tests that require the automatic pipeline to create, drive, adopt or resume must be replaced by rejection/archive coverage rather than enabled through a compatibility switch. Pure parser, archive projection, graph CRUD, explicit-module, ordinary provider, operational effects and schedule tests remain relevant. Mixed files require case-level review. A passing focused suite is not a full-suite or installed-runtime guarantee.
