import type { TechniqueDefinition, TechniqueFamily } from "./types";
import { techniqueFamily } from "./techniqueFamilies";
import { BUILT_IN_TECHNIQUES } from "./techniques";

export type TechniqueEffort = "quick" | "moderate" | "extended";
export type TechniqueEvidenceRequirement = "light" | "moderate" | "substantial";
export type TechniqueOutputType = "checklist" | "matrix" | "map" | "timeline" | "model" | "ranking" | "scenario" | "estimate" | "narrative" | "coded corpus" | "review" | "decision" | "network" | "risk profile";
export type TechniqueReference = { label: string; href: string };
export type TechniqueTaskId = "frame" | "evaluate-evidence" | "compare-hypotheses" | "challenge" | "forecast" | "compare-options" | "causal" | "investigate-network" | "threat-risk" | "synthesize-research" | "improve-process" | "interpret-context";
export type TechniqueTaskRecommendation = { name: string; role: string };
export type TechniqueDataType = "any" | "qualitative" | "quantitative" | "mixed" | "network" | "geospatial" | "documentary";
export type TechniqueSuitabilityContext = { effort?: TechniqueEffort | "any"; evidence?: TechniqueEvidenceRequirement | "any"; dataType?: TechniqueDataType; output?: TechniqueOutputType | "any" };
export type TechniqueSuitabilityRecommendation = TechniqueTaskRecommendation & { score: number; reasons: string[] };
export type TechniquePlaybookStep = { name: string; role: string };
export type TechniquePlaybook = { id: string; label: string; description: string; steps: TechniquePlaybookStep[] };
export type AdaptiveTechniquePlaybook = TechniquePlaybook & { mode: "rapid" | "focused" | "full"; omitted: TechniquePlaybookStep[] };
export const TECHNIQUE_TASKS: ReadonlyArray<{ id: TechniqueTaskId; label: string; description: string }> = [
  { id: "frame", label: "Frame a problem", description: "Structure an ambiguous question, scope, or decision." },
  { id: "evaluate-evidence", label: "Evaluate evidence", description: "Assess source quality, corroboration, gaps, and diagnostic value." },
  { id: "compare-hypotheses", label: "Compare hypotheses", description: "Test competing explanations against discriminating evidence." },
  { id: "challenge", label: "Challenge a judgment", description: "Expose assumptions, bias, failure modes, and contrary cases." },
  { id: "forecast", label: "Estimate likelihood", description: "Forecast outcomes, probabilities, indicators, and uncertainty." },
  { id: "compare-options", label: "Compare options", description: "Rank alternatives and examine robustness or tradeoffs." },
  { id: "causal", label: "Understand causes", description: "Identify causal structure, mechanisms, and identification assumptions." },
  { id: "investigate-network", label: "Investigate a network", description: "Map actors, ties, brokerage, dependencies, and diffusion." },
  { id: "threat-risk", label: "Assess threat or risk", description: "Model hazards, adversary behavior, barriers, and residual risk." },
  { id: "synthesize-research", label: "Synthesize research", description: "Review and integrate a body of studies or evidence." },
  { id: "improve-process", label: "Improve a process", description: "Diagnose process performance, causes, controls, and improvements." },
  { id: "interpret-context", label: "Interpret text or context", description: "Analyze discourse, historical context, rhetoric, or reception." },
];
export type TechniqueCatalogMetadata = {
  aliases: string[];
  effort: TechniqueEffort;
  evidence: TechniqueEvidenceRequirement;
  outputs: TechniqueOutputType[];
  prerequisites: string[];
  recommendedNext: string[];
  useBefore: string[];
  useAfter: string[];
  alternatives: string[];
  references: TechniqueReference[];
};

export const RETIRED_TECHNIQUE_ALIASES: Readonly<Record<string, string>> = {
  "Change Driver Mapping": "Drivers of Change Analysis",
  "Bias Checklist": "Cognitive Bias Audit",
  "Scenario Cross": "2x2 Scenario Matrix",
  "Implications Wheel": "Futures Wheel",
  "Abductive Reasoning Matrix": "Inference to the Best Explanation",
  "Risk Bowtie Review": "Bow-Tie Analysis",
  "Feedback Loop Audit": "Causal Loop Mapping",
  "Scenario Analysis": "Alternative Futures Analysis",
  "Exploratory Scenario Planning": "Alternative Futures Analysis",
  "Regret Analysis": "Minimax Regret",
};
const retiredAliasesFor = (canonical: string): string[] => Object.entries(RETIRED_TECHNIQUE_ALIASES)
  .filter(([, target]) => target === canonical)
  .map(([alias]) => alias);

const EXPLICIT_ALIASES: Record<string, string[]> = {
  "Drivers of Change Analysis": ["Change Drivers", "Drivers of Change"],
  "Cognitive Bias Audit": ["Cognitive Bias Checklist"],
  "2x2 Scenario Matrix": ["Scenario Matrix", "Two-by-Two Scenario Matrix"],
  "Futures Wheel": ["Implication Wheel"],
  "Inference to the Best Explanation": ["Abductive Reasoning", "Abduction"],
  "Bow-Tie Analysis": ["Bowtie Analysis", "Bow Tie Analysis"],
  "Causal Loop Mapping": ["Causal Loop Diagramming", "Causal Loop Diagram"],
  "Alternative Futures Analysis": ["Exploratory Scenarios", "Scenario Planning"],
  "Minimax Regret": ["Minimax Regret Analysis"],
  "Efficiency Imperative Audit": ["Ellul Technique Audit", "Technique Imperative Audit"],
  "Technological System Autonomy Analysis": ["Ellul Technological System Analysis", "Technical System Autonomy"],
  "Propaganda Environment Analysis": ["Ellul Propaganda Analysis"],
  "Agitation–Integration Propaganda Analysis": ["Agitation Propaganda Analysis", "Integration Propaganda Analysis"],
  "Fragility / Antifragility Stress Test": ["Antifragility Analysis", "Fragility Analysis"],
  "Fat-Tail Exposure Audit": ["Fat Tail Risk Audit", "Heavy-Tail Exposure Audit"],
  "Via Negativa Intervention Review": ["Via Negativa Analysis"],
  "Skin-in-the-Game Incentive Audit": ["Skin in the Game Analysis"],
  "Serial Optionality Review": ["Optionality Review"],
  "Barbell Exposure Analysis": ["Barbell Strategy Analysis"],
  "Strategic Commitment Analysis": ["Schelling Commitment Analysis"],
  "Focal-Point Coordination Analysis": ["Schelling Point Analysis", "Focal Point Analysis"],
  "Commons Governance Design Audit": ["Ostrom Design Principles Audit"],
  "Polycentric Governance Analysis": ["Ostrom Polycentric Governance Analysis"],
  "Requisite Variety Analysis": ["Law of Requisite Variety Analysis", "Ashby Requisite Variety"],
  "Viable System Model Diagnosis": ["VSM Diagnosis", "Stafford Beer Viable System Model"],
  "OODA Decision-Cycle Analysis": ["OODA Loop Analysis", "Boyd OODA Loop", "Observe Orient Decide Act"],
  "Bounded Rationality / Satisficing Audit": ["Bounded Rationality Audit", "Satisficing Analysis", "Simon Satisficing"],
  "Recognition-Primed Decision Audit": ["Recognition Primed Decision", "RPD Model", "Klein RPD"],
  "Interactive Complexity / Tight-Coupling Audit": ["Normal Accident Analysis", "Perrow Normal Accident Audit", "Tight Coupling Analysis"],
  "Legibility / Local-Knowledge Audit": ["Seeing Like a State Audit", "Scott Legibility Audit", "Metis Audit"],
  "Exit–Voice–Loyalty Analysis": ["Exit Voice Loyalty", "Hirschman Analysis"],
  "Goodhart–Campbell Metric Gaming Audit": ["Goodhart's Law Audit", "Campbell's Law Audit", "Metric Gaming Audit"],
  "Analysis of Competing Hypotheses (ACH)": ["ACH"], "Failure Mode and Effects Analysis (FMEA)": ["FMEA"],
  "Hazard and Operability Study": ["HAZOP"], "Systems-Theoretic Process Analysis": ["STPA"],
  "Analytic Hierarchy Process": ["AHP"], "Technique for Order Preference by Similarity to Ideal Solution": ["TOPSIS"],
  "MITRE ATT&CK Mapping": ["ATT&CK", "MITRE ATTACK"], "LINDDUN Privacy Threat Modeling": ["LINDDUN"],
  "PASTA Threat Modeling": ["PASTA"], "Causal Diagramming with DAGs": ["DAG", "DAGs"],
  "Difference-in-Differences": ["DiD"], "Randomized Controlled Trial Design": ["RCT"], "Interpretative Phenomenological Analysis": ["IPA"],
  "Principal Component Analysis": ["PCA"], "Getis-Ord Gi* Analysis": ["Gi*", "Getis Ord"], "Moran's I Analysis": ["Moran I"],
  "IRAC Analysis": ["IRAC"], "CREAC Analysis": ["CREAC"], "DMAIC": ["Six Sigma DMAIC"], "DMADV": ["Six Sigma DMADV"],
  "Jobs-to-be-Done Analysis": ["JTBD"], "Management Oversight and Risk Tree Analysis": ["MORT"], "A3 Problem Solving": ["A3"],
};

