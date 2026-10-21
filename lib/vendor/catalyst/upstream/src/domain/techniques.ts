import { EXTENDED_BUILT_IN_TECHNIQUES } from "./techniquesExtended";
import { INTERDISCIPLINARY_BUILT_IN_TECHNIQUES } from "./techniquesInterdisciplinary";
import { HUMANITIES_BUILT_IN_TECHNIQUES } from "./techniquesHumanities";
import { CATALOG_BUILT_IN_TECHNIQUES } from "./techniquesCatalog";

import type {
  TechniqueCategory,
  TechniqueDefinition,
  TechniqueResponseKind,
  TechniqueRun,
  TechniqueStepDefinition,
} from "./types";

function step(
  id: string,
  title: string,
  prompt: string,
  responseKind: TechniqueResponseKind = "long-text",
  placeholder?: string,
): TechniqueStepDefinition {
  return { id, title, prompt, responseKind, placeholder };
}

function builtIn(
  id: string,
  name: string,
  summary: string,
  category: TechniqueCategory,
  steps: TechniqueStepDefinition[],
): TechniqueDefinition {
  return {
    id: `builtin:${id}`,
    name,
    summary,
    category,
    builtIn: true,
    version: 1,
    steps,
    createdAt: null,
    updatedAt: null,
  };
}

