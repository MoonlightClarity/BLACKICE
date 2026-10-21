import type { TechniqueDefinition, TechniqueFamily } from "./types";

export const TECHNIQUE_FAMILY_LABELS: Record<TechniqueFamily, string> = {
  intelligence: "Intelligence analysis",
  forecasting: "Forecasting & futures",
  decision: "Decision science",
  systems: "Systems thinking",
  safety: "Safety & reliability",
  quality: "Quality & process",
  research: "Research & inference",
  design: "Design & discovery",
  security: "Security & threat modeling",
  policy: "Policy analysis",
  economics: "Economics",
  geospatial: "Geospatial & spatial analysis",
  legal: "Legal reasoning",
  "operations-research": "Operations research",
  literary: "Literary analysis",
  "religious-studies": "Religious studies",
  general: "General analysis",
  custom: "Custom",
};

const GROUPS: Record<Exclude<TechniqueFamily, "general" | "custom">, string[]> = {
  intelligence: [
    "key-assumptions-check", "quality-of-information-check", "indicators-signposts", "ach",
    "devils-advocacy", "team-a-team-b", "high-impact-low-probability", "what-if",
    "outside-in-thinking", "red-team-analysis", "deception-detection", "indicators-validator",
    "structured-self-critique", "red-hat-analysis", "multiple-hypotheses-generator",
  ],
  forecasting: [
    "alternative-futures", "scenario-analysis", "cross-impact-analysis", "delphi-method",
    "reference-class-forecasting", "fermi-estimation",
  ],  decision: [
    "decision-matrix", "force-field-analysis", "pros-cons-faults-fixes", "value-of-information",
    "decision-tree", "regret-analysis", "stakeholder-analysis", "sorting-prioritizing", "premortem-analysis",
  ],
  systems: [
    "network-analysis", "complexity-manager", "causal-loop", "rich-picture", "boundary-critique",
    "behavior-over-time", "sipoc",
  ],
  safety: [
    "fmea", "fault-tree", "event-tree", "bow-tie-analysis", "hazop", "pre-mortem-redesign",
  ],
  quality: [
    "five-whys", "fishbone-analysis", "is-is-not", "five-w-two-h", "pareto-prioritization",
    "pdca", "eight-d", "after-action-review",
  ],
  research: [
    "argument-mapping", "diagnostic-reasoning", "structured-analogies", "bayesian-update",
    "confounder-check", "falsification-design", "robustness-check", "chronologies-timelines",
    "matrix-analysis", "structured-debate", "adversarial-collaboration",
  ],
  design: [
    "brainstorming", "starbursting", "morphological-analysis", "role-playing", "affinity-mapping",
    "journey-analysis", "assumption-mapping", "issue-redefinition",
  ],
  security: ["attack-tree", "stride-threat-model"],
  policy: [],
  economics: [],
  geospatial: [],
  legal: [],
  "operations-research": [],
  literary: [
    "close-reading", "narratology", "focalization-analysis", "character-analysis",
    "motif-symbol-tracking", "theme-tension-analysis", "intertextual-analysis",
    "genre-convention-analysis", "literary-rhetorical-analysis", "structural-semiotic-analysis",
    "reader-response-analysis", "historical-contextual-literary-analysis", "poetic-form-prosody",
  ],
  "religious-studies": [
    "textual-criticism", "source-criticism", "form-criticism", "redaction-criticism",
    "historical-critical-religious-text", "reception-history", "comparative-religion",
    "ritual-analysis", "lived-religion-analysis", "social-scientific-religion",
    "material-religion-analysis", "hermeneutic-circle", "myth-symbol-analysis",
  ],
};
const FAMILY_BY_ID = new Map<string, TechniqueFamily>();
for (const [family, ids] of Object.entries(GROUPS) as Array<[TechniqueFamily, string[]]>) {
  for (const id of ids) FAMILY_BY_ID.set(id, family);
}

export function familyForBuiltInTechniqueId(id: string): TechniqueFamily {
  return FAMILY_BY_ID.get(id) ?? "general";
}

export function techniqueFamily(definition: TechniqueDefinition): TechniqueFamily {
  if (definition.family) return definition.family;
  if (!definition.builtIn) return "custom";
  const id = definition.id.startsWith("builtin:") ? definition.id.slice(8) : definition.id;
  return familyForBuiltInTechniqueId(id);
}

export function techniqueCluster(definition: TechniqueDefinition): string {
  const explicit = definition.cluster?.trim();
  if (explicit) return explicit;
  return techniqueFamily(definition) === "custom" ? "Custom methods" : "Foundational methods";
}

export const FILTERABLE_TECHNIQUE_FAMILIES: TechniqueFamily[] = [
  "intelligence", "forecasting", "decision", "systems", "safety", "quality",
  "research", "design", "security", "policy", "economics", "geospatial", "legal",
  "operations-research", "literary", "religious-studies", "general", "custom",
];