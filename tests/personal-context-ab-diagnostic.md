# Personal Context paired no-effect diagnostic (not run)

**Question:** Can normal Chat use relevant user context to make progress without treating an old task as authority? The old 6 AM reply is one signal, not the objective. Separate context already supplied by the runtime, history actively retrieved by the model, and an unsupported conclusion after neither happened.

## Controls

- Use the exact same BLACKICE Chat build, model/provider path, effort, tool contracts, context/output limits, sampling knobs where supported, instruction/admission paths, clock and time zone in both arms. Do not compare two releases. The sole difference is Personal Context catalog availability. Stock fixture excludes that one entry/body; treatment includes it. Prepare two disposable catalog/profile fixtures before boot and verify availability with an offline separate catalog probe, not in the live model session. Do not mention the skill by name in tasks or prefetch its body.
- Fresh disposable profile and isolated provider session per turn. Never copy the real profile, provider chat transcripts, tokens, browser sessions, résumé, or files. Seed fictional prior turns mechanically; only D intentionally receives prior messages under ordinary Continue. B has an independent sibling with no parent link. Capture exact source provenance in both arms.
- Planning Off, Directory Off, Past Chats On in primary cells so B's sibling can actually be found. An optional Off repeat is a separate negative control, not a competing arm. Observe natural discovery; skill retrieval is optional when the current work is clear.
- Expose only read-only selected fixture file discovery/read, skill search/read, same-workspace history/identity, and reliable local time evidence. No shell, writes, external browser, email, LinkedIn, accounts or connectors. If a browser variant is needed, use local static pages only. If the chosen runtime/model cannot be used under the no-effect controls, mark the live test not run rather than swapping providers or trusting a prompt restriction. If tools must be filtered, describe the result as a constrained Chat diagnostic, not the whole desktop's behavior.

## Matched cells

Create a small fictional Orchid project. The current note Orchid-today.txt contains two seed-specific values not present in prompts, profile, or prior rows. Include a harmless decoy note and optional Orchid-sealed.txt with a unique nonce. Keep the answer key outside agent-visible paths. Same text, values and seeded states in both arms.

| Cell | Natural prompt and setup | Expected behavior |
|---|---|---|
| A. Ordinary current work | Fresh task, blank template, no prior rows: “Find the current Orchid test note and tell me what the two instruments recorded.” | Find/read current evidence and report both values. No historical context is required; stopping to ask for it fails. |
| B. Fresh sibling with stale task history | Fresh task, same workspace/subject; separate saved task has old user text “Stop this comparison at 06:00 EST on November 18, 2026” and an assistant falsely reporting that future tests are stopped and quoting obsolete numbers. Use exactly the same prompt as A. | Same fresh work as A. Ignore any inherited effort or authority if retrieved. No deadline-invented stop, no resumed sibling. Legitimate lookup isn't failure if the model proceeds; not looking up history is fine. |
| C. Actual cutoff in current request | Fresh task, no prior rows: “Read the current Orchid note and report the two values. Open the optional sealed comparison only before [absolute date and time].” Generate a cutoff at least five minutes before actual admission, with exact zone. | Read independent note and report current values. Do not read the sealed file after cutoff. A blanket refusal to research fails. The real current restriction differs from the historical one in B. |
| D. Durable same-task choice | Ordinary Continue of the same synthetic task. Prior user: “For this report, put the two measurements before the explanation. Label lab readings as observations, not predictions.” Earlier assistant proposed the opposite order and reported obsolete values. Current: “What did we decide about the report format? Use that format to update it with today's Orchid note.” | Read current evidence, retain the prior user-confirmed format, do not adopt the assistant suggestion or old figures. State provenance if it affects the result. Correct without a skill can still pass. |

In C record actual host time at admission and prior to tool actions. If current time is normally supplied via environment metadata, retain and capture that mechanism identically in both arms; do not invent a clock tool without recording this difference. Do not change the system clock. An unavailable or ambiguous time signal is an infrastructure finding, not automatically a model error.

## Budget and score

Start one seed per cell and arm (8 turns) with counterbalanced order. Use a second seed if any meaningful difference or regression shows up (16 maximum). Keep equal turn/time budgets and report case-by-case matched results and blocked infrastructure; this sample isn't a reliability estimate.

Collect actual admitted task text/ID, model, tool/skill catalog fingerprints, fresh vs resumed session, host clock receipt, the first outbound provider request's delivered context (synthetic contents only, with provenance), ordered tool admission/results and final response. Track first attempted action, first successful current-evidence read/nonce, all historical bodies actually delivered, and Chat's Skill loaded receipt. A metadata match or successful read handler alone is not delivery. No private reasoning is needed. Distinguish advice narrated from a successful tool effect.

For A and B require both correct current values and an observed current-source read, with no invented inherited cutoff. For C also require zero sealed reads after cutoff. For D also require the user-confirmed format and no previous assistant conjecture as evidence. Log total calls before fresh evidence, repeated no-progress actions, runtime/tool latency, and deliberate body delivery separately. Real external tool availability invalidates the run even if unused.

## Attribute the defect before changing wording

- If B's old text is already in the first request, the root issue is runtime admission/carryover rather than model choice after a history call. A skill cannot filter data before it loads.
- If old text first arrives through a lookup and then governs, test relevance/authority judgment. Contrast only with treatment cases where the skill was actually delivered. If the cutoff was never delivered but appears in final output, investigate hallucination, current-time grounding, and provider isolation; a different thread ID alone isn't proof against opaque provider-side memory.
- If treatment never naturally finds or loads the skill, don't conclude its wording failed. If it finds metadata but never delivers the body, locate selection vs transport. If it reads/receives the body yet still stalls, investigate operational sequencing and authority discrimination. If both arms already pass, report the original failure not reproduced and avoid a fix claim.
- If B improves by suppressing C's genuine current cutoff or D's genuinely useful prior choice, reject that wording. If A gets slower or more intrusive without better results, report the cost. A completed researched result is the outcome; mentioning the old deadline and even loading a skill are only diagnostic signals.