const BASE_BUILT_IN_TECHNIQUES: TechniqueDefinition[] = [
  builtIn(
    "key-assumptions-check",
    "Key Assumptions Check",
    "Make the assumptions supporting a judgment explicit and test how much the analysis depends on them.",
    "diagnostic",
    [
      step("analytic-line", "Current analytic line", "State the judgment, assessment, or working explanation you are testing."),
      step("assumptions", "Assumptions", "List the stated and unstated premises that must be true for that analytic line to hold.", "list", "One assumption per line"),
      step("challenge", "Challenge the assumptions", "For each important assumption, ask why it must be true and what evidence or circumstances could make it fail."),
      step("confidence", "Confidence and sensitivity", "Which assumptions are least secure? If one proved false, how much would your conclusion change?"),
      step("indicators", "What would change your mind?", "List information, events, or indicators that should trigger a reassessment.", "list", "One indicator per line"),
    ],
  ),
  builtIn(
    "quality-of-information-check",
    "Quality of Information Check",
    "Review the reliability, completeness, corroboration, and limitations of the information supporting an assessment.",
    "diagnostic",
    [
      step("critical-information", "Critical information", "Identify the sources or pieces of information that carry the most weight in the assessment.", "list", "One source or item per line"),
      step("reliability", "Reliability and access", "What is known about each source's reliability, access, collection conditions, processing, translation, or interpretation?"),
      step("corroboration", "Corroboration", "Which important claims are independently corroborated, and which depend on a single or ambiguous source?"),
      step("gaps", "Gaps and ambiguity", "What important information is missing, recalled, disputed, stale, or open to multiple interpretations?", "list", "One gap or ambiguity per line"),
      step("confidence", "Resulting confidence", "Given the quality of the information base, what confidence is justified and why?"),
    ],
  ),
  builtIn(
    "indicators-signposts",
    "Indicators or Signposts of Change",
    "Define observable events that would provide warning that a hypothesis, scenario, or trend is emerging or failing.",
    "diagnostic",
    [
      step("hypotheses", "Hypotheses or scenarios", "List the competing hypotheses, scenarios, or states you want to monitor.", "list", "One hypothesis or scenario per line"),
      step("positive-indicators", "Positive indicators", "What observable events or trends would you expect if the development were occurring?", "list", "One indicator per line"),
      step("negative-indicators", "Negative indicators", "What would you expect to observe if the development were not occurring?", "list", "One indicator per line"),
      step("triggers", "Triggers", "Identify events that could abruptly accelerate, reverse, or transform the situation.", "list", "One trigger per line"),
      step("review", "Review plan", "How often should the indicators be revisited, and what threshold would justify changing the assessment?"),
    ],
  ),
  builtIn(
    "ach",
    "Analysis of Competing Hypotheses (ACH)",
    "Compare multiple explanations against the full body of evidence, emphasizing disconfirmation rather than confirmation.",
    "diagnostic",
    [
      step("hypotheses", "Competing hypotheses", "Generate the reasonable alternative explanations that deserve consideration.", "list", "One hypothesis per line"),
      step("evidence", "Evidence and arguments", "List significant evidence and arguments relevant to any of the hypotheses.", "list", "One evidence item per line"),
      step("inconsistencies", "Disconfirming evidence", "Which evidence is inconsistent with each hypothesis? Focus on evidence that discriminates among alternatives."),
      step("sensitivity", "Sensitivity", "Which conclusions depend on a small number of critical or potentially unreliable evidence items?"),
      step("missing-evidence", "Expected but missing evidence", "What should be observable if each hypothesis were true but is not currently seen? Could denial or deception explain the absence?"),
      step("judgment", "Relative likelihood and monitoring", "Which hypotheses are strongest or weakest now, and what indicators should be monitored going forward?"),
    ],
  ),
  builtIn(
    "devils-advocacy",
    "Devil's Advocacy",
    "Build the strongest plausible case against a dominant judgment, consensus, or key assumption.",
    "contrarian",
    [
      step("mainline", "Mainline judgment", "State the prevailing judgment and the key assumptions supporting it."),
      step("weak-points", "Vulnerable assumptions", "Which assumptions, logic, or evidence are most susceptible to challenge?", "list", "One vulnerability per line"),
      step("alternative", "Best contrary case", "Construct the strongest alternative explanation or conclusion you can support."),
      step("contrary-evidence", "Contrary evidence", "What evidence supports the alternative or contradicts the prevailing view?", "list", "One evidence item per line"),
      step("implications", "Implications", "Does the exercise reinforce the mainline judgment, reveal caveats, or justify revising it?"),
    ],
  ),
  builtIn(
    "team-a-team-b",
    "Team A / Team B",
    "Develop and compare two or more strongly held competing views with equal analytical discipline.",
    "contrarian",
    [
      step("positions", "Competing positions", "Define the competing hypotheses or viewpoints as fairly and precisely as possible.", "list", "One position per line"),
      step("case-a", "Best case for Position A", "Present its assumptions, strongest evidence, logic, and missing information."),
      step("case-b", "Best case for Position B", "Present its assumptions, strongest evidence, logic, and missing information."),
      step("rebuttal", "Challenge and rebuttal", "What are the strongest criticisms each side can make of the other?"),
      step("resolution", "Areas of agreement and disagreement", "What differences remain, what evidence could resolve them, and what should be collected or researched next?"),
    ],
  ),
  builtIn(
    "high-impact-low-probability",
    "High-Impact / Low-Probability Analysis",
    "Examine a seemingly unlikely event whose consequences would be large enough to merit preparation and warning.",
    "contrarian",
    [
      step("outcome", "High-impact outcome", "Define the low-probability outcome clearly and explain why its consequences matter."),
      step("pathways", "Plausible pathways", "Describe one or more credible ways the outcome could occur.", "list", "One pathway per line"),
      step("triggers", "Triggers and accelerants", "What shocks, decisions, accidents, or changes in momentum could make the outcome more plausible?", "list", "One trigger per line"),
      step("indicators", "Early indicators", "What observable signposts would suggest that a pathway is beginning to unfold?", "list", "One indicator per line"),
      step("mitigation", "Deflectors and mitigations", "What factors or actions could prevent, delay, or reduce the impact of the outcome?"),
    ],
  ),
  builtIn(
    "what-if",
    "What If? Analysis",
    "Assume an important event has already happened, then reason backward to explain how it could have occurred and what would follow.",
    "contrarian",
    [
      step("event", "Assumed event", "State the event as if it has already happened. Be concrete about timing and scope."),
      step("path", "How did we get here?", "Work backward through the decisions, conditions, surprises, and interactions that could plausibly have produced the event."),
      step("drivers", "Critical drivers", "Which assumptions, actors, forces, or uncertainties were necessary for the pathway?", "list", "One driver per line"),
      step("signposts", "Signposts", "What observable indicators would have appeared before the event?", "list", "One signpost per line"),
      step("implications", "Implications", "If the event occurred, what consequences, opportunities, or policy choices would follow?"),
    ],
  ),
  builtIn(
    "brainstorming",
    "Brainstorming",
    "Generate a broad set of possibilities before evaluating or narrowing them.",
    "imaginative",
    [
      step("question", "Question", "Frame the problem or question narrowly enough to focus ideas but broadly enough to allow surprise."),
      step("ideas", "Generate ideas", "List possibilities without evaluating them while generating.", "list", "One idea per line"),
      step("clusters", "Patterns and clusters", "Group related ideas, combine duplicates, and identify themes or surprising connections."),
      step("priorities", "Promising directions", "Which ideas deserve deeper investigation, testing, or collection?", "list", "One direction per line"),
    ],
  ),
  builtIn(
    "outside-in-thinking",
    "Outside-In Thinking",
    "Examine broad external forces first, then trace how they could shape the narrower issue being analyzed.",
    "imaginative",
    [
      step("issue", "Focal issue", "Define the issue, organization, country, market, or problem you are trying to understand."),
      step("external-forces", "External forces", "Identify broad political, economic, social, technological, security, environmental, or other forces outside the immediate issue.", "list", "One external force per line"),
      step("interactions", "Interactions", "How might those external forces interact with the focal issue or with one another?"),
      step("surprises", "Potential surprises", "What developments would be easy to miss if analysis stayed focused only on the immediate problem?", "list", "One surprise per line"),
      step("implications", "Implications", "Which external changes deserve monitoring or should alter the current assessment?"),
    ],
  ),
  builtIn(
    "red-team-analysis",
    "Red Team Analysis",
    "Adopt the perspective of another actor to test how their goals, culture, constraints, and perceptions could produce different choices.",
    "imaginative",
    [
      step("actor", "Actor and decision", "Whose perspective are you adopting, and what decision or problem are they facing?"),
      step("objectives", "Objectives and constraints", "What do they want, fear, value, and need to protect? What limits their choices?"),
      step("worldview", "Worldview and assumptions", "How might history, culture, doctrine, incentives, biases, or incomplete information shape their perception?"),
      step("options", "Options from their perspective", "What actions might look rational or attractive to them even if they look unattractive to us?", "list", "One option per line"),
      step("indicators", "Observable implications", "What behavior or indicators would you expect if this perspective is approximately correct?", "list", "One indicator per line"),
    ],
  ),
  builtIn(
    "alternative-futures",
    "Alternative Futures Analysis",
    "Construct several plausible, causally distinct futures to expose implications, robust actions, vulnerabilities, and signposts without treating any scenario as the forecast.",
    "imaginative",
    [
      step("focal-question", "Focal question", "Define the strategic issue, decision context, and time horizon without assuming a preferred or most likely future."),
      step("forces", "Drivers, constraints, and uncertainties", "Identify structural drivers, constraints, critical uncertainties, and plausible discontinuities grounded in evidence and scanning.", "list", "One driver or uncertainty per line"),
      step("futures", "Distinct plausible futures", "Construct several internally coherent futures that differ in causal structure, actor behavior, and important conditions—not merely in whether outcomes are good or bad.", "long-text"),
      step("implications", "Implications and robust actions", "For each future, identify consequences, vulnerabilities, opportunities, assumptions under stress, and actions that remain useful across multiple futures."),
      step("signposts", "Indicators and signposts", "Define observable events, trends, behaviors, thresholds, or absences that would shift attention toward or away from each future.", "list", "One signpost per line"),
      step("monitor", "Monitoring and update", "Specify how accumulating signposts should change scenario attention while preserving viable alternatives and avoiding premature collapse to a single forecast."),
    ],
  ),
  ...EXTENDED_BUILT_IN_TECHNIQUES,
  ...INTERDISCIPLINARY_BUILT_IN_TECHNIQUES,
  ...HUMANITIES_BUILT_IN_TECHNIQUES,
  ...CATALOG_BUILT_IN_TECHNIQUES,
];

const normalizedTechniqueName = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const BUILT_IN_TECHNIQUES: TechniqueDefinition[] = BASE_BUILT_IN_TECHNIQUES.filter(
  (definition, index, all) => all.findIndex((candidate) => normalizedTechniqueName(candidate.name) === normalizedTechniqueName(definition.name)) === index,
);

export function newTechniqueRun(
  definition: TechniqueDefinition,
  parentRunId: string | null = null,
): TechniqueRun {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    parentRunId,
    sequenceIndex: null,
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionSnapshot: structuredClone(definition),
    responses: {},
    createdAt: now,
    updatedAt: now,
  };
}
