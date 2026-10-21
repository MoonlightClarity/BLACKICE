// BLACKICE adaptation of the Apache-2.0 Catalyst catalog. The complete pinned
// source and unchanged materialized definitions ship in lib/vendor/catalyst.
// Only data is loaded here; importing BLACKICE never evaluates upstream TS.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateMethodCatalog } from './method-catalog.mjs';

export const CATALYST_ADAPTER_VERSION = 1;
export const CATALYST_CATALOG_SHA256 = '7a2caedb635bf878232a8250c1bdccba4b6d2c4c22f8de8a0fdb74c12dc5e3d6';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const frozen = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
};
const bytes = readFileSync(new URL('./vendor/catalyst/catalog.json', import.meta.url));
if (hash(bytes) !== CATALYST_CATALOG_SHA256) throw new Error('The bundled Catalyst catalog does not match the pinned import. Restore the release files or regenerate the reviewed catalog.');
const upstream = JSON.parse(bytes);
const sourceManifestBytes = readFileSync(new URL('./vendor/catalyst/retrieval-manifest.json', import.meta.url));
if (hash(sourceManifestBytes) !== upstream.source.retrievalManifestSha256) throw new Error('The bundled Catalyst source manifest does not match the catalog.');
const sourceManifest = JSON.parse(sourceManifestBytes);
const sourceFiles = new Map(sourceManifest.files.map(file => [file.path, file]));
const sourceUrl = file => `${upstream.source.repository}/blob/${upstream.source.commit}/${file}`;

export function catalystMethodId(sourceId) {
  if (typeof sourceId !== 'string' || !/^builtin:[A-Za-z0-9_-]+$/.test(sourceId)) throw new Error('A Catalyst method needs its original built-in source ID.');
  const id = `catalyst-${sourceId.slice('builtin:'.length)}`;
  if (id.length > 100) throw new Error('The adapted Catalyst method ID exceeds BLACKICE limits.');
  return id;
}
const byName = new Map(upstream.techniques.map(item => [item.definition.name, catalystMethodId(item.definition.id)]));
if (byName.size !== 581 || upstream.counts.techniques !== 581 || upstream.counts.steps !== 2906) throw new Error('The pinned Catalyst catalog is incomplete or contains duplicate names.');