const STOPWORDS = new Set(["and", "of", "the", "to", "with", "for", "in", "by", "a", "an"]);
function automaticAcronym(name: string): string | null {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean).filter((word) => !STOPWORDS.has(word.toLowerCase()));
  if (words.length < 2 || words.length > 6) return null;
  const acronym = words.map((word) => word[0]?.toUpperCase()).join("");
  return acronym.length >= 2 && acronym.length <= 6 ? acronym : null;
}
function aliasesFor(name: string): string[] {
  const aliases = new Set([...retiredAliasesFor(name), ...(EXPLICIT_ALIASES[name] ?? [])]);
  const acronym = automaticAcronym(name); if (acronym && acronym.toLowerCase() !== name.toLowerCase()) aliases.add(acronym);
  return [...aliases];
}
const EXTENDED_TERMS = /systematic|meta-|network meta|simulation|experiment|randomized|multilevel|survival|ethnograph|prosopograph|bibliometric|agent-based|system dynamics|historical method|oral history/i;
const QUICK_TERMS = /check|checklist|five whys|pros-cons|brainstorm|crazy eights|starburst|scamper|six thinking hats|premortem|pre-mortem|customer checklist/i;
function effortFor(name: string): TechniqueEffort {
  if (EXTENDED_TERMS.test(name)) return "extended";
  if (QUICK_TERMS.test(name)) return "quick";
  return "moderate";
}
function evidenceFor(family: TechniqueFamily, name: string): TechniqueEvidenceRequirement {
  if (/brainstorm|six thinking hats|crazy eights|how-might-we|scenario|cone of plausibility|futures wheel/i.test(name)) return "light";
  if (["research", "security", "safety", "geospatial", "economics", "legal", "religious-studies", "literary"].includes(family)) return "substantial";
  if (["intelligence", "forecasting", "systems", "operations-research", "quality", "policy"].includes(family)) return "moderate";
  return "light";
}
function outputsFor(family: TechniqueFamily, name: string): TechniqueOutputType[] {
  if (/fragility|fat-tail|fat tail|interactive complexity|tight-coupling|tight coupling/i.test(name)) return ["risk profile"];
  if (/serial optionality|barbell exposure|via negativa|bounded rationality|satisficing|recognition-primed|ooda/i.test(name)) return ["decision"];
  if (/strategic commitment|focal-point|focal point/i.test(name)) return ["model", "decision"];
  if (/propaganda environment|agitation.*integration propaganda|efficiency imperative|technological system autonomy|requisite variety|viable system model|legibility|local-knowledge/i.test(name)) return ["map", "review"];
  if (/commons governance|polycentric governance|skin-in-the-game|skin in the game|exit.*voice.*loyalty|goodhart|campbell|metric gaming/i.test(name)) return ["review", "decision"];
  if (/matrix|pairwise|corroboration|discriminating|source validation/i.test(name)) return ["matrix"];
  if (/network|link analysis|structural hole|centrality|clique|broker/i.test(name)) return ["network", "map"];
  if (/timeline|chronolog|sequence/i.test(name)) return ["timeline"];
  if (/scenario|futures|backcasting|cone of plausibility/i.test(name)) return ["scenario"];
  if (/risk|hazard|bowtie|bow-tie|fmea|hazop|alarp/i.test(name)) return ["risk profile"];
  if (/ranking|topsis|vikor|electre|promethee|ahp|analytic hierarchy|scoring|priorit/i.test(name)) return ["ranking", "decision"];
  if (/regression|analysis$|model|simulation|programming|markov|queueing/i.test(name) && ["research","economics","operations-research"].includes(family)) return ["model", "estimate"];
  if (/review|synthesis|meta-analysis|bibliometric/i.test(name)) return ["review"];
  if (/coding|thematic|content analysis|grounded theory|ethnograph/i.test(name)) return ["coded corpus", "narrative"];
  if (["literary", "religious-studies", "legal"].includes(family)) return ["narrative"];
  if (["decision", "policy"].includes(family)) return ["decision"];
  return ["checklist"];
}
const CURATED_RELATIONSHIPS: Record<string, { useBefore?: string[]; useAfter?: string[]; alternatives?: string[] }> = {
  "Analysis of Competing Hypotheses (ACH)": { useBefore: ["Key Assumptions Check", "Multiple Hypotheses Generation"], useAfter: ["Signpost-to-Scenario Mapping", "Red Team Analysis"], alternatives: ["Discriminating Evidence Matrix"] },
  "Analytic Hierarchy Process": { useAfter: ["Sensitivity Analysis"], alternatives: ["TOPSIS", "ELECTRE", "PROMETHEE"] },
  "Reference Class Forecasting": { useAfter: ["Sensitivity Analysis", "Brier Score Review"], alternatives: ["Structured Analogies", "Structured Expert Judgment"] },
  "MITRE ATT&CK Mapping": { useBefore: ["Incident Reconstruction"], useAfter: ["Hypothesis-Driven Investigation"], alternatives: ["Diamond Model Analysis", "Cyber Kill Chain Mapping"] },
  "LINDDUN Privacy Threat Modeling": { useAfter: ["Risk Matrix Analysis"], alternatives: ["PASTA Threat Modeling", "Attack Surface Analysis"] },
  "Systems-Theoretic Process Analysis": { useAfter: ["Barrier Analysis"], alternatives: ["Preliminary Hazard Analysis", "Hazard and Operability Study"] },
  "Systematic Review": { useAfter: ["Meta-Analysis", "Narrative Synthesis"], alternatives: ["Scoping Review", "Rapid Review"] },
  "Scoping Review": { useAfter: ["Systematic Review"], alternatives: ["Rapid Review", "Evidence Gap Map"] },
  "Causal Diagramming with DAGs": { useAfter: ["Backdoor Criterion Review", "Sensitivity Analysis"], alternatives: ["Process Tracing"] },
  "Difference-in-Differences": { useAfter: ["Sensitivity Analysis"], alternatives: ["Interrupted Time-Series Analysis", "Synthetic Control"] },
  "Key Assumptions Check": { useAfter: ["Analysis of Competing Hypotheses (ACH)", "Red Team Analysis"], alternatives: ["Assumption Reversal"] },
  "Red Team Analysis": { useBefore: ["Key Assumptions Check"], useAfter: ["Signpost-to-Scenario Mapping"], alternatives: ["Devil's Advocacy", "Murder Board"] },
  "Signpost-to-Scenario Mapping": { useBefore: ["Alternative Futures Analysis"], useAfter: ["Early Warning Dashboard Design"], alternatives: ["Leading Indicator Analysis"] },
  "Structured Expert Judgment": { useAfter: ["Brier Score Review"], alternatives: ["Delphi Method", "Prediction Market Design"] },
  "Sensitivity Analysis": { alternatives: ["Alternative Futures Analysis", "Robust Decision Making"] },
  "Value of Information": { useBefore: ["Decision Tree Analysis"], useAfter: ["Collection Gap Analysis"], alternatives: ["Expected Utility Analysis"] },
  "PASTA Threat Modeling": { useAfter: ["Risk Matrix Analysis", "MITRE ATT&CK Mapping"], alternatives: ["LINDDUN Privacy Threat Modeling", "Attack Surface Analysis"] },
  "Preliminary Hazard Analysis": { useAfter: ["Failure Mode and Effects Analysis (FMEA)", "Bow-Tie Analysis"], alternatives: ["Hazard and Operability Study"] },
  "Bow-Tie Analysis": { useBefore: ["Preliminary Hazard Analysis"], useAfter: ["Barrier Analysis"], alternatives: ["Cause-Consequence Analysis"] },
  "Meta-Analysis": { useBefore: ["Systematic Review"], useAfter: ["Meta-Regression"], alternatives: ["Narrative Synthesis"] },
  "Process Tracing": { useAfter: ["Contribution Analysis"], alternatives: ["Causal Diagramming with DAGs"] },
  "Social Network Analysis": { useAfter: ["Betweenness Centrality Review", "Broker and Gatekeeper Analysis"], alternatives: ["Link Analysis"] },
  "Efficiency Imperative Audit": { useAfter: ["Technological System Autonomy Analysis", "Leverage Points Analysis"], alternatives: ["Boundary Critique"] },
  "Technological System Autonomy Analysis": { useBefore: ["Efficiency Imperative Audit"], useAfter: ["Path Dependence Analysis"], alternatives: ["Causal Loop Mapping"] },
  "Propaganda Environment Analysis": { useAfter: ["Agitation–Integration Propaganda Analysis", "Critical Media Analysis"], alternatives: ["Framing Analysis"] },
  "Fat-Tail Exposure Audit": { useAfter: ["Fragility / Antifragility Stress Test", "Barbell Exposure Analysis"], alternatives: ["Monte Carlo Simulation Review"] },
  "Fragility / Antifragility Stress Test": { useBefore: ["Fat-Tail Exposure Audit"], useAfter: ["Barbell Exposure Analysis", "Via Negativa Intervention Review"], alternatives: ["Resilience Engineering Review"] },
  "Serial Optionality Review": { useAfter: ["Barbell Exposure Analysis"], alternatives: ["Real Options Analysis", "Robust Decision Making"] },
  "Strategic Commitment Analysis": { useAfter: ["Focal-Point Coordination Analysis"], alternatives: ["Game-Theoretic Payoff Matrix"] },
  "Commons Governance Design Audit": { useAfter: ["Polycentric Governance Analysis"], alternatives: ["Stakeholder Analysis"] },
  "Requisite Variety Analysis": { useAfter: ["Viable System Model Diagnosis"], alternatives: ["Causal Loop Mapping"] },
  "Viable System Model Diagnosis": { useBefore: ["Requisite Variety Analysis"], useAfter: ["Polycentric Governance Analysis"], alternatives: ["System Dynamics Simulation Design"] },
  "OODA Decision-Cycle Analysis": { useAfter: ["Recognition-Primed Decision Audit"], alternatives: ["Decision Tree Analysis"] },
  "Bounded Rationality / Satisficing Audit": { useAfter: ["Sensitivity Analysis"], alternatives: ["Decision Matrix", "Analytic Hierarchy Process"] },
  "Recognition-Primed Decision Audit": { useBefore: ["OODA Decision-Cycle Analysis"], alternatives: ["Decision Tree Analysis", "Premortem Analysis"] },
  "Interactive Complexity / Tight-Coupling Audit": { useAfter: ["Resilience Engineering Review", "Systems-Theoretic Process Analysis"], alternatives: ["Functional Resonance Analysis Method"] },
  "Legibility / Local-Knowledge Audit": { useAfter: ["Stakeholder Consultation Analysis", "Polycentric Governance Analysis"], alternatives: ["Boundary Critique"] },
  "Exit–Voice–Loyalty Analysis": { useAfter: ["Stakeholder Analysis"], alternatives: ["Stakeholder Network Mapping"] },
  "Goodhart–Campbell Metric Gaming Audit": { useAfter: ["Measurement System Analysis"], alternatives: ["Skin-in-the-Game Incentive Audit"] },
};

