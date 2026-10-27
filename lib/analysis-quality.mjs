/**
 * Text-native, source-linked analytical judgments.
 * Structural validation alone cannot certify an inference as true; these checks
 * ensure a substantive interpretation is at least recorded and reviewable.
 */
const clean = value => String(value ?? '').trim();
const lineFields = Object.freeze(['sources', 'inference', 'alternative', 'implication']);
const ID = /^J[1-9][0-9]*$/i;

export function parseAnalyticalJudgments(source = '') {
  const judgments = [], errors = [], allLines = String(source ?? '').split(/\r?\n/);
  let current = null;
  for (const [index, raw] of allLines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const header = /^J([1-9]\d*):\s*(.+)$/i.exec(line);
    if (header) {
      const id = 'J' + header[1];
      if (judgments.some(row => row.id === id)) errors.push('Duplicate analytical judgment ' + id + '.');
      current = { id, claim: clean(header[2]), fields: {}, line: index+1 };
      judgments.push(current);
      continue;
    }
    // A model may record Confidence and Disconfirm on the same source line.
    // Parse each explicitly labeled span independently rather than swallowing
    // the second label into the first field's value.
    const fields = [...line.matchAll(/(?:^|\s)(Sources|Inference|Alternative|Implication|Confidence|Disconfirm):\s*/gi)];
    if (fields.length && current && fields[0].index === 0) {
      for (let offset=0; offset<fields.length; offset++) {
        const match=fields[offset], next=fields[offset+1];
        const field=match[1].toLowerCase();
        const content=line.slice(match.index+match[0].length,next?.index ?? line.length);
        if (Object.hasOwn(current.fields,field)) errors.push('Repeated '+field+' field on '+current.id+'.');
        current.fields[field]=clean(content);
      }
      continue;
    }
    if (current && /^(J\d+|Sources|Inference|Alternative|Implication|Confidence|Disconfirm):/i.test(line)) errors.push('Malformed analytical record on line '+(index+1)+'.');
  }
  return { judgments, errors };
}

function stepIds(list) {
  return clean(list).split(/[,;\s]+/).map(value => clean(value).replace(/^[^A-Za-z0-9_-]+|[^A-Za-z0-9_-]+$/g,'')).filter(Boolean);
}
export function validateJudgmentLedger(source, unitSteps = [], { required = 2 } = {}) {
  const parsed = parseAnalyticalJudgments(source);
  const errors=[...parsed.errors];
  const unitMap=new Map(unitSteps.map(item => [item.id,item]));
  const available=parsed.judgments;
  if (available.length < required) errors.push('Record at least '+required+' substantive analytical judgments, each with an evidence-to-inference chain.');
  let integrated = 0;
  for(const judgment of available) {
    if (judgment.claim.length < 18) errors.push(judgment.id+' needs a specific, informative judgment.');
    const refs=[...new Set(stepIds(judgment.fields.sources))];
    if (refs.length>=2) integrated++;
    if (!refs.length) errors.push(judgment.id+' needs source unit IDs, not just page ranges.');
    for(const id of refs) {
      const source=unitMap.get(id);
      if (!source) errors.push(judgment.id+' refers to an unknown unit_analysis step '+id+'.');
      else if (source.status!=='done') errors.push(judgment.id+' source '+id+' has not been analyzed yet.');
    }
    for(const name of lineFields.filter(name => name!=='sources')) {
      if (clean(judgment.fields[name]).length < 35)
        errors.push(judgment.id+' needs a substantive '+name+' statement (not a one-line slogan).');
    }
  }
  if(available.length && integrated===0) errors.push('At least one judgment must integrate two distinct completed source units. A list of individual role summaries is not cross-record analysis.');
  return { ...parsed, errors, valid: !errors.length, integrated, ids: available.map(row => row.id) };
}

function label(source, name) {
  const match = String(source||'').match(new RegExp('^'+name+':\\s*(.+)$','im'));
  return clean(match?.[1]);
}
export function calibrationNotes(source) {
  const parsed=parseAnalyticalJudgments(source);
  return parsed.judgments.flatMap(j=>['alternative','disconfirm','confidence'].filter(k=>!clean(j.fields[k])).map(k=>({id:j.id,missing:k})));
}

/**
 * Inspect what the saved argument actually records, without judging its truth.
 * Explicit step:<id> references are machine-checkable. Ordinary page/section
 * citations and prose remain valid source forms and are not guessed into IDs.
 * No judgment count, text length or mandatory analytic method is imposed.
 */