const familyDefaults = Object.freeze({
  intelligence: { taskType: 'analysis', phase: 'evaluate-evidence', inputs: 'The judgment or question, candidate explanations, source material and known evidence gaps.', prerequisites: ['A question or judgment with a defined scope', 'Evidence or assumptions whose source and uncertainty can be recorded'], caution: 'Available material cannot distinguish the alternatives; use the method to identify collection needs and preserve the unresolved judgment.', check: 'Claims distinguish source observations, assumptions, competing explanations and unresolved evidence gaps.' },
  forecasting: { taskType: 'analysis', phase: 'forecast', inputs: 'The forecast question, horizon, base rates, scenarios, estimates and observations available so far.', prerequisites: ['A defined outcome and time horizon', 'Relevant observations, base rates or explicitly labeled judgments'], caution: 'The event or time horizon is undefined, or scenarios are being treated as probabilities without an estimation basis.', check: 'The forecast horizon, assumptions, uncertainty and conditions for updating the result are explicit.' },
  decision: { taskType: 'decision', phase: 'compare-options', inputs: 'Options, decision criteria, constraints, uncertainties and the preferences actually supplied by the user.', prerequisites: ['A decision with identifiable options or actions', 'Known constraints and stated preferences, with missing preferences marked'], caution: 'The ranking depends on invented stakeholder preferences or incomparable criteria; expose the sensitivity before recommending.', check: 'The comparison preserves supplied constraints and distinguishes stated preferences from assumptions and sensitivity.' },
  systems: { taskType: 'analysis', phase: 'causal', inputs: 'The system boundary, actors, relationships, behavior over time and evidence for the proposed links.', prerequisites: ['A system boundary and behavior to understand', 'Observations or assumptions for entities, relationships and feedback'], caution: 'The proposed map is being read as a demonstrated causal model without evidence for its links and boundary choices.', check: 'System boundaries, link direction, dependencies and the evidence or assumptions behind them are visible.' },
  safety: { taskType: 'analysis', phase: 'threat-risk', inputs: 'System or process scope, hazards, incidents, barriers, dependencies and available performance evidence.', prerequisites: ['A defined system, process, hazard or failure scenario', 'Evidence or explicit assumptions about causes, barriers and consequences'], caution: 'Unknown barrier performance or unmeasured frequencies would be presented as established protection or precise risk estimates.', check: 'Failure pathways, barrier dependencies and residual uncertainty are distinguished from demonstrated control performance.' },
  quality: { taskType: 'analysis', phase: 'improve-process', inputs: 'The process, observed defect or performance problem, measurements, targets and operating constraints.', prerequisites: ['A bounded process and observable performance question', 'Measurements or observations with their units and collection conditions'], caution: 'There is no usable process baseline or measurement definition; establish those before claiming an improvement.', check: 'Measurements retain units and collection conditions, and proposed causes or improvements are tied to observed process evidence.' },
  research: { taskType: 'research', phase: 'synthesize-research', inputs: 'The research question, studies or dataset, variables or corpus, inclusion rules and known data limitations.', prerequisites: ['A research question with a defined population, corpus or dataset', 'Accessible evidence and an account of its quality and limitations'], caution: 'The available evidence cannot support the method’s identification, measurement, sampling or comparability assumptions.', check: 'The analysis identifies its evidence, selection or modeling assumptions, uncertainty and limits on the inference.' },
  design: { taskType: 'planning', phase: 'frame', inputs: 'The user need, current experience, observed research, design constraints and existing concepts.', prerequisites: ['A user need, experience or design question', 'Available observations and constraints, with invented examples labeled'], caution: 'Assumed user needs or prototype reactions would be presented as observed research; distinguish hypotheses from findings.', check: 'Design choices trace to observed needs or explicitly labeled assumptions, with a concrete way to evaluate the concept.' },
  security: { taskType: 'analysis', phase: 'threat-risk', inputs: 'Authorized system or incident scope, architecture, assets, events, evidence provenance and defensive objectives.', prerequisites: ['A defined system or incident scope', 'Evidence provenance'], caution: 'The available evidence does not establish the incident sequence or actor; retain alternative explanations and evidence gaps.', check: 'Assertions about threats, incidents or controls cite actual evidence and separate observations, hypotheses and defensive follow-up.' },
  policy: { taskType: 'decision', phase: 'compare-options', inputs: 'The policy objective, options, affected groups, evidence, implementation context and known constraints.', prerequisites: ['A policy objective and relevant alternatives', 'Evidence about affected groups, mechanisms and implementation conditions'], caution: 'Benefits or implementation capacity are assumed without testing distributional effects and the conditions needed for the policy to work.', check: 'The appraisal distinguishes affected groups, causal assumptions, distributional effects and implementation constraints.' },
  economics: { taskType: 'analysis', phase: 'compare-options', inputs: 'The market or economic question, relevant actors, data, incentives, units, time horizon and assumptions.', prerequisites: ['A defined economic question and unit of analysis', 'Relevant data or explicit assumptions about incentives, constraints and responses'], caution: 'The model’s equilibrium, behavioral or aggregation assumptions do not fit the observed setting; qualify the model-based conclusion.', check: 'Economic assumptions, units, counterfactuals and sensitivity are explicit and calculations can be traced to their inputs.' },
  geospatial: { taskType: 'analysis', phase: 'investigate-network', inputs: 'Georeferenced data, study area, coordinate reference system, spatial units, time period and question.', prerequisites: ['Georeferenced data and a defined study area', 'Spatial units, scale and coordinate reference system'], caution: 'Missing location quality, scale or coordinate information would make spatial comparisons or distances unreliable.', check: 'Spatial scale, coordinate reference system, data quality and boundary effects are reported with the result.' },
  legal: { taskType: 'analysis', phase: 'interpret-context', inputs: 'Material facts, jurisdiction, applicable date, governing authorities and the legal issue to examine.', prerequisites: ['Material facts and the relevant jurisdiction and date', 'Relevant authority or rule set'], caution: 'The relevant jurisdiction, date or governing authority is missing; identify that gap before presenting an applied legal conclusion.', check: 'The reasoning distinguishes facts, governing authority, jurisdiction, interpretation and unresolved applicability.' },
  'operations-research': { taskType: 'decision', phase: 'compare-options', inputs: 'Decision variables, objective, demand or arrival data, constraints, units and operating assumptions.', prerequisites: ['A defined objective and controllable decisions', 'Constraints, units and input data or explicitly labeled parameter assumptions'], caution: 'The model is infeasible, unbounded or lacks credible input parameters; report the model condition before claiming an optimum.', check: 'The formulation, inputs, solver or calculation result, feasibility and sensitivity are inspectable.' },
  literary: { taskType: 'analysis', phase: 'interpret-context', inputs: 'The text, image or corpus, editions or translations, relevant context and interpretive question.', prerequisites: ['A defined corpus or artifact', 'Historical or discourse context'], caution: 'The interpretation depends on unavailable text, a disputed translation or context that has not been examined.', check: 'Interpretive claims point to actual passages or features and consider context, translation limits and plausible alternative readings.' },
  'religious-studies': { taskType: 'research', phase: 'interpret-context', inputs: 'The tradition, text, practice or historical question, primary material, translations and relevant context.', prerequisites: ['A defined corpus, tradition, practice or historical question', 'Source material and its historical or interpretive context'], caution: 'The evidence cannot support the chronology, comparison or interpretation being proposed; preserve competing readings and source limits.', check: 'Claims distinguish source evidence, historical context, comparison choices, interpretation and unresolved limits.' }
});

