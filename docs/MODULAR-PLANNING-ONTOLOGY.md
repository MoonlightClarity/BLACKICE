# Modular Planning Ontology

Forced Planning and its response-cycle admission contract are retired. New BLACKICE Chat conversations use the independent module ontology. Historical Forced, Advisory and Plan-only records remain readable as history but cannot activate the old planner. A new request explicitly selecting Plan-only is rejected before admission; it is never silently upgraded to Automatic.

## Control surface

In Chat, select **Planning → Modules**. A small **Modules** disclosure sits below the normal Chat controls, **collapsed by default**. Expanding it reveals the three-column checkbox grid; collapsing it does not change module selections or conversation-level persistence. Every module has four mutually exclusive checkbox choices: **M** (Mandatory), **O** (Optional), **F** (Forbidden), and **A** (Auto). Auto allows the model to choose a task-local state for that module without another model pass. Choosing Optional makes the method available without requiring it; selecting Mandatory or Forbidden keeps that explicit user choice authoritative. This replaces the older large explanation pane and global Auto checkbox. **Save default** persists the displayed grid as the application fallback. Settings resolve in this order: **unsent conversation override > saved conversation run > application defaults**. Changes to one conversation never silently alter another; a new conversation starts from defaults unless it has its own unsent draft.

The default modules are Intent inference, Feasibility, Task decomposition, Conditional logic, Recursive reassessment, Metacognition, Anti-overalignment calibration, Outcome verification, and Subagent orchestration. They default to Auto except **Anti-overalignment calibration**, which defaults to Mandatory. Users can override it, including Forbidden.

## Runtime behavior

The modular policy is a lightweight, inline instruction policy, not a new model pass, graph admission gate, task-state contract, checkpoint requirement, fixed planning loop, or automatic review ritual. Agents may still use tools and existing plans when not forbidden. A Forbidden decomposition module removes plan controls from the attached catalog and denies hidden planning-cycle actions through the general control tool, while leaving unrelated control actions available. A Forbidden subagent module removes delegation. Other methods currently rely on model instruction adherence rather than a new semantic host classifier.

An unsupported module or a task-specific operational failure must not be reported as the whole model being unavailable. A model that cannot call tools can still produce a supported non-operational response, while honestly reporting unperformed effects.

## Strict anti-overalignment and minimum-scope stopping

A **genuinely binding obstacle blocks only the smallest affected operation**, never the whole user task by default. For an unresolved field, park that field or its dependent form; for one application's blocked submission, continue other applications; for one unavailable website or provider, continue viable alternatives. Maintain the user's overall goal, unfinished items, and actual receipts. Do not turn one blocked leaf into a terminal task failure.

Only affirmative evidence can justify a local stop: an explicit user hard constraint, verified binding requirement, unsupportable consequential personal declaration, genuinely unavailable permission or tool with no viable alternative for that specific action, or an unresolved potentially duplicate consequential effect. A missing résumé statement, employer wishlist, inferred restriction, uncertain skill, sponsorship question, or planning-contract failure is not by itself an affirmative disqualifier. Avoid invented résumé-only rules and unsupported certainty thresholds.

For an ambiguous **sponsorship Yes/No** requirement, inspect reliable prior context, make a truthful supported choice when evidence permits, and do not invent either Yes or No. If the individual declaration is genuinely unknowable, defer only the form or application that requires it and continue other applications. Never infer eligibility merely from absence of evidence.

Before a potentially duplicate application, inspect saved submission records and destination receipts. If the original effect remains uncertain, quarantine only that exact application while other applications continue. A still-open browser tab does not establish duplication or its cause. Report submitted, pending, and unverified outcomes separately.

Even when nothing can proceed at that moment, report a bounded partial result and unresolved work rather than claiming the entire goal is completed. Do not invent extra user-approval gates. This policy cannot authorize making an unsupported material declaration.

## Operational safeguards outside Planning

Application-history checks, native effect reservations, deduplication, durable UNKNOWN states and effect receipts run in an independent operational layer without an attached planning contract. Recognized job applications reserve their requisition before dispatch; unrelated applications continue even if one receipt is uncertain. Workspace writes use verified file bytes and hashes, and a successful tool return is not external confirmation. See [Independent operational effect protections](OPERATIONAL-EFFECT-PROTECTIONS.md).

## Direct ChatGPT tools

- `blackice_planning_ontology` with `action:get` reads the saved default policy and available module catalog; `action:set` stores a replacement default policy for future chats.
- `blackice_start_chat` defaults to modular Planning and accepts an explicit `planningOntology` object for that newly admitted conversation.
- The installed connector tool catalog must be rebuilt/reloaded before ChatGPT can see these new definitions. Updating source files alone does not update an already connected tool catalog.

## Regression requirements

The test suite covers policy validation, per-conversation persistence, direct get/set, forbidden tool routing, execution without forced plan admission, strict minimum-scope blocking, operational reservations and receipts, historical record readability, and rejection of retired Plan-only actions. Long-running cron and native-context tests also verify continuity and protection from duplicate effects. Model-level behavioral and latency benchmarks remain separate future evaluation work.