const TASK_RECOMMENDATIONS: Record<TechniqueTaskId, TechniqueTaskRecommendation[]> = {
  frame: [{ name: "Key Intelligence Questions", role: "Turn a broad problem into decision-relevant questions." }, { name: "Problem Restatement", role: "Reframe the problem before committing to its initial formulation." }, { name: "Question Decomposition", role: "Break the problem into tractable analytic components." }, { name: "Stakeholder Analysis", role: "Expose actors, interests, influence, and affected parties." }, { name: "Intelligence Requirements Mapping", role: "Translate the problem into explicit analytic requirements." }, { name: "Legibility / Local-Knowledge Audit", role: "Check whether the framing erases local practice, exceptions, or tacit knowledge that materially changes the problem." }],
  "evaluate-evidence": [{ name: "Source Reliability Assessment", role: "Judge source access, track record, incentives, and vulnerability to error." }, { name: "Information Credibility Assessment", role: "Assess the credibility of a specific information item." }, { name: "Corroboration Matrix", role: "Separate independent corroboration from repeated or circular reporting." }, { name: "Discriminating Evidence Matrix", role: "Identify evidence that actually separates competing explanations." }, { name: "Missing Evidence Analysis", role: "Reason from evidence that should exist but is absent." }],
  "compare-hypotheses": [{ name: "Analysis of Competing Hypotheses (ACH)", role: "Systematically compare multiple explanations against diagnostic evidence." }, { name: "Discriminating Evidence Matrix", role: "Focus comparison on evidence with the greatest diagnostic value." }, { name: "Multiple Hypotheses Generation", role: "Expand the plausible explanation set before evaluating it." }, { name: "Null Hypothesis Challenge", role: "Test whether the favored explanation is needed at all." }, { name: "Process Tracing", role: "Test competing causal mechanisms within a case." }],
  challenge: [{ name: "Key Assumptions Check", role: "Expose assumptions whose failure would change the judgment." }, { name: "Red Team Analysis", role: "Apply an independent adversarial perspective to the reasoning." }, { name: "Devil's Advocacy", role: "Construct the strongest case against the prevailing judgment." }, { name: "Premortem Analysis", role: "Assume failure occurred and work backward to plausible causes." }, { name: "Cognitive Bias Audit", role: "Inspect the reasoning process for predictable cognitive distortions." }, { name: "Goodhart–Campbell Metric Gaming Audit", role: "Challenge judgments that depend on performance measures by testing whether incentives have corrupted the proxy or displaced the underlying objective." }],
  forecast: [{ name: "Reference Class Forecasting", role: "Anchor estimates in comparable historical outcomes and base rates." }, { name: "Structured Expert Judgment", role: "Elicit and aggregate expert estimates with explicit uncertainty." }, { name: "Alternative Futures Analysis", role: "Represent materially different future pathways and conditions without collapsing uncertainty into one forecast." }, { name: "Signpost-to-Scenario Mapping", role: "Define observable evidence that distinguishes emerging futures." }, { name: "Brier Score Review", role: "Calibrate forecasting performance using resolved probability judgments." }],
  "compare-options": [{ name: "Analytic Hierarchy Process", role: "Structure a multi-criteria choice with explicit pairwise judgments." }, { name: "TOPSIS", role: "Rank options by distance from ideal and anti-ideal outcomes." }, { name: "ELECTRE", role: "Compare options using outranking where tradeoffs are not fully compensatory." }, { name: "Cost-Benefit Analysis", role: "Compare monetizable and non-monetizable consequences against a baseline." }, { name: "Sensitivity Analysis", role: "Test whether the preferred option survives plausible assumption changes." }, { name: "Bounded Rationality / Satisficing Audit", role: "Test whether the option search and stopping rule are realistic when time, attention, and information are constrained." }],
  causal: [{ name: "Causal Diagramming with DAGs", role: "Make causal assumptions explicit and identify adjustment logic." }, { name: "Process Tracing", role: "Test whether the proposed causal mechanism appears in the case evidence." }, { name: "Difference-in-Differences", role: "Estimate an intervention effect from treated-versus-comparison changes over time." }, { name: "Instrumental Variables", role: "Estimate causal effects when a defensible instrument addresses confounding." }, { name: "Contribution Analysis", role: "Assess how strongly an intervention contributed to an observed outcome." }],
  "investigate-network": [{ name: "Social Network Analysis", role: "Characterize overall network structure, cohesion, centrality, and communities." }, { name: "Link Analysis", role: "Map entities and relationships to reveal connected activity." }, { name: "Ego Network Analysis", role: "Examine the immediate relational environment around a focal actor." }, { name: "Broker and Gatekeeper Analysis", role: "Identify actors controlling or bridging flows between groups." }, { name: "Structural Hole Analysis", role: "Find brokerage opportunities created by disconnected parts of a network." }],
  "threat-risk": [{ name: "MITRE ATT&CK Mapping", role: "Map observed adversary behavior to concrete tactics and techniques." }, { name: "PASTA Threat Modeling", role: "Connect business impact, technical attack paths, and controls." }, { name: "Preliminary Hazard Analysis", role: "Identify hazards early before detailed system analysis." }, { name: "Bow-Tie Analysis", role: "Connect causes, top events, consequences, and preventive or mitigative barriers." }, { name: "Risk Matrix Analysis", role: "Prioritize identified risks using an explicit severity-likelihood scheme." }, { name: "Interactive Complexity / Tight-Coupling Audit", role: "Identify risks created by unexpected interactions, compressed response time, and insufficient slack that component-by-component analysis can miss." }],
  "synthesize-research": [{ name: "Systematic Review", role: "Answer a focused question with reproducible search, appraisal, and synthesis." }, { name: "Scoping Review", role: "Map the breadth, concepts, and evidence gaps in a field." }, { name: "Meta-Analysis", role: "Pool compatible quantitative effects and assess heterogeneity." }, { name: "Qualitative Evidence Synthesis", role: "Integrate qualitative findings while preserving interpretive context." }, { name: "Evidence Gap Map", role: "Show where evidence is concentrated, sparse, or absent." }],
  "improve-process": [{ name: "DMAIC", role: "Run a disciplined define-measure-analyze-improve-control cycle." }, { name: "A3 Problem Solving", role: "Condense problem definition, causal reasoning, countermeasures, and follow-up." }, { name: "Five Whys", role: "Rapidly probe successive causal explanations for a problem." }, { name: "Control Chart Analysis", role: "Distinguish common-cause variation from special-cause signals." }, { name: "Process Capability Analysis", role: "Compare process variation against required specification limits." }, { name: "Goodhart–Campbell Metric Gaming Audit", role: "Check whether process targets are creating gaming, classification shifts, or local optimization before treating the measured result as genuine improvement." }],
  "interpret-context": [{ name: "Rhetorical Criticism", role: "Analyze how a communication persuades, positions audiences, and produces effects." }, { name: "Framing Analysis", role: "Identify how selection and emphasis shape interpretation." }, { name: "Historical Method", role: "Evaluate claims through source criticism, context, chronology, and corroboration." }, { name: "Contextualization", role: "Interpret an artifact within its social, political, and historical setting." }, { name: "Critical Media Analysis", role: "Examine media representation, power, ideology, and omission." }],
};