// Upstream discovery metadata sometimes falls back to "checklist" for every
// name in a cluster. Preserve the original in catalog.json and make these
// recognizable result forms available to BLACKICE's output filter.
const clusterOutputs = Object.freeze({
  'Framing & decomposition': ['map', 'checklist'],
  'Evidence & source evaluation': ['matrix', 'review'],
  'Hypotheses & arguments': ['matrix', 'narrative'],
  'Scanning & trends': ['review', 'estimate'],
  'Expert judgment & calibration': ['estimate'],
  'Multi-criteria decision analysis': ['ranking', 'decision'],
  'Uncertainty, utility & options': ['decision', 'estimate'],
  'System dynamics & complexity': ['map', 'model'],
  'Networks & relationships': ['network', 'map'],
  'Risk, hazard & resilience': ['risk profile'],
  'Process, root cause & improvement': ['review', 'model'],
  'Qualitative analysis': ['coded corpus', 'narrative'],
  'Quantitative & statistical analysis': ['model', 'estimate'],
  'Causal inference & experiments': ['estimate', 'review'],
  'Evidence synthesis & literature': ['review'],
  'Threat, cyber & investigative analysis': ['risk profile', 'review'],
  'Policy appraisal & implementation': ['decision', 'review'],
  'Economic reasoning & markets': ['model', 'estimate'],
  'Spatial patterns & terrain': ['map', 'review'],
  'Optimization, simulation & operations': ['model', 'decision']
});
const outputOverrides = Object.freeze({
  'Analysis of Competing Hypotheses (ACH)': ['matrix', 'narrative'],
  'Key Assumptions Check': ['checklist', 'review'],
  'Difference-in-Differences': ['estimate', 'review'],
  'Causal Diagramming with DAGs': ['map', 'review'],
  'Backdoor Criterion Review': ['map', 'review'],
  'Front-Door Criterion Review': ['map', 'review'],
  'Mechanism Mapping': ['map', 'review'],
  'Randomized Controlled Trial Design': ['model', 'review'],
  'A/B Test Design': ['model', 'decision'],
  'Factorial Experiment Design': ['model', 'review'],
  'Quasi-Experimental Design': ['model', 'review']
});
function outputsFor(item) {
  return outputOverrides[item.definition.name] || (item.metadata.outputs.length === 1 && item.metadata.outputs[0] === 'checklist' ? clusterOutputs[item.cluster] : null) || item.metadata.outputs;
}
function phaseOfStep(step, index) {
  if (index === 0) return 'scope';
  const subject = `${step.id} ${step.title}`.toLowerCase();
  if (/check|validity|sensitivity|robust|diagnostic|assurance|threats|limitations|failure modes|pre-treatment|balance|test|calibrat/.test(subject)) return 'check';
  if (/recommend|judgment|decision rule|conclusion|interpretive claim|decision|ranking|priorit/.test(subject)) return 'decide';
  if (/sources|collect|gather|material|corpus|evidence and|search|observations|source inventory/.test(subject)) return 'collect';
  if (/construct|draft|design|diagram|map|formulat|code|solution|solve|model/.test(subject)) return 'create';
  if (/report|handoff|communicat|deliver/.test(subject)) return 'handoff';
  return 'analyze';
}
function relations(names) {
  return names.map(name => {
    const id = byName.get(name);
    if (!id) throw new Error(`The Catalyst relationship has no saved target: ${name}`);
    return id;
  });
}
function adapt(item) {
  const definition = item.definition, defaults = familyDefaults[item.family];
  if (!defaults) throw new Error(`Unknown Catalyst method family: ${item.family}`);
  const prerequisites = item.metadata.prerequisites.length ? item.metadata.prerequisites : defaults.prerequisites;
  const outputs = outputsFor(item);
  const steps = definition.steps.map((source, index) => {
    const list = source.responseKind === 'list';
    const result = `A saved ${list ? 'list' : 'analysis'} for “${source.title}” in ${definition.name}, with supporting material, assumptions and unresolved limits.`;
    const instructions = [
      `Complete “${source.title}” using ${definition.name} for the project goal.`,
      source.prompt,
      ...(index === 0 ? [`Inspect the required material before relying on this method: ${prerequisites.join('; ')}. Use available authorized tools to gather missing material where possible. If an essential premise remains absent, record the gap and adapt the work without inventing evidence or results.`] : []),
      list ? `Save the result as separate, traceable entries.${source.placeholder ? ` ${source.placeholder}.` : ''}` : 'Save a reasoned response with the relevant evidence, calculations or artifact references.',
      ...(index === definition.steps.length - 1 ? [`Integrate the preceding results into the method’s ${outputs.join(' / ')}. State what the result supports, what remains unresolved and what would justify revising it.`] : [])
    ].join('\n\n');
    return {
      id: source.id, title: source.title, type: phaseOfStep(source, index), instructions,
      inputs: ['Project goal', 'Inputs and evidence', 'Scope and constraints', ...(index ? [`Saved result: ${definition.steps[index - 1].title}`] : [])],
      result,
      checks: [`The saved result addresses this step: ${source.prompt}`, defaults.check]
    };
  });
  const paths = [...new Set([item.definitionPath, item.workflowPath, 'src/domain/techniqueCatalogMetadata.ts', 'src/domain/techniqueFamilies.ts'])];
  return {
    id: catalystMethodId(definition.id), revision: 1, origin: 'builtin', verification: 'unverified',
    name: definition.name, description: definition.summary, taskType: defaults.taskType,
    inputs: [
      { id: 'materials', label: 'Inputs and evidence', description: defaults.inputs, required: false },
      { id: 'constraints', label: 'Scope and constraints', description: 'Relevant scope, dates, population, audience, output format, time budget or other constraints. The agent can use the task context when these are already known.', required: false }
    ],
    steps,
    catalog: validateMethodCatalog({
      domain: item.family, cluster: item.cluster, phases: item.taskIds.length ? item.taskIds : [defaults.phase],
      outputs, aliases: item.metadata.aliases, tags: [definition.category, upstream.familyLabels[item.family]],
      whenToUse: definition.summary, prerequisites, avoidWhen: [defaults.caution],
      effort: item.metadata.effort, evidence: item.metadata.evidence,
      recommendedNext: relations(item.metadata.recommendedNext), useBefore: relations(item.metadata.useBefore),
      useAfter: relations(item.metadata.useAfter), alternatives: relations(item.metadata.alternatives),
      references: item.metadata.references
    }),
    provenance: {
      project: upstream.source.project, repository: upstream.source.repository, url: sourceUrl(item.definitionPath),
      license: upstream.source.license, commit: upstream.source.commit, sourceId: definition.id, sourceVersion: definition.version,
      sourceDefinitionSha256: item.sourceDefinitionSha256, sourceRecordSha256: item.sourceRecordSha256,
      definitionPath: item.definitionPath, workflowPath: item.workflowPath,
      sourceFiles: paths.map(file => ({ ...sourceFiles.get(file), url: sourceUrl(file) })),
      sourceStepFormats: definition.steps.map(step => ({ id: step.id, responseKind: step.responseKind, ...(step.placeholder ? { placeholder: step.placeholder } : {}) })),
      adapterVersion: CATALYST_ADAPTER_VERSION,
      adaptation: 'BLACKICE retains the original titles, summaries, ordered steps, complete prompts, aliases and source references. It adds task and step types, artifact-oriented instructions, inputs, checks, fallback prerequisites, cautions and output discovery metadata. Related method names are resolved to saved BLACKICE IDs. The adapter does not assert independent methodological validation.',
      licensePath: 'lib/vendor/catalyst/LICENSE.txt', noticePath: 'lib/vendor/catalyst/NOTICE.md'
    },
    createdAt: null, updatedAt: null
  };
}

export const CATALYST_METHODS = frozen(upstream.techniques.map(adapt));
if (new Set(CATALYST_METHODS.map(item => item.id)).size !== CATALYST_METHODS.length) throw new Error('The Catalyst adapter generated duplicate method IDs.');
export const CATALYST_CATALOG_INFO = frozen({
  source: { ...upstream.source, catalogSha256: CATALYST_CATALOG_SHA256 },
  methods: CATALYST_METHODS.length, steps: upstream.counts.steps, specificCatalogWorkflows: upstream.counts.catalogSpecificWorkflows,
  domains: Object.entries(upstream.familyLabels).filter(([id]) => CATALYST_METHODS.some(method => method.catalog.domain === id)).map(([id, label]) => ({ id, label, count: CATALYST_METHODS.filter(method => method.catalog.domain === id).length })),
  clusters: [...new Set(CATALYST_METHODS.map(method => method.catalog.cluster))].sort(),
  phases: upstream.phases,
  playbooks: upstream.playbooks.map(playbook => ({ ...playbook, id: `catalyst-${playbook.id}`, steps: playbook.steps.map(step => ({ ...step, methodId: byName.get(step.name) })) })),
  adapterVersion: CATALYST_ADAPTER_VERSION
});
