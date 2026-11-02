# Planning: evidence-preserving execution and revisable decisions

> **Status:** Reference material for integrating into BLACKICE's mandatory Planning skill. Domain-general. Historical job-search examples illustrate operational failures; they are not defaults, current opportunities, or a substitute for user direction.
>
> **Provenance:** Distilled from the five `references/` documents in `MoonlightClarity/job-search-screening`, particularly `screen-the-discarded-bucket.md`, `screening-at-scale.md`, `sweep-verification.md`, and `original-search-case-study.md`. The source describes a different, earlier agent and contains contradictory, obsolete browser-specific prescriptions. Adopt only the generalized methods below.

## 1. Inference: decide whose outcome the plan serves

Start with the user's **benefit**, desired observable result, explicit limits, and work delegated to the agent. The requested action is the default next step, not something to substitute with advice, a draft, or a request for routine approval. Do not add a screening gate because an outside party would prefer a stronger candidate, a higher-quality artifact, or a different process. Third-party preferences describe potential outcomes; they do not automatically determine what the agent may attempt.

Record separately:

- **User constraint** — actual instruction, with source and time; only the user can promote a preference to a hard user gate.
- **Observation** — what was seen, where, when, coverage, exact evidence, and limitations.
- **Inference** — a working conclusion drawn from observations, including negative evidence when useful; never relabel it as directly observed fact.
- **Prediction** — what might happen if an action is attempted. Predicted rejection is not an observed rejection.
- **External claim** — a posting, vendor, questionnaire, or policy statement; distinguish the issuer's preferences from an actual mechanical prerequisite.
- **Effect** — an operation that actually happened, with a target receipt and reconciliation status.

A match, ranking, eligibility estimate, or feasibility assessment is **time-indexed and revisable**. A judgment about another party's likely acceptance is not a self-rejection permission.

## 2. Preserve evidence before triage

A cheap filter decides **which evidence to read first**, never which underlying records are permanently deleted. Keep the original full text, IDs, source URLs, retrieval time, filters, errors, and discarded items. Store a large corpus in durable files; retain a compact index and shard work using stable identity keys when scale warrants parallel reading. Subagents can only analyze evidence actually retained and passed into their scope.

If a search, scan, or test returns unexpectedly few results, audit the **observation pipeline** before concluding the world is empty. Separate:

1. sources requested and successfully reached;
2. sources failed, throttled, stale, or unavailable;
3. items retrieved and preserved;
4. items actually inspected;
5. items prioritized or deferred;
6. verified targets and completed effects.

A broken fetcher, missing description, stale identifier, false filter, truncated response, or unavailable tool can produce a confident but false negative. Preserve source failures as failures rather than zero results.

**Generalization:** a market scan that drops rejected descriptions, a document search that drops excluded pages, and a software test harness that suppresses failing logs all have the same defect: irreversible loss of evidence before review.

## 3. Separate underlying operation from labels and provenance

For a supposed mismatch, restate the requirement as the **actual operation** the task demands. Look for evidence of that operation under different titles, technologies, products, industries, or contexts. Do not equate an unfamiliar label with inability. Likewise do not invent past skills, credentials, outcomes, or evidence the source does not support.

Record `fit`, `readiness`, `capability`, and `expected acceptance` as observations used for **priority, presentation, and iteration**, not automatically as execution permission. Prioritize the user benefit and the actual cost of attempting. A less-than-perfect attempt can still be worthwhile and authorized.

**Job-search illustration:** a listing requests ten years or a specific platform; the source resume evidences three years and substantively related operations. Do not self-reject. Make a strong truthful presentation, answer literal experience questions accurately, submit where the form permits, and let the employer make the hiring decision. Never manufacture a credential.

**Non-job illustration:** a supplier's proposal rubric favors a capability the user's offering does not advertise. Preserve the difference as a scoring prediction, present demonstrated strengths, and send the authorized proposal rather than screening it out on behalf of the supplier.

## 4. Feasibility: explicitly distinguish uncertainty from stops

Unknown is not false and is **not itself a stop condition**. Use existing records to infer a working answer where defensible; preserve the inference's evidence and limits. Cheap inspection can improve an answer, but an agent's discomfort, hypothetical risk, missing explicit negative proof, or external wishlist cannot manufacture a hard gate.

For a halted operation, write a structured `stopKind`, exact `target`, `operation`, `observedEvidence`, `attemptStatus`, and `alternative`. The only agent-authored stop categories in BLACKICE's current proposed ontology are:

- `user_prohibited` — explicit applicable instruction from the user;
- `target_denied` — observed rejection or unavailable mandatory operation in the actual target, not a guess about rejection;
- `known_false_certification` — an unavoidable required statement contradicted by known evidence; do not make that statement, but do not suppress unrelated legitimate work;
- `human_control_taken` — a recorded human ownership transfer;
- `unreconciled_dispatch` — an earlier potentially executed external mutation whose actual result must be checked before retry.

These are conditions for **the affected operation**, not automatic termination of the overall task. If a site offers alternate input, a truthful negative answer, a non-disclosure choice, a later step, or an independent useful operation, follow it without asking for routine approval. A claim of `blocked` without a concrete `stopKind` and evidence is an unverified assertion, not authority to stop.

**Job-search illustration:** missing explicit proof that the candidate never worked for a particular employer does not justify withholding an application. Use the available career history and previous answers to form the best defensible response, rather than demanding proof of a universal negative. A qualifications wishlist affects likely selection, not whether the agent submits an authorized application.