const CURATED_PREREQUISITES: Record<string, string[]> = {
  "Key Assumptions Check": ["A current judgment or line of reasoning", "Explicit and implicit assumptions that can be challenged", "A decision about which assumptions are load-bearing"],
  "Red Team Analysis": ["A sufficiently developed baseline judgment or plan", "An independent challenger or deliberately separated perspective", "Access to the evidence and assumptions supporting the baseline"],
  "Signpost-to-Scenario Mapping": ["Defined scenarios or competing future states", "Observable developments that would distinguish those futures", "A monitoring cadence and ownership for indicators"],
  "Brier Score Review": ["Resolved probabilistic forecasts", "Original stated probabilities preserved before resolution", "Outcome coding rules applied consistently"],
  "Analysis of Competing Hypotheses (ACH)": ["At least two plausible hypotheses", "Evidence items with source provenance", "Analyst willingness to retain disconfirming evidence"],
  "Reference Class Forecasting": ["A clearly defined forecast target", "A defensible comparison class", "Historical outcomes for that class"],
  "Structured Expert Judgment": ["Well-specified elicitation questions", "Independent experts or estimators", "A plan for uncertainty capture and aggregation"],
  "Analytic Hierarchy Process": ["Defined alternatives", "Explicit decision criteria", "Decision-maker judgments for pairwise comparisons"],
  "MITRE ATT&CK Mapping": ["Observed adversary behaviors", "Evidence links for mapped behaviors", "Defined incident or campaign scope"],
  "LINDDUN Privacy Threat Modeling": ["System or data-flow representation", "Defined privacy scope", "Identified data subjects and interactions"],
  "Systems-Theoretic Process Analysis": ["Defined unacceptable losses", "System-level hazards", "Control structure with controllers, feedback, and controlled processes"],
  "Systematic Review": ["Focused review question", "Predefined eligibility criteria", "Reproducible search and screening plan"],
  "Meta-Analysis": ["Eligible studies from a systematic evidence set", "Comparable effect measures", "Study-level uncertainty estimates"],
  "Causal Diagramming with DAGs": ["Defined exposure and outcome", "Substantive causal assumptions", "Relevant measured and unmeasured variables"],
  "Difference-in-Differences": ["Treated and comparison groups", "Known intervention timing", "Pre-treatment outcome history sufficient to assess parallel trends"],
  "Social Network Analysis": ["Explicit node and tie definitions", "Network boundary", "Relationship data with direction/weight/time decisions documented"],
  "DMAIC": ["A measurable existing process problem", "Defined customer or mission requirements", "Baseline process data and an accountable process owner"],
  "Failure Mode and Effects Analysis (FMEA)": ["Defined product, process, or service scope", "Known functions or process steps", "A cross-functional team able to judge failure effects and controls"],
  "Five Whys": ["A specific observable problem statement", "Participants with direct process knowledge", "Willingness to verify proposed causes rather than stop at plausible stories"],
  "Control Chart Analysis": ["Time-ordered process data", "A rational subgrouping or sampling plan", "A chart type appropriate to the measurement scale"],
  "Process Capability Analysis": ["A statistically stable process", "Specification limits", "Representative measurement data with an adequate measurement system"],
  "Hazard and Operability Study": ["Defined process or system design", "Current diagrams or process descriptions", "A multidisciplinary team and agreed guide words/deviation logic"],
  "OODA Decision-Cycle Analysis": ["A time-sensitive decision environment", "Observable feedback from the environment or adversary", "A defined actor whose observation-orientation-decision-action cycle can be examined"],
  "Bounded Rationality / Satisficing Audit": ["A concrete decision with real time or attention constraints", "Known or inferable search and stopping behavior", "A threshold for what counts as an acceptable option"],
  "Recognition-Primed Decision Audit": ["A time-pressured decision", "A decision-maker with relevant experience", "Enough situational detail to test recognized patterns through mental simulation"],
  "Interactive Complexity / Tight-Coupling Audit": ["A defined socio-technical system", "Known interactions, dependencies, buffers, and timing constraints", "A consequential failure or hazard to trace through the system"],
  "Legibility / Local-Knowledge Audit": ["A policy, model, classification, or administrative scheme", "Access to both formal representations and local practice", "Affected actors able to identify tacit knowledge, exceptions, or workarounds"],
  "Exit–Voice–Loyalty Analysis": ["A deteriorating organization, service, relationship, or institution", "Identifiable participants or stakeholder groups", "Observable or plausible exit, complaint, reform, and loyalty behaviors"],
  "Goodhart–Campbell Metric Gaming Audit": ["A substantive goal", "One or more metrics used to judge or reward performance", "Enough process knowledge to identify adaptation, gaming, classification, or displacement pathways"],
};