export function inspectJudgmentTraceability(steps = []) {
  const actions = steps.filter(step => (step.kind || 'action') === 'action');
  const byId = new Map(actions.map(step => [step.id, step]));
  const records = [], findings = [], referenceErrors = [];
  for (const step of actions.filter(step => step.status === 'done')) {
    const parsed = parseAnalyticalJudgments(step.evidence);
    for (const error of parsed.errors) findings.push({ stepId: step.id, kind: 'record_shape', detail: error });
    for (const judgment of parsed.judgments) {
      const refs = [...new Set([...clean(judgment.fields.sources).matchAll(/\bstep:([A-Za-z0-9][A-Za-z0-9_-]{0,119})\b/g)].map(match => match[1]))];
      const missing = ['sources', 'inference'].filter(field => !clean(judgment.fields[field]));
      for (const field of missing) findings.push({ stepId: step.id, judgmentId: judgment.id, kind: 'missing_' + field });
      for (const sourceId of refs) {
        const source = byId.get(sourceId);
        const kind = !source ? 'unknown_source_step' : sourceId === step.id ? 'self_reference' : source.status !== 'done' ? 'unfinished_source_step' : null;
        if (kind) {
          const issue = { stepId: step.id, judgmentId: judgment.id, sourceId, kind };
          findings.push(issue); referenceErrors.push(issue);
        }
      }
      records.push({ stepId: step.id, id: judgment.id, sourceStepIds: refs,
        hasAlternative: Boolean(clean(judgment.fields.alternative)),
        hasDisconfirm: Boolean(clean(judgment.fields.disconfirm)),
        hasConfidenceBasis: Boolean(clean(judgment.fields.confidence)) });
    }
  }
  return { source: 'agent-reported-records', judgments: records, findings, referenceErrors,
    note: 'Recorded references and labels do not verify source accuracy, independence, comprehension or inference quality.' };
}

export function validateJudgmentAudit(source, ids = []) {
  const seen=[...new Set(stepIds(label(source,'Judgments checked')).map(x=>x.toUpperCase()))];
  const gaps=ids.filter(id=>!seen.includes(id));
  const weak=label(source,'Weak points'), resolution=label(source,'Disposition');
  const errors=[];
  if(gaps.length) errors.push('The evidence audit must check each synthesized judgment: '+gaps.join(', ')+'.');
  if(weak.length<30) errors.push('Record specific rival evidence, missing information, or failure modes under Weak points.');
  if(resolution.length<30) errors.push('Record the defended, revised, or unresolved judgment disposition.');
  return { valid: !errors.length, errors, checked:seen };
}

export function validateJudgmentDelivery(source, ids = []) {
  const delivered=[...new Set(stepIds(label(source,'Judgments delivered')).map(x=>x.toUpperCase()))];
  const gaps=ids.filter(id=>!delivered.includes(id));
  return {valid:gaps.length===0,missing:gaps};
}

/**
 * Selection for automatically injected guidance, never an access restriction.
 * A completed run, repeated assistant claims, or a confidence label does not
 * independently establish that a generated procedure improves the user's goal.
 * The current schema records observations and authorship, not such validation.
 * Keep generated methods available through explicit scoped knowledge tools.
 */
export function createAutomaticKnowledgeAdmission(learningEntries = []) {
  const records = new Map(learningEntries.filter(Boolean).map(item => [item.knowledgeId || item.id, item]));
  return entry => {
    const learned = records.get(entry?.knowledgeId || entry?.id);
    const provenance = entry?.knowledgeProvenance || entry?.provenance
      || learned?.knowledgeProvenance || learned?.provenance;
    if (provenance?.source === 'user') return true;
    // Facts retain their status as contextual data, not independent verification.
    if (learned?.kind === 'fact' || entry?.kind === 'fact' || entry?.memoryType === 'fact') return true;
    const generated = Boolean(learned) || entry?.kind === 'skill' || entry?.kind === 'strategy'
      || provenance?.source === 'learning'
      || /^learning-/.test(provenance?.nodeId || '');
    return !generated;
  };
}

export function selectAutomaticLearning(original, { admit } = {}) {
  if (!original) return original;
  const allowed = admit || createAutomaticKnowledgeAdmission([...(original.skills || []), ...(original.lessons || [])]);
  const skills = (original.skills || []).filter(allowed), lessons = (original.lessons || []).filter(allowed);
  return {
    ...original,
    skills, lessons,
    // Facts and user-provided constraints retain their existing separate status.
    facts:original.facts||[],
    filteredTentative: (original.skills||[]).length+(original.lessons||[]).length
      -skills.length-lessons.length
  };
}

// Historical callers retain the same API, with task-independent selection.
export function createDocumentKnowledgeAdmission(_contract, learningEntries = []) {
  return createAutomaticKnowledgeAdmission(learningEntries);
}
export function selectLearningForDocumentAnalysis(_contract, original, options = {}) {
  return selectAutomaticLearning(original, options);
}
