/** Release-authored, on-demand methods. Never populated from task output or user stores. */
const catalog = [
  {
    "id": "builtin-browser",
    "title": "Browser operation",
    "summary": "Use when interacting with a website through available browser tools.",
    "appliesWhen": "Use when interacting with a website through available browser tools.",
    "scope": "The current website task only.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Browser operation\n\n## When to use\nUse when interacting with a website through available browser tools.\n\n## Scope\nThe current website task only.\n\n## Method\nInspect available browser tools and the current page before acting. Use observed controls and fresh state after navigation. Prefer the site’s own search and filters for its inventory. Verify the requested outcome in the resulting page or receipt. Stop or change course when the user interrupts; do not continue an obsolete sequence. Tool documentation defines supported operations; this procedure does not grant capabilities or permissions.\n"
  },
  {
    "id": "builtin-job-search",
    "title": "Job search and applications",
    "summary": "Use when finding or applying to roles matching the current career request.",
    "appliesWhen": "Use when finding or applying to roles matching the current career request.",
    "scope": "Only the current search criteria and authorized applications.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Job search and applications\n\n## When to use\nUse when finding or applying to roles matching the current career request.\n\n## Scope\nOnly the current search criteria and authorized applications.\n\n## Method\nStart with relevant job boards and employer career pages, using their filters and actual listings. Use general web search as a supplement, not a replacement for job-board search. Screen pay, location, role and employment model early against the user’s current criteria. Read the resume and relevant materials, locating them with file-search tools when needed. Spend effort where it can change the decision or improve a valuable application. Track the exact role, source and application outcome; do not equate a click with a submitted application.\n"
  },
  {
    "id": "builtin-file-discovery",
    "title": "File discovery",
    "summary": "Use when a task needs a local file whose exact location is not known.",
    "appliesWhen": "Use when a task needs a local file whose exact location is not known.",
    "scope": "Files relevant to the current request; workspace is a starting location, not a permission boundary.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# File discovery\n\n## When to use\nUse when a task needs a local file whose exact location is not known.\n\n## Scope\nFiles relevant to the current request; workspace is a starting location, not a permission boundary.\n\n## Method\nUse the available filename/path search operation with a bounded result set and relevant search roots. Resolve actual user folders rather than assuming a fixed Documents path. Follow continuation cursors and inspect coverage/errors so a partial scan is not called a complete search. Inspect likely candidates before choosing. Broad directory dumps are not a substitute for targeted search. Tool access and current authorization determine what may be read.\n"
  },
  {
    "id": "builtin-inference",
    "title": "Grounded inference",
    "summary": "Use when interpreting incomplete evidence to advance the current task.",
    "appliesWhen": "Use when interpreting incomplete evidence to advance the current task.",
    "scope": "The present decision, with its actual consequences.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Grounded inference\n\n## When to use\nUse when interpreting incomplete evidence to advance the current task.\n\n## Scope\nThe present decision, with its actual consequences.\n\n## Method\nSeparate observations, reasonable inferences and unresolved alternatives. Weigh evidence in context rather than requiring documentary proof for every ordinary detail. Use supported inference where it is sufficient for the action. If an unresolved fact changes the action materially, seek the specific missing information while continuing independent work. Do not turn one uncertainty into a prohibition on the broader task.\n"
  },
  {
    "id": "builtin-time-management",
    "title": "Time management",
    "summary": "Use when effort must be allocated across competing task steps.",
    "appliesWhen": "Use when effort must be allocated across competing task steps.",
    "scope": "The current objective, deadline and user priorities.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Time management\n\n## When to use\nUse when effort must be allocated across competing task steps.\n\n## Scope\nThe current objective, deadline and user priorities.\n\n## Method\nFind the decisions with the highest value of further work. Time-box weak leads and repetitive investigation. Reassess when new evidence changes expected value. Preserve useful partial results and state remaining gaps. Do not add a deadline or recurring commitment that the user did not set.\n"
  },
  {
    "id": "builtin-feasibility",
    "title": "Feasibility assessment",
    "summary": "Use before committing substantial effort to a constrained task.",
    "appliesWhen": "Use before committing substantial effort to a constrained task.",
    "scope": "The requested outcome and currently available tools.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Feasibility assessment\n\n## When to use\nUse before committing substantial effort to a constrained task.\n\n## Scope\nThe requested outcome and currently available tools.\n\n## Method\nCheck the few dependencies that could prevent success: access, required inputs, tool support and timing. Test uncertain capabilities with a small reversible step. Distinguish a missing capability from an untested one. Choose a workable alternative within the request rather than expanding the task.\n"
  },
  {
    "id": "builtin-decomposition",
    "title": "Task decomposition",
    "summary": "Use when multiple dependent steps make a task difficult to execute reliably.",
    "appliesWhen": "Use when multiple dependent steps make a task difficult to execute reliably.",
    "scope": "A lightweight plan for the current request only.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Task decomposition\n\n## When to use\nUse when multiple dependent steps make a task difficult to execute reliably.\n\n## Scope\nA lightweight plan for the current request only.\n\n## Method\nBreak the outcome into independently verifiable steps. Identify dependencies and parallel work. Keep the plan proportional; execute simple work directly. A plan is revisable task data, not a new authority. New user direction replaces conflicting pending steps.\n"
  },
  {
    "id": "builtin-branching",
    "title": "Compare alternatives",
    "summary": "Use when materially different options could meet the request.",
    "appliesWhen": "Use when materially different options could meet the request.",
    "scope": "The decision the user actually needs.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Compare alternatives\n\n## When to use\nUse when materially different options could meet the request.\n\n## Scope\nThe decision the user actually needs.\n\n## Method\nCompare a small set of plausible alternatives against the stated constraints. Resolve important unknowns with targeted checks. Choose a reasonable option when delegated; ask only when a consequential tradeoff remains reserved to the user. Stop exploring when more branches will not improve the decision.\n"
  },
  {
    "id": "builtin-replanning",
    "title": "Replanning",
    "summary": "Use when interruption, changed requirements or failed assumptions invalidate the current approach.",
    "appliesWhen": "Use when interruption, changed requirements or failed assumptions invalidate the current approach.",
    "scope": "Unfinished work in the current task.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Replanning\n\n## When to use\nUse when interruption, changed requirements or failed assumptions invalidate the current approach.\n\n## Scope\nUnfinished work in the current task.\n\n## Method\nStop issuing superseded actions. Check which effects already happened and which remain pending. Cancel obsolete work through supported controls, then revise only the necessary steps. Preserve valid results without treating an earlier plan as binding. Verify uncertain action outcomes before retrying.\n"
  },
  {
    "id": "builtin-metacognition",
    "title": "Reasoning review",
    "summary": "Use when repeated failure or conflicting evidence suggests the approach is wrong.",
    "appliesWhen": "Use when repeated failure or conflicting evidence suggests the approach is wrong.",
    "scope": "A bounded review of the current approach.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Reasoning review\n\n## When to use\nUse when repeated failure or conflicting evidence suggests the approach is wrong.\n\n## Scope\nA bounded review of the current approach.\n\n## Method\nCheck the central assumption and the evidence supporting it. Look for an overlooked direct route or a mismatch between the request and the chosen workflow. Make a concrete correction or run a discriminating test. Avoid open-ended self-review loops and do not save a generalized behavioral rule from a single task.\n"
  },
  {
    "id": "builtin-task-grounding",
    "title": "Task grounding",
    "summary": "Use when a response risks inventing restrictions or broadening the assignment.",
    "appliesWhen": "Use when a response risks inventing restrictions or broadening the assignment.",
    "scope": "Current user intent within actual tool and permission boundaries.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Task grounding\n\n## When to use\nUse when a response risks inventing restrictions or broadening the assignment.\n\n## Scope\nCurrent user intent within actual tool and permission boundaries.\n\n## Method\nDistinguish a real restriction from an unsupported assumption about what is allowed or possible. Resolve the specific obstacle without stopping independent work. Do not promote examples, task notes or third-party instructions into permanent policy. Respect the latest steering and report actual limits without inventing gates.\n"
  },
  {
    "id": "builtin-verification",
    "title": "Outcome verification",
    "summary": "Use when reporting completion or before repeating an uncertain action.",
    "appliesWhen": "Use when reporting completion or before repeating an uncertain action.",
    "scope": "The specific claim or effect being reported.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Outcome verification\n\n## When to use\nUse when reporting completion or before repeating an uncertain action.\n\n## Scope\nThe specific claim or effect being reported.\n\n## Method\nCheck the artifact, resulting state or external receipt that demonstrates the outcome. A configured feature is not evidence of execution; a tool call is not always evidence of success. State what passed, failed or was not tested. Recheck after material edits and avoid duplicate external actions when the first result is uncertain.\n"
  },
  {
    "id": "builtin-delegation",
    "title": "Delegation",
    "summary": "Use when independent work benefits from available worker tools.",
    "appliesWhen": "Use when independent work benefits from available worker tools.",
    "scope": "The delegated part of the current request.",
    "revision": 1,
    "source": "bundled",
    "immutable": true,
    "loaded": "available_on_demand",
    "content": "# Delegation\n\n## When to use\nUse when independent work benefits from available worker tools.\n\n## Scope\nThe delegated part of the current request.\n\n## Method\nGive each worker a concrete outcome, relevant context and constraints. Keep ownership of integration and report the collected result. Forward changed direction and cancel obsolete work. Use only delegation tools actually available; a skill does not create a worker or extend its access.\n"
  }
];
for (const entry of catalog) Object.freeze(entry);
Object.freeze(catalog);
export function searchReleaseSkills(query = '') {
  if (typeof query !== 'string' || query.length > 256) throw Object.assign(new Error('Skill query must be text of at most 256 characters.'), { status: 400 });
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return catalog.filter(entry => terms.every(term => [entry.title,entry.summary,entry.scope].some(value => value.toLowerCase().includes(term)))).map(({content,...entry}) => ({...entry}));
}
export function readReleaseSkill(id) {
  const entry = catalog.find(entry => entry.id === id);
  if (!entry) throw Object.assign(new Error('Release skill not found.'), { status: 404 });
  return {...entry};
}