export const TECHNIQUE_PLAYBOOKS: ReadonlyArray<TechniquePlaybook> = [
  { id: "hypothesis-test", label: "Test competing explanations", description: "Generate, compare, challenge, and monitor serious competing hypotheses.", steps: [{ name: "Analysis of Competing Hypotheses (ACH)", role: "Compare hypotheses against diagnostic evidence." }, { name: "Discriminating Evidence Matrix", role: "Focus attention on evidence that separates explanations." }, { name: "Null Hypothesis Challenge", role: "Test whether the favored explanation is actually necessary." }, { name: "Process Tracing", role: "Examine whether the proposed causal mechanism appears in the case evidence." }] },
  { id: "warning", label: "Build a warning assessment", description: "Move from broad change signals to alternative futures and explicit monitoring logic.", steps: [{ name: "Environmental Scanning", role: "Collect weak signals, emerging issues, and peripheral developments." }, { name: "Scenario Discovery", role: "Identify combinations of uncertainties associated with important outcomes." }, { name: "Signpost-to-Scenario Mapping", role: "Connect observable developments to movement among scenarios." }, { name: "Backcasting", role: "Work backward from consequential futures to milestones and present requirements." }] },
  { id: "forecast", label: "Produce and calibrate a forecast", description: "Frame uncertainty, estimate outcomes, explore alternative futures, and score performance.", steps: [{ name: "Structured Expert Judgment", role: "Elicit explicit estimates and uncertainty from informed judgments." }, { name: "Scenario Discovery", role: "Identify combinations of uncertainties that drive materially different outcomes." }, { name: "Environmental Scanning", role: "Maintain awareness of developments that should update the forecast." }, { name: "Brier Score Review", role: "Score and calibrate resolved probabilistic forecasts." }] },
  { id: "cyber-investigation", label: "Investigate a cyber incident", description: "Reconstruct activity, map behaviors, test explanations, and identify next collection steps.", steps: [{ name: "Incident Reconstruction", role: "Build the best-supported timeline and causal sequence." }, { name: "MITRE ATT&CK Mapping", role: "Map supported adversary behaviors to tactics and techniques." }, { name: "Diamond Model Analysis", role: "Pivot among adversary, capability, infrastructure, and victim evidence." }, { name: "Hypothesis-Driven Investigation", role: "Test competing explanations and prioritize evidence collection." }] },
  { id: "safety", label: "Assess system safety risk", description: "Identify system hazards, controls, organizational causes, and residual risk.", steps: [{ name: "Systems-Theoretic Process Analysis", role: "Identify unsafe control actions and loss scenarios." }, { name: "Risk Matrix Analysis", role: "Prioritize hazards using explicit severity and likelihood criteria." }, { name: "AcciMap", role: "Trace causal influences across technical and organizational levels." }, { name: "Tripod Beta", role: "Distinguish immediate failures from latent organizational conditions." }] },
  { id: "decision", label: "Compare and stress-test options", description: "Rank alternatives, model uncertainty, and test robustness before commitment.", steps: [{ name: "TOPSIS", role: "Rank alternatives by distance from ideal and anti-ideal outcomes." }, { name: "ELECTRE", role: "Test outranking where tradeoffs are not fully compensatory." }, { name: "Expected Utility Analysis", role: "Compare options under uncertain outcomes and explicit values." }, { name: "Sensitivity Analysis", role: "Test whether the preferred option survives plausible changes." }] },
  { id: "research", label: "Synthesize a research base", description: "Map, review, synthesize, and explain a body of evidence.", steps: [{ name: "Scoping Review", role: "Map concepts, study types, and evidence gaps." }, { name: "Systematic Review", role: "Apply reproducible eligibility, search, appraisal, and synthesis." }, { name: "Meta-Analysis", role: "Pool compatible quantitative effects when appropriate." }, { name: "Narrative Synthesis", role: "Integrate findings that cannot be validly pooled." }] },
  { id: "network", label: "Investigate an actor network", description: "Define relationships, identify brokers, and locate structural vulnerabilities.", steps: [{ name: "Link Analysis", role: "Establish entities and observed relationships." }, { name: "Betweenness Centrality Review", role: "Identify nodes positioned on many shortest paths." }, { name: "Broker and Gatekeeper Analysis", role: "Assess actors controlling flows between groups." }, { name: "Structural Hole Analysis", role: "Find brokerage positions created by disconnected network regions." }] },
  { id: "rapid-operational-decision", label: "Make a rapid operational decision", description: "Orient quickly, exploit expert recognition, challenge the first plausible action, and preserve learning under time pressure.", steps: [{ name: "OODA Decision-Cycle Analysis", role: "Diagnose observation, orientation, tempo, and feedback before acting under pressure." }, { name: "Recognition-Primed Decision Audit", role: "Test whether an experienced decision-maker's first plausible action survives mental simulation." }, { name: "Premortem Analysis", role: "Expose failure mechanisms that rapid recognition may have overlooked before commitment." }, { name: "After-Action Review", role: "Capture what actually happened and feed the result back into future recognition and orientation." }] },
  { id: "complex-system-failure", label: "Assess complex-system failure risk", description: "Diagnose structural accident susceptibility, control limits, hazards, and resilience rather than stopping at component failure.", steps: [{ name: "Interactive Complexity / Tight-Coupling Audit", role: "Determine whether unexpected interactions and limited slack make failure intrinsically hard to control." }, { name: "Requisite Variety Analysis", role: "Test whether sensing and response capacity can match the range of disturbances the system can generate." }, { name: "Systems-Theoretic Process Analysis", role: "Trace unsafe control actions and system-level loss scenarios across the control structure." }, { name: "Resilience Engineering Review", role: "Assess adaptive capacity, graceful degradation, recovery resources, and resilience under disturbed conditions." }] },
  { id: "metrics-and-incentives", label: "Audit metrics and incentives", description: "Check whether measurement and accountability systems are driving gaming, displaced goals, or asymmetric risk-taking.", steps: [{ name: "Goodhart–Campbell Metric Gaming Audit", role: "Identify how target pressure can corrupt a proxy and displace the substantive objective." }, { name: "Skin-in-the-Game Incentive Audit", role: "Map who receives upside, who bears downside, and where decision influence is detached from consequences." }, { name: "Measurement System Analysis", role: "Test whether the measurement process itself is stable, repeatable, and capable of supporting the decisions placed on it." }, { name: "Exit–Voice–Loyalty Analysis", role: "Examine whether participants can surface metric failures through voice or instead respond through exit, silence, or loyalty." }] },
  { id: "governance-under-complexity", label: "Design governance under complexity", description: "Preserve local knowledge, test institutional feedback, and design governance that works across multiple centers and scales.", steps: [{ name: "Legibility / Local-Knowledge Audit", role: "Identify what administrative simplification hides or destroys before redesigning the system." }, { name: "Commons Governance Design Audit", role: "Test boundaries, participation, monitoring, sanctions, conflict resolution, and local rule fit." }, { name: "Polycentric Governance Analysis", role: "Map overlapping decision centers and assess scale fit, redundancy, coordination, and autonomy." }, { name: "Exit–Voice–Loyalty Analysis", role: "Check whether participants have credible feedback and correction channels when governance performance declines." }] },
];