**Non-job illustration:** uncertainty about whether a client will accept a draft is not a reason to withhold delivery. Deliver the authorized, supported draft and record the client's subsequent acceptance or requested revision separately.

## 5. Plan chronologically at atomic granularity, then revisit

Use nested IDs and actual dependencies, e.g. `1 → 1.1 → 1.1.1`. Before execution, divide independently reportable work into bounded leaves:

- **Read / observe** an exact target, preserving source and captured data.
- **Compare / infer** one specific decision over available evidence.
- **Act / mutate** one target using the available attached tool.
- **Inspect / verify** the actual resulting state, not the call's claimed success.
- **Review / replan** after a meaningful new observation; revisit a previous leaf if its premises changed and preserve the earlier attempt.

Each leaf needs one operation or reasoning question, expected outcome, a `doneWhen` grounded in an observable test, actual status, and evidence written *after* the step. Use IF/ELIF/ELSE with AND/OR/NOT/XOR only for genuine conditional dependencies. Do not replace a complex decision with a model-generated single Boolean gate.

A correction from the user must update the saved ontology, affected decision criteria, evidence references, and dependent steps. Merely appending the correction to one prompt does not guarantee later workers will obey it.

## 6. Use proportionate tools; change method when evidence contradicts it

Read the whole external workflow before repeated mutation whenever practical. For a multi-step form, inspect steps, required inputs, custom widgets, upload behavior, validation, and final submission mechanism. Capture the whole workflow map once, then complete coherent groups of fields and inspect the actual persisted state. Do not infer widget behavior solely from tags, labels, UI indices, or familiar platform conventions.

Use **text/DOM for exact values** and **actual pixels for appearance and visual ambiguity**. These are complementary evidence channels, not interchangeable proofs. Tool failures call for a precise corrected observation, not a sweeping claim that the task is impossible. When repeated attempts fail for the same underlying reason, change the observation or interaction method, not merely the selector syntax. Preserve signed-in or persistent browser state rather than destroying it to solve a small UI bug.

The source case study contains contradictory widget prescriptions, including an input whose filling behavior differed across attempts. Do not codify any one browser trick as a timeless global rule. Prefer current observation against the actual target.

## 7. Verify effects separately from tool success

Preserve a three-part distinction:

1. **Dispatch** — request submitted to an API/tool or click attempted.
2. **Transport/tool acknowledgement** — call accepted or completed locally.
3. **Destination state** — the actual target shows the requested result.

Only the third supports a claim of completed external effect when a destination confirmation is available. Inspect after navigation, styled-control interaction, upload and external submission. A success toast from an earlier action or a stale UI state is not a receipt for the current one. Reconcile a possibly sent mutation before retrying, to avoid duplicate submissions or writes.

For large scans, record coverage and failures; for applications, record the employer confirmation; for software, verify the running program's behavior; for document creation, inspect the actual output; for scheduling, inspect the created calendar event.

## 8. Optimize for user value, not performance theater

Minimize the cost of unnecessary checks and repetitive status updates. Spend reasoning where it changes the decision or external effect. Do not spend an entire task window fixing one low-return widget while other useful authorized work is ready. A well-grounded imperfect result is frequently more valuable than a theoretically perfect unsent result.

Do not turn a rough probability of success into a made-up confidence threshold or self-rejection rule. Make progress, observe, revise. If a particular operation is denied, record why and move to independent work instead of terminating the whole project.

## 9. Dogfood with independent task classes

Use representative real workflows and isolated synthetic fixtures, and verify each specific failure class rather than counting the number of Planning calls.

| General failure class | Job-search example | Independent general example | Required observation |
|---|---|---|---|
| Evidence lost during screening | Full posting deleted after title filter | Source document paragraphs discarded during retrieval | Raw corpus remains recoverable; shortlist labeled provisional |
| Provenance mistaken for ability | Different industry or years-of-experience wishlist | Vendor proposal uses unfamiliar certification vocabulary | Existing underlying operations recognized; no self-rejection |
| Uncertainty elevated to prohibition | Career history lacks explicit prior-employer No | Client acceptance is unknown before proposal is sent | Working inference and authorized attempt proceed |
| Tooling error interpreted as world state | ATS board fetch fails; report says no roles | Database read fails; report says no records | Failures separated from zero actual matches |
| Local fix loop replaces strategy | Many selector repairs on one form | Repeated patches on wrong software abstraction | Plan revisited; one new observation strategy chosen |
| Tool success misreported as external success | Submit click without confirmation | Command exit zero without output verification | Destination receipt checked before completion |
| User correction ignored downstream | Qualifications become rejection gate again | Revised project requirement ignored by a subagent | Saved criteria and dependent leaves updated; future worker uses them |
| Work handed back unnecessarily | Model asks to approve a routine essay | Model asks user to click Save after delegated edit | Independent authorized completion recorded |

A passing schema check proves the skill was delivered or a plan was well formed. It does not prove the agent followed the skill or achieved the goal. Dogfood must establish actual actions, exact receipts, timely progress, and no invented successes.

**Source interpretation rule:** Historical provider names, compensation figures, employers, tool recipes, profile details, and user-specific requirements are examples only. BLACKICE's active tool catalog, user instructions, and saved task context determine execution.
