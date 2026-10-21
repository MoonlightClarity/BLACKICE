import type { TechniqueResponseKind, TechniqueStepDefinition } from "./types";

const s = (id: string, title: string, prompt: string, responseKind: TechniqueResponseKind = "long-text"): TechniqueStepDefinition => ({ id, title, prompt, responseKind });
const w = (...steps: TechniqueStepDefinition[]) => steps;

export const THEORY_DERIVED_SPECIFIC_WORKFLOWS: Record<string, TechniqueStepDefinition[]> = {
  "Efficiency Imperative Audit": w(
    s("system", "System and stated purpose", "Define the institution, process, or decision and the substantive human or mission purpose it is supposed to serve."),
    s("metrics", "Efficiency imperatives", "Identify optimization metrics, procedural demands, throughput targets, automation pressures, or claims that a single most-efficient means is necessary.", "list"),
    s("displacement", "Values displaced", "Identify qualitative goods, local judgment, autonomy, redundancy, resilience, legitimacy, or human needs that the efficiency frame discounts or makes invisible."),
    s("lockin", "Technical lock-in", "Trace how infrastructure, expertise, standards, incentives, and prior investments make the efficient method increasingly difficult to refuse or reverse."),
    s("reframe", "Purpose-first alternatives", "Reassess the choice using the original purpose rather than efficiency as the terminal value; identify slower, redundant, plural, or reversible alternatives worth preserving.")),
  "Technological System Autonomy Analysis": w(
    s("boundary", "Technical system boundary", "Define the linked technologies, procedures, institutions, experts, standards, and infrastructures shaping the issue."),
    s("dependencies", "Mutual dependencies", "Map how one technical component creates requirements for others, including maintenance, measurement, security, scale, training, and coordination.", "list"),
    s("momentum", "Self-reinforcing momentum", "Identify feedbacks through which adoption generates new problems or dependencies that are answered by still more technique."),
    s("choice", "Constraint on choice", "Distinguish nominal choices from options that remain practically feasible once interoperability, sunk costs, expertise, and institutional routines are considered."),
    s("leverage", "Leverage and escape", "Identify points where plural standards, manual fallback, decentralization, redundancy, or explicit non-efficiency values could restore meaningful choice.")),
  "Propaganda Environment Analysis": w(
    s("environment", "Information environment", "Define the population, media system, institutions, social conditions, and decision context in which persuasion operates."),
    s("preconditions", "Pre-propaganda and myths", "Identify preexisting myths, identities, grievances, aspirations, stereotypes, symbols, and accepted narratives that make messages intelligible and emotionally usable.", "list"),
    s("channels", "Repetition and integration", "Map channel diversity, repetition, social reinforcement, institutional participation, and whether apparently independent messages share the same premises or system incentives."),
    s("need", "Audience need and function", "Assess what psychological or social needs the propaganda environment satisfies—orientation, belonging, justification, simplification, action, or relief from uncertainty."),
    s("assessment", "Environmental assessment", "State which conditions make influence durable, what counter-messaging alone is unlikely to change, and which environmental shifts would reduce susceptibility.")),
  "Agitation–Integration Propaganda Analysis": w(
    s("corpus", "Message set and actors", "Define the message corpus, communicators, audiences, channels, time window, and political or organizational context."),
    s("agitation", "Agitation functions", "Identify messages that mobilize against an enemy or status quo through urgency, grievance, fear, rupture, sacrifice, or calls for exceptional action.", "list"),
    s("integration", "Integration functions", "Identify messages that normalize an existing order through belonging, routine participation, legitimacy, conformity, identity, and reinforcement of accepted institutions.", "list"),
    s("interaction", "Interaction and transition", "Examine how agitation and integration reinforce one another, alternate over time, or move audiences from disruption into a new normalized order."),
    s("indicators", "Behavioral implications", "Identify observable participation, conformity, polarization, mobilization, or demobilization patterns that would support or weaken the classification.")),
  "Fragility / Antifragility Stress Test": w(
    s("exposure", "Exposure and objective", "Define the system, outcome, stressor, and performance measure; distinguish survival constraints from ordinary performance goals."),
    s("perturb", "Perturbation range", "Specify plausible changes in volatility, dispersion, load, error, demand, timing, or shock size without assuming a single forecast.", "list"),
    s("response", "Nonlinear response", "Assess whether harm accelerates with stress, remains roughly linear, or whether variability can create net benefit; identify thresholds and asymmetries."),
    s("tails", "Tail and model-error sensitivity", "Test whether extreme observations or uncertainty about the model dominate the expected result and whether averaging conceals ruinous exposures."),
    s("redesign", "Reduce fragility", "Limit catastrophic downside, decentralize or cap exposures, add optionality or redundancy, and preserve small stressors that reveal weakness or create learning where appropriate.")),
  "Fat-Tail Exposure Audit": w(
    s("variable", "Exposure variable", "Define the loss, delay, demand, conflict, error, or other quantity whose extreme behavior matters to the decision."),
    s("regime", "Tail-regime evidence", "Examine whether extremes are bounded and well-behaved or whether scale, concentration, dependence, power-law behavior, or rare large observations make thin-tail assumptions doubtful."),
    s("aggregation", "Aggregation and concentration", "Identify whether diversification assumptions fail because exposures share drivers, whether a few observations dominate totals, or whether aggregation preserves heavy tails."),
    s("models", "Model-error stress", "Compare decisions under substantially different tail assumptions and identify estimates—means, variances, confidence intervals, return periods—that become unstable or misleading."),
    s("controls", "Tail-aware decision", "Set exposure caps, buffers, ruin constraints, monitoring triggers, or robust actions that do not depend on precise estimation of extreme-event probability.")),
  "Via Negativa Intervention Review": w(
    s("objective", "Objective and current harms", "Define the outcome sought and the concrete harms, friction, failure modes, or dependencies already present."),
    s("subtract", "Subtraction candidates", "List rules, features, handoffs, exposures, dependencies, incentives, or interventions that could be removed, simplified, or stopped before adding something new.", "list"),
    s("asymmetry", "Removal asymmetry", "For each subtraction, compare reversible loss of benefit with potential reduction in hidden downside, complexity, maintenance burden, and interaction effects."),
    s("iatrogenics", "Intervention harm check", "Identify ways the proposed additive intervention could create new fragility, dependence, side effects, measurement gaming, or hard-to-reverse commitments."),
    s("minimum", "Minimum sufficient action", "Choose the smallest reversible set of removals or additions that addresses the objective, and define evidence required before escalating intervention.")),
  "Skin-in-the-Game Incentive Audit": w(
    s("decision", "Decision and actors", "Identify who recommends, decides, implements, benefits, bears downside, and can exit from the decision."),
    s("payoffs", "Upside and downside map", "Map material, reputational, career, political, legal, and operational consequences for each actor under success and failure.", "list"),
    s("asymmetry", "Exposure asymmetries", "Identify actors able to capture upside while transferring tail losses, uncertainty, cleanup, or long-term consequences to others."),
    s("information", "Knowledge and accountability", "Assess whether those with superior information bear consequences for concealment, poor forecasts, unsafe recommendations, or repeated error."),
    s("realign", "Realign exposure", "Propose decision rights, warranties, clawbacks, staged authority, independent review, disclosure, or other mechanisms that better align influence with consequences.")),
  "Serial Optionality Review": w(
    s("goal", "Goal under uncertainty", "Define the long-term objective while separating it from any single predetermined route for reaching it."),
    s("commitments", "Commitments and exits", "List current or proposed commitments, their cost of reversal, decision deadlines, exit paths, and information gained before the next commitment.", "list"),
    s("trials", "Low-cost trials", "Identify small experiments, pilots, probes, or contracts that create information and upside while capping downside."),
    s("ratchet", "Ratchet and reset", "Define conditions for expanding successful trials, abandoning failures, and resetting into new options without preserving sunk-cost commitments."),
    s("sequence", "Option-rich sequence", "Construct a staged path with frequent decision points and preserved exits rather than one long irreversible plan.")),
  "Barbell Exposure Analysis": w(
    s("objective", "Objective and ruin constraint", "Define the objective and the outcomes that are unacceptable because they threaten survival, mission continuity, solvency, or irreversible loss."),
    s("safe", "Protected core", "Identify the portion of resources, capacity, commitments, or exposure that must remain highly robust, liquid, redundant, or otherwise protected from ruin."),
    s("upside", "Bounded-risk upside", "Identify small exposures with capped downside and potentially large learning, opportunity, or payoff.", "list"),
    s("middle", "Fragile middle", "Identify medium-risk commitments that look efficient in ordinary conditions but combine meaningful downside with limited upside, hidden leverage, or difficult exit."),
    s("rebalance", "Allocation and triggers", "Set allocation limits and rebalancing triggers that protect the core while allowing repeated bounded experiments on the upside.")),
  "Strategic Commitment Analysis": w(
    s("game", "Strategic interaction", "Define the actors, objectives, alternatives, sequence of moves, information, and what each side believes the other can still choose."),
    s("commitment", "Commitment device", "Identify actions that remove, worsen, delegate, automate, publicize, or otherwise constrain the actor's own future options."),
    s("credibility", "Credibility", "Assess whether the constraint is observable, costly to reverse, institutionally enforced, or otherwise believable to the other actor."),
    s("response", "Opponent response", "Model how the commitment changes the other side's incentives, bargaining position, coordination problem, and escalation or accommodation choices."),
    s("risk", "Commitment risk", "Identify bluff failure, accidental escalation, loss of flexibility, domestic audience costs, and conditions under which preserving options is strategically superior.")),
  "Focal-Point Coordination Analysis": w(
    s("problem", "Coordination problem", "Define the situation in which actors benefit from converging on the same action or interpretation but cannot fully communicate or enforce agreement."),
    s("candidates", "Candidate focal points", "List salient defaults, precedents, boundaries, symbols, round numbers, conventions, institutions, or culturally prominent solutions.", "list"),
    s("expectations", "Shared expectations", "Assess what each actor expects others to notice and what they expect others to expect in turn."),
    s("competition", "Competing focal points", "Identify rival conventions or frames, actor-specific salience, asymmetric information, and signals that could shift coordination."),
    s("assessment", "Coordination assessment", "Judge which focal point is most likely to organize behavior, how robust that judgment is, and what observable choices would reveal convergence.")),
  "Commons Governance Design Audit": w(
    s("resource", "Resource and boundaries", "Define the common-pool resource or shared capability, its users, legitimate rights, spatial or functional boundaries, and the appropriation problem."),
    s("rules", "Rules and local fit", "Assess whether use and contribution rules fit local conditions and whether costs, benefits, and obligations are proportionate."),
    s("governance", "Participation, monitoring, and sanctions", "Check whether affected users can help modify rules, whether users and resource conditions are monitored, and whether sanctions are graduated rather than all-or-nothing."),
    s("conflict", "Conflict and rights", "Assess access to low-cost conflict resolution and whether higher authorities recognize users' rights to organize rather than routinely overriding local rules."),
    s("nesting", "Nesting and durability", "For larger systems, examine nested governance layers, cross-scale coordination, and which missing design principles most threaten long-term institutional durability.")),
  "Polycentric Governance Analysis": w(
    s("issue", "Governance problem", "Define the public problem, geography, affected populations, externalities, and functions that require collective action."),
    s("centers", "Decision centers", "Map overlapping public, private, community, professional, and informal centers with meaningful autonomy over parts of the problem.", "list"),
    s("relations", "Coordination and competition", "Identify cooperation, rivalry, redundancy, mutual adjustment, information sharing, appeals, and gaps among centers."),
    s("scale", "Scale fit and feedback", "Assess which functions are handled at scales matching the problem and whether local experimentation can inform higher-level coordination without eliminating diversity."),
    s("resilience", "Governance resilience", "Identify single points of institutional failure, beneficial redundancy, accountability problems, and changes that improve adaptation while preserving effective local autonomy.")),
  "Requisite Variety Analysis": w(
    s("disturbances", "Disturbance variety", "List materially different states, failures, adversary moves, demand patterns, exceptions, or environmental conditions the regulator must handle.", "list"),
    s("responses", "Response variety", "Inventory the distinct actions, policies, controls, resources, authorities, and fallback modes actually available to the regulating system."),
    s("channels", "Information and channel capacity", "Assess whether the regulator can distinguish the relevant disturbance states early and accurately enough to select among its responses."),
    s("mismatch", "Variety mismatch", "Identify disturbances that collapse into the same response, responses that require unavailable information, and bottlenecks where the environment has more effective variety than the regulator."),
    s("redesign", "Amplify or attenuate variety", "Increase response repertoire, delegation, sensing, modularity, or learning—or reduce incoming variety through standardization, buffering, segmentation, or constraints—without hiding important differences.")),
  "Viable System Model Diagnosis": w(
    s("identity", "System identity and recursion", "Define the viable system, its purpose, environment, and the operational units that must themselves remain viable at lower recursive levels."),
    s("operations", "Operations and coordination", "Assess primary operations and the mechanisms that prevent oscillation, conflict, duplication, and destructive interference among them."),
    s("control", "Control and accountability", "Examine internal regulation, resource bargaining, audit, performance visibility, and whether central control overwhelms or under-supports operational autonomy."),
    s("intelligence", "Intelligence and adaptation", "Assess how the system scans the external environment, models future change, learns, and balances present operational demands against adaptation."),
    s("policy", "Policy and balance", "Examine identity, values, ultimate policy, and the balance among operations, internal control, and future intelligence; identify communication or variety failures threatening viability.")),
  "OODA Decision-Cycle Analysis": w(
    s("contest", "Competitive decision environment", "Define the actor, adversary or changing environment, objectives, time pressure, and the decision cycle being examined."),
    s("observe", "Observation quality", "Assess what is sensed, missed, delayed, distorted, or overloaded and how collection latency affects the usable picture."),
    s("orient", "Orientation", "Identify the prior experience, culture, doctrine, models, assumptions, unfolding circumstances, and synthesis processes shaping interpretation; treat orientation as the dominant filter rather than a mechanical step."),
    s("decide", "Decision and tempo", "Examine how candidate actions are selected, how quickly assumptions can be revised, and whether decision tempo creates initiative or merely faster error."),
    s("act", "Action, feedback, and adaptation", "Trace how action changes the environment, what feedback returns, and whether the actor can cycle with greater adaptability, ambiguity, and irregularity than the competitor.")),
  "Bounded Rationality / Satisficing Audit": w(
    s("decision", "Decision problem and bounds", "Define the decision, available time, information, attention, computation, organizational rules, and other constraints on exhaustive optimization."),
    s("search", "Search process", "Map how alternatives are generated and screened, which heuristics guide search, which regions of the option space are never examined, and what order effects matter."),
    s("aspiration", "Aspiration level", "State the thresholds that make an option good enough and identify whether those thresholds are explicit, inherited, politically set, or shifting with experience."),
    s("stopping", "Stopping rule", "Identify why search stops when it does and whether the first satisfactory option crowds out better but less immediately visible alternatives."),
    s("redesign", "Improve bounded choice", "Improve representation, search order, aspiration criteria, external memory, delegation, or staged review without pretending the decision-maker can optimize an immense problem space.")),
  "Recognition-Primed Decision Audit": w(
    s("situation", "Situation and expertise", "Define the time-pressured decision, cues available, decision-maker experience, and whether the environment is familiar enough for pattern recognition to be credible."),
    s("recognition", "Recognized pattern", "Identify the situation prototype, salient cues, plausible goals, expectancies, and typical action that the decision-maker recognizes first."),
    s("simulation", "Mental simulation", "Mentally run the first plausible action forward, looking for points of failure, missing conditions, unintended effects, and mismatches with the current situation."),
    s("repair", "Modify or reject", "If the action fails simulation, modify it or consider the next plausible action rather than generating an exhaustive option set by default."),
    s("limits", "Recognition limits", "Check for misleading familiarity, weak feedback history, novel conditions, overlearned patterns, and cues that should trigger slower comparative analysis instead of recognition-primed action.")),
  "Interactive Complexity / Tight-Coupling Audit": w(
    s("system", "System and hazardous function", "Define the system, mission, hazardous energies or consequences, boundaries, and the functions whose failure could propagate."),
    s("complexity", "Interactive complexity", "Identify hidden, nonlinear, shared, feedback-rich, common-mode, proximity, or poorly understood interactions that can combine failures in unexpected ways."),
    s("coupling", "Coupling and slack", "Assess buffers, delays, substitutability, reversibility, sequence constraints, time to intervene, and whether disturbances propagate faster than diagnosis and recovery."),
    s("conflict", "Control dilemma", "Identify where complex interactions demand local improvisation while tight coupling simultaneously demands centralized coordination, creating incompatible control requirements."),
    s("strategy", "Structural risk response", "Reduce coupling, simplify interactions, add slack or isolation, redesign catastrophic potential, or explicitly recognize where procedural reliability cannot remove the structural accident risk.")),
  "Legibility / Local-Knowledge Audit": w(
    s("scheme", "Administrative scheme", "Define the policy, plan, model, classification, standard, map, metric, or redesign intended to make a complex population or system easier to see and manage."),
    s("simplification", "Legibility simplifications", "Identify what local variation, informal practice, tacit knowledge, ecological interdependence, exceptional cases, or competing values are removed by the administrative representation."),
    s("power", "Implementation power", "Assess how strongly the simplified scheme can be imposed, how reversible it is, and whether affected people have meaningful capacity to resist, adapt, or correct it."),
    s("metis", "Practical knowledge", "Identify local, experiential, situated, or improvisational knowledge required for the system to work that is absent from the formal model."),
    s("redesign", "Legibility-safe redesign", "Preserve feedback from local actors, plural representations, reversibility, experimentation, exceptions, and adaptive discretion rather than forcing reality to conform to the simplified map.")),
  "Exit–Voice–Loyalty Analysis": w(
    s("decline", "Decline or dissatisfaction", "Define the deterioration in quality, performance, legitimacy, service, or relationship that prompts actors to respond."),
    s("exit", "Exit options", "Identify who can leave, switch, disengage, migrate, defect, or withhold participation; assess costs, barriers, substitutes, and who lacks meaningful exit."),
    s("voice", "Voice channels", "Identify formal and informal mechanisms for complaint, protest, correction, participation, bargaining, or internal reform and assess their credibility and responsiveness."),
    s("loyalty", "Loyalty effects", "Assess how loyalty, identity, sunk relationships, duty, or expected improvement delay exit, strengthen voice, or instead suppress warning and prolong decline."),
    s("dynamics", "System dynamics and intervention", "Examine whether exit deprives the system of its strongest correctives, whether voice is heard before actors leave, and which institutional changes improve feedback without trapping participants.")),
  "Goodhart–Campbell Metric Gaming Audit": w(
    s("goal", "Underlying goal and proxy", "State the substantive goal, the quantitative indicator used as its proxy, and the decisions, rewards, sanctions, rankings, or resources tied to that indicator."),
    s("pressure", "Target pressure", "Map how strongly actors are incentivized to improve the measured value and what discretion they have over classification, timing, denominator, case selection, reporting, or effort allocation."),
    s("gaming", "Gaming and distortion pathways", "Generate ways actors can improve the metric without improving—and possibly while damaging—the underlying goal, including teaching to the test, cream-skimming, reclassification, suppression, substitution, or data manipulation."),
    s("divergence", "Proxy-goal divergence", "Identify evidence that the metric is losing validity because behavior has adapted to measurement, and examine important outcomes displaced because they are unmeasured."),
    s("redesign", "Measurement safeguards", "Reduce single-metric stakes, rotate or triangulate indicators, add qualitative review and counter-metrics, audit manipulation channels, and keep the substantive objective distinct from the proxy.")),
};

export const THEORY_DERIVED_SPECIFIC_CATALOG_WORKFLOW_COUNT = Object.keys(THEORY_DERIVED_SPECIFIC_WORKFLOWS).length;
export const hasTheoryDerivedSpecificCatalogWorkflow = (name: string): boolean => Boolean(THEORY_DERIVED_SPECIFIC_WORKFLOWS[name]);
export const theoryDerivedSpecificCatalogWorkflow = (name: string): TechniqueStepDefinition[] | undefined => THEORY_DERIVED_SPECIFIC_WORKFLOWS[name]?.map((item) => ({ ...item }));