const CURATED_REFERENCES: Record<string, TechniqueReference[]> = {
  "Analysis of Competing Hypotheses (ACH)": [{ label: "CIA Tradecraft Primer", href: "https://www.cia.gov/resources/csi/books-monographs/a-tradecraft-primer/" }],
  "Key Assumptions Check": [{ label: "CIA Tradecraft Primer", href: "https://www.cia.gov/resources/csi/books-monographs/a-tradecraft-primer/" }],
  "Red Team Analysis": [{ label: "CIA Tradecraft Primer", href: "https://www.cia.gov/resources/csi/books-monographs/a-tradecraft-primer/" }],
  "Devil's Advocacy": [{ label: "CIA Tradecraft Primer", href: "https://www.cia.gov/resources/csi/books-monographs/a-tradecraft-primer/" }],
  "Signpost-to-Scenario Mapping": [{ label: "CIA Tradecraft Primer", href: "https://www.cia.gov/resources/csi/books-monographs/a-tradecraft-primer/" }],
  "MITRE ATT&CK Mapping": [{ label: "MITRE ATT&CK", href: "https://attack.mitre.org/" }],
  "LINDDUN Privacy Threat Modeling": [{ label: "LINDDUN", href: "https://linddun.org/" }],
  "Systems-Theoretic Process Analysis": [{ label: "MIT PSASS STPA Handbook", href: "https://psas.scripts.mit.edu/home/books-and-handbooks/" }],
  "Hazard and Operability Study": [{ label: "UK HSE HAZOP guidance", href: "https://www.hse.gov.uk/comah/sragtech/techmeasplantmod.htm" }],
  "Preliminary Hazard Analysis": [{ label: "UK HSE hazard guidance", href: "https://www.hse.gov.uk/comah/sragtech/techmeasplantmod.htm" }],
  "Difference-in-Differences": [{ label: "CDC Stacks DiD reference", href: "https://stacks.cdc.gov/view/cdc/207936" }],
  "Systematic Review": [{ label: "PRISMA 2020", href: "https://www.prisma-statement.org/" }, { label: "WHO systematic review training", href: "https://www.emro.who.int/evidence-data-to-policy/training-package/systematic-reviews.html" }],
  "Meta-Analysis": [{ label: "PRISMA 2020", href: "https://www.prisma-statement.org/" }, { label: "WHO systematic review training", href: "https://www.emro.who.int/evidence-data-to-policy/training-package/systematic-reviews.html" }],
  "Scoping Review": [{ label: "PRISMA-ScR", href: "https://www.prisma-statement.org/scoping" }],
  "DMAIC": [{ label: "ASQ DMAIC", href: "https://asq.org/quality-resources/dmaic" }],
  "Failure Mode and Effects Analysis (FMEA)": [{ label: "ASQ FMEA", href: "https://asq.org/quality-resources/fmea" }],
  "Five Whys": [{ label: "ASQ Five Whys", href: "https://asq.org/quality-resources/five-whys" }],
  "Control Chart Analysis": [{ label: "ASQ Control Chart", href: "https://asq.org/quality-resources/control-chart" }],
  "Process Capability Analysis": [{ label: "ASQ Process Capability", href: "https://asq.org/quality-resources/process-capability" }],
  "Efficiency Imperative Audit": [{ label: "International Jacques Ellul Society — Ellul and Technique", href: "https://ellul.org/themes/ellul-and-technique/" }],
  "Technological System Autonomy Analysis": [{ label: "International Jacques Ellul Society — Ellul and Technique", href: "https://ellul.org/themes/ellul-and-technique/" }],
  "Propaganda Environment Analysis": [{ label: "International Jacques Ellul Society — Propaganda overview", href: "https://ellul.org/legacy/featured-books-by-ellul/" }],
  "Agitation–Integration Propaganda Analysis": [{ label: "International Jacques Ellul Society — Propaganda overview", href: "https://ellul.org/legacy/featured-books-by-ellul/" }],
  "Fragility / Antifragility Stress Test": [{ label: "Taleb & Douady — Mathematical Definition and Mapping of (Anti)Fragility", href: "https://arxiv.org/abs/1208.1189" }],
  "Fat-Tail Exposure Audit": [{ label: "Taleb — Incerto / Statistical Consequences of Fat Tails", href: "https://www.fooledbyrandomness.com/incerto.pdf" }],
  "Via Negativa Intervention Review": [{ label: "Taleb — Incerto", href: "https://www.fooledbyrandomness.com/incerto.pdf" }],
  "Skin-in-the-Game Incentive Audit": [{ label: "Taleb — Skin in the Game", href: "https://www.fooledbyrandomness.com/incerto.pdf" }],
  "Serial Optionality Review": [{ label: "Taleb — Convexity and Science", href: "https://www.fooledbyrandomness.com/ConvexityScience.pdf" }],
  "Barbell Exposure Analysis": [{ label: "Taleb — Antifragility / barbell and optionality material", href: "https://www.fooledbyrandomness.com/education.pdf" }],
  "Strategic Commitment Analysis": [{ label: "Nobel Prize — Schelling on commitment and conflict", href: "https://www.nobelprize.org/prizes/economic-sciences/2005/ceremony-speech/" }],
  "Focal-Point Coordination Analysis": [{ label: "Nobel Prize — Schelling and strategic coordination", href: "https://www.nobelprize.org/uploads/2018/06/popular-economicsciences2005.pdf" }],
  "Commons Governance Design Audit": [{ label: "Ostrom Workshop — Design Principles", href: "https://ostromworkshop.indiana.edu/courses-teaching/teaching-tools/ostrom-design/index.html" }],
  "Polycentric Governance Analysis": [{ label: "Ostrom Workshop — Teaching Tools", href: "https://ostromworkshop.indiana.edu/courses-teaching/teaching-tools/index.html" }],
  "Requisite Variety Analysis": [{ label: "W. Ross Ashby — An Introduction to Cybernetics", href: "https://ashby.info/Ashby-Introduction-to-Cybernetics.pdf" }],
  "Viable System Model Diagnosis": [{ label: "Metaphorum — Viable System Model", href: "https://metaphorum.org/staffords-work/viable-system-model" }],
  "OODA Decision-Cycle Analysis": [{ label: "Air University Press — Boyd, A Discourse on Winning and Losing", href: "https://www.jstor.org/stable/resrep19552.13" }],
  "Bounded Rationality / Satisficing Audit": [{ label: "Nobel Prize — Herbert Simon, Rational Decision-Making in Business Organizations", href: "https://www.nobelprize.org/prizes/economic-sciences/1978/simon/lecture/" }],
  "Recognition-Primed Decision Audit": [{ label: "Gary Klein — Recognition-Primed Decision Model", href: "https://www.gary-klein.com/rpd" }],
  "Interactive Complexity / Tight-Coupling Audit": [{ label: "AHRQ PSNet — Perrow, Normal Accidents", href: "https://psnet.ahrq.gov/issue/normal-accidents-living-high-risk-technologies" }],
  "Legibility / Local-Knowledge Audit": [{ label: "Yale University Press — James C. Scott, Seeing Like a State", href: "https://yalebooks.yale.edu/book/9780300078152/seeing-like-a-state/" }],
  "Exit–Voice–Loyalty Analysis": [{ label: "Harvard / Google Books — Hirschman, Exit, Voice, and Loyalty", href: "https://books.google.com/books/about/Exit_Voice_and_Loyalty.html?id=4gcPEAAAQBAJ" }],
  "Goodhart–Campbell Metric Gaming Audit": [{ label: "Campbell's Law in indicator design — PubMed", href: "https://pubmed.ncbi.nlm.nih.gov/26113538/" }, { label: "Goodhart versus Campbell — Significance", href: "https://doi.org/10.1111/j.1740-9713.2018.01205.x" }],
};

const FAMILY_NEXT: Partial<Record<TechniqueFamily, string[]>> = {
  intelligence: ["Key Assumptions Check", "Analysis of Competing Hypotheses (ACH)", "Signpost-to-Scenario Mapping"],
  forecasting: ["Reference Class Forecasting", "Signpost-to-Scenario Mapping", "Brier Score Review"],
  decision: ["Sensitivity Analysis", "Value of Information", "Premortem Analysis", "Bounded Rationality / Satisficing Audit", "OODA Decision-Cycle Analysis"],
  systems: ["Causal Loop Mapping", "Leverage Points Analysis", "Alternative Futures Analysis", "Requisite Variety Analysis", "Interactive Complexity / Tight-Coupling Audit"],
  safety: ["Bow-Tie Analysis", "Barrier Analysis", "ALARP Assessment"],
  quality: ["Five Whys", "Pareto Prioritization", "Plan–Do–Check–Act (PDCA)"],
  research: ["Robustness Check", "Sensitivity Analysis", "Systematic Review"],
  design: ["Assumption Mapping", "Concept Screening", "Journey Analysis"],
  security: ["MITRE ATT&CK Mapping", "Attack Tree Analysis", "Hypothesis-Driven Investigation"],
  policy: ["Policy Options Appraisal", "Implementation Feasibility Analysis", "Regulatory Impact Assessment", "Legibility / Local-Knowledge Audit", "Polycentric Governance Analysis"],
  economics: ["Sensitivity Analysis", "Economic Scenario Analysis", "Cost-Benefit Analysis"],
  geospatial: ["Spatial Change Detection", "Hot Spot Analysis", "Spatial Network Analysis"],
  legal: ["Precedent Synthesis", "Analogical Legal Reasoning", "CREAC Analysis"],
  "operations-research": ["Sensitivity Analysis", "Discrete-Event Simulation", "Goal Programming"],
  literary: ["Framing Analysis", "Interdiscursivity Analysis", "Historical-Contextual Literary Analysis"],
  "religious-studies": ["Source Criticism", "Contextualization", "Reception History"],
  general: ["Problem Restatement", "Steelmanning", "Precommitment Review", "Stakeholder Analysis"],
};
function prerequisitesFor(family: TechniqueFamily, name: string): string[] {
  if (CURATED_PREREQUISITES[name]) return [...CURATED_PREREQUISITES[name]];
  if (/meta-analysis|meta-regression|network meta-analysis/i.test(name)) return ["A defined review question", "Comparable effect estimates", "Study-level uncertainty data"];
  if (/regression|factor analysis|principal component|cluster analysis|survival analysis/i.test(name)) return ["Structured dataset", "Defined variables", "Data-quality review"];
  if (/geospatial|spatial|viewshed|least-cost|hot spot|kernel density|moran|getis/i.test(name)) return ["Georeferenced data", "Defined spatial unit or scale"];
  if (family === "security") return ["Defined system or incident scope", "Evidence provenance"];
  if (family === "legal") return ["Material facts", "Relevant authority or rule set"];
  if (["literary", "religious-studies"].includes(family)) return ["Defined corpus or artifact", "Historical or discourse context"];
  return [];
}
const VALID_TECHNIQUE_NAMES = new Set(BUILT_IN_TECHNIQUES.map((item) => item.name));
const validRelations = (items: string[] | undefined, current: string) => (items ?? []).filter((name) => name !== current && VALID_TECHNIQUE_NAMES.has(name));

export function techniqueCatalogReferenceIssues(): string[] {
  const issues = new Set<string>();
  for (const [task, recommendations] of Object.entries(TASK_RECOMMENDATIONS)) {
    for (const item of recommendations ?? []) if (!VALID_TECHNIQUE_NAMES.has(item.name)) issues.add(`task:${task}:${item.name}`);
  }
  for (const [family, names] of Object.entries(FAMILY_NEXT)) {
    for (const name of names ?? []) if (!VALID_TECHNIQUE_NAMES.has(name)) issues.add(`family:${family}:${name}`);
  }
  for (const [source, relations] of Object.entries(CURATED_RELATIONSHIPS)) {
    if (!VALID_TECHNIQUE_NAMES.has(source)) issues.add(`relation-source:${source}`);
    for (const [kind, names] of Object.entries(relations)) {
      for (const name of names ?? []) if (!VALID_TECHNIQUE_NAMES.has(name)) issues.add(`relation:${source}:${kind}:${name}`);
    }
  }
  for (const source of Object.keys(CURATED_PREREQUISITES)) if (!VALID_TECHNIQUE_NAMES.has(source)) issues.add(`prerequisite-source:${source}`);
  for (const source of Object.keys(CURATED_REFERENCES)) if (!VALID_TECHNIQUE_NAMES.has(source)) issues.add(`reference-source:${source}`);
  for (const playbook of TECHNIQUE_PLAYBOOKS) {
    for (const step of playbook.steps) if (!VALID_TECHNIQUE_NAMES.has(step.name)) issues.add(`playbook:${playbook.id}:${step.name}`);
  }
  return [...issues].sort();
}

export function techniqueCatalogMetadata(definition: TechniqueDefinition): TechniqueCatalogMetadata {
  const family = techniqueFamily(definition);
  const curated = CURATED_RELATIONSHIPS[definition.name] ?? {};
  const familyNext = validRelations(FAMILY_NEXT[family], definition.name).slice(0, 4);
  const useAfter = curated.useAfter ? validRelations(curated.useAfter, definition.name) : familyNext;
  return { aliases: aliasesFor(definition.name), effort: effortFor(definition.name), evidence: evidenceFor(family, definition.name), outputs: outputsFor(family, definition.name), prerequisites: prerequisitesFor(family, definition.name), recommendedNext: useAfter, useBefore: validRelations(curated.useBefore, definition.name), useAfter, alternatives: validRelations(curated.alternatives, definition.name), references: CURATED_REFERENCES[definition.name] ?? [] };
}

function dataTypesFor(family: TechniqueFamily, name: string): TechniqueDataType[] {
  if (/network|link analysis|centrality|clique|broker|structural hole/i.test(name)) return ["network"];
  if (/spatial|geospatial|viewshed|kernel density|moran|getis|hot spot|least-cost/i.test(name)) return ["geospatial"];
  if (/regression|meta-analysis|statistic|quantitative|principal component|factor analysis|cluster analysis|survival|markov|simulation|programming/i.test(name)) return ["quantitative"];
  if (/qualitative|thematic|grounded theory|narrative analysis|conversation analysis|ethnograph|phenomenolog|rhetoric|hermeneut|criticism|historical method|source criticism/i.test(name)) return ["qualitative", "documentary"];
  if (["literary", "religious-studies", "legal"].includes(family)) return ["documentary"];
  if (["research", "intelligence", "forecasting", "policy", "design"].includes(family)) return ["mixed"];
  return ["any"];
}
const effortRank: Record<TechniqueEffort, number> = { quick: 0, moderate: 1, extended: 2 };
const evidenceRank: Record<TechniqueEvidenceRequirement, number> = { light: 0, moderate: 1, substantial: 2 };
export function techniqueSuitabilityScore(definition: TechniqueDefinition, context: TechniqueSuitabilityContext = {}): { score: number; reasons: string[] } {
  const metadata = techniqueCatalogMetadata(definition);
  const family = techniqueFamily(definition);
  let score = 100; const reasons: string[] = [];
  if (context.effort && context.effort !== "any") { const delta = effortRank[metadata.effort] - effortRank[context.effort]; if (delta > 0) { score -= 25 * delta; reasons.push(`needs ${metadata.effort} effort`); } else reasons.push(`${metadata.effort} effort fits`); }
  if (context.evidence && context.evidence !== "any") { const delta = evidenceRank[metadata.evidence] - evidenceRank[context.evidence]; if (delta > 0) { score -= 20 * delta; reasons.push(`needs ${metadata.evidence} evidence`); } else reasons.push(`${metadata.evidence} evidence fits`); }
  if (context.dataType && context.dataType !== "any") { const types = dataTypesFor(family, definition.name); if (!types.includes(context.dataType) && !types.includes("any") && !types.includes("mixed")) { score -= 30; reasons.push(`better suited to ${types.join("/")} data`); } else reasons.push(`${context.dataType} data fit`); }
  if (context.output && context.output !== "any") { if (!metadata.outputs.includes(context.output)) { score -= 25; reasons.push(`produces ${metadata.outputs.join("/")}`); } else reasons.push(`${context.output} output fit`); }
  return { score: Math.max(0, score), reasons };
}
export function suitableTechniqueRecommendationsForTask(task: TechniqueTaskId, context: TechniqueSuitabilityContext = {}): TechniqueSuitabilityRecommendation[] {
  const byName = new Map(BUILT_IN_TECHNIQUES.map((item) => [item.name, item]));
  return techniqueRecommendationsForTask(task).map((item, index) => { const definition = byName.get(item.name)!; const fit = techniqueSuitabilityScore(definition, context); return { ...item, ...fit, score: fit.score - index }; }).sort((a,b) => b.score - a.score);
}

export function techniqueRecommendationsForTask(task: TechniqueTaskId): TechniqueTaskRecommendation[] {
  return (TASK_RECOMMENDATIONS[task] ?? []).filter((item) => VALID_TECHNIQUE_NAMES.has(item.name)).map((item) => ({ ...item }));
}
export function techniqueNamesForTask(task: TechniqueTaskId): string[] {
  return techniqueRecommendationsForTask(task).map((item) => item.name);
}
export function techniqueTaskIds(definition: TechniqueDefinition): TechniqueTaskId[] {
  return TECHNIQUE_TASKS.filter((task) => techniqueNamesForTask(task.id).includes(definition.name)).map((task) => task.id);
}
export function techniqueSearchText(definition: TechniqueDefinition): string {
  const metadata = techniqueCatalogMetadata(definition);
  const taskText = TECHNIQUE_TASKS.filter((task) => techniqueNamesForTask(task.id).includes(definition.name)).flatMap((task) => {
    const recommendation = techniqueRecommendationsForTask(task.id).find((item) => item.name === definition.name);
    return [task.label, task.description, recommendation?.role ?? ""];
  });
  return [...metadata.aliases, metadata.effort, metadata.evidence, ...metadata.outputs, ...metadata.prerequisites, ...metadata.recommendedNext, ...metadata.useBefore, ...metadata.useAfter, ...metadata.alternatives, ...metadata.references.map((item) => item.label), ...taskText].join(" ");
}

export function techniquePlaybook(id: string): TechniquePlaybook | undefined {
  const playbook = TECHNIQUE_PLAYBOOKS.find((item) => item.id === id);
  if (!playbook) return undefined;
  const steps = playbook.steps.filter((step) => VALID_TECHNIQUE_NAMES.has(step.name)).map((step) => ({ ...step }));
  return { ...playbook, steps };
}
export function adaptiveTechniquePlaybook(id: string, context: TechniqueSuitabilityContext = {}): AdaptiveTechniquePlaybook | undefined {
  const playbook = techniquePlaybook(id); if (!playbook) return undefined;
  const effortLimit = context.effort === "quick" ? 2 : context.effort === "moderate" ? 3 : playbook.steps.length;
  const evidenceLimit = context.evidence === "light" ? 2 : context.evidence === "moderate" ? 3 : playbook.steps.length;
  const target = Math.max(2, Math.min(playbook.steps.length, effortLimit, evidenceLimit));
  if (target >= playbook.steps.length) return { ...playbook, mode: "full", omitted: [] };
  const byName = new Map(BUILT_IN_TECHNIQUES.map((item) => [item.name, item]));
  const ranked = playbook.steps.map((step, index) => ({ step, index, score: techniqueSuitabilityScore(byName.get(step.name)!, context).score + (index === 0 ? 15 : 0) })).sort((a,b) => b.score - a.score || a.index - b.index);
  const keep = new Set(ranked.slice(0, target).map((item) => item.step.name));
  const steps = playbook.steps.filter((step) => keep.has(step.name)).map((step) => ({ ...step }));
  const omitted = playbook.steps.filter((step) => !keep.has(step.name)).map((step) => ({ ...step }));
  return { ...playbook, steps, omitted, mode: target <= 2 ? "rapid" : "focused" };
}
