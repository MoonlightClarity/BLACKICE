import { buildIntelligenceProject, intelligenceProjectDraft } from './intelligence-planning-model.mjs';

/**
 * BLACKICE intelligence text v1.
 * The Markdown document is canonical. This parser projects entities and explicit
 * references into a visual graph; no conclusions or links are inferred.
 */
export const INTEL_TEXT_HEADER = '# Intelligence Assessment';
export const INTEL_TEXT_FORMAT = 'BLACKICE-INTEL/1';
export const INTEL_MAP_LANES = Object.freeze([
  { id: 'requirements', label: 'Requirements', prefix: 'REQ', hint: 'Essential information needs' },
  { id: 'hypotheses', label: 'Hypotheses', prefix: 'HYP', hint: 'Competing explanations' },
  { id: 'collection', label: 'Collection', prefix: 'COL', hint: 'Sources and tasks' },
  { id: 'evidence', label: 'Evidence', prefix: 'EVD', hint: 'Attributed observations' },
  { id: 'judgments', label: 'Judgments', prefix: 'JDG', hint: 'Supported assessments' }
]);

const metaNames = new Map([
  ['format', 'format'], ['title', 'title'], ['decision', 'decision'],
  ['pir', 'pir'], ['priority intelligence question', 'pir'],
  ['scope', 'scope'], ['product', 'product'], ['working folder', 'cwd']
]);
const trim = value => String(value ?? '').trim();
const ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const canonicalAttr = value => String(value).trim().toLowerCase().replace(/\s+/g, ' ');
const relations = Object.freeze([
  { kind: 'answers', on: 'hypotheses', field: 'answers', references: 'requirements', fromRef: true },
  { kind: 'answers', on: 'collection', field: 'answers', references: 'requirements', fromRef: true },
  { kind: 'tests', on: 'collection', field: 'tests', references: 'hypotheses', fromRef: true },
  { kind: 'supports', on: 'evidence', field: 'supports', references: 'hypotheses', fromRef: true },
  { kind: 'challenges', on: 'evidence', field: 'challenges', references: 'hypotheses', fromRef: true },
  { kind: 'collected', on: 'evidence', field: 'from', references: 'collection', fromRef: true },
  { kind: 'basis', on: 'judgments', field: 'based on', references: 'evidence', fromRef: true },
  { kind: 'evaluates', on: 'judgments', field: 'evaluates', references: 'hypotheses', fromRef: true }
]);
function refs(value) { return trim(value).split(/[,;]\s*/).map(value => trim(value).toUpperCase()).filter(Boolean); }
function issue(line, message) { return { line, message }; }
function isKnownSection(value) {
  return INTEL_MAP_LANES.find(lane => lane.label.toLowerCase() === String(value).trim().toLowerCase());
}

export function parseIntelligenceText(source, { requireBrief = false } = {}) {
  const text = String(source ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n'), fields = { title: '', decision: '', pir: '', scope: '', product: '', cwd: '', format: '' };
  const entities = [], errors = [], warnings = [], byId = new Map();
  let section = null, node = null, sectionIsUnknown = false;
  if (lines[0]?.trim() !== INTEL_TEXT_HEADER) errors.push(issue(1, 'Start with "# Intelligence Assessment".'));
  for (let i = 1; i < lines.length; i++) {
    const value = lines[i], t = value.trim();
    if (!t || t.startsWith('<!--') || t.startsWith('-->')) continue;
    const h = /^##\s+(.+?)\s*$/.exec(value);
    if (h) {
      const known = isKnownSection(h[1]);
      section = known?.id || h[1];
      sectionIsUnknown = !known;
      if (sectionIsUnknown) warnings.push(issue(i + 1, 'Section "' + h[1] + '" is retained as text but has no map projection.'));
      node = null;
      continue;
    }
    if (!section) {
      const m = /^([A-Za-z ]+):\s*(.*)$/.exec(value);
      if (m) {
        const field = metaNames.get(canonicalAttr(m[1]));
        if (field) {
          if (fields[field]) errors.push(issue(i + 1, 'Duplicate "' + m[1] + '" field.'));
          fields[field] = m[2].trim();
        } else warnings.push(issue(i + 1, 'Unrecognized brief field "' + m[1] + '". Retained in text but not mapped.'));
      } else if (t !== INTEL_TEXT_HEADER && !t.startsWith('#')) warnings.push(issue(i + 1, 'This line is outside a recognized section.'));
      continue;
    }
    if (sectionIsUnknown) continue; // preserve additional analyst notes without erasing them
    const lane = INTEL_MAP_LANES.find(item => item.id === section);
    const entry = /^-\s+\[([^\]]+)\]\s+(.+)$/.exec(value);
    if (entry) {
      const id = trim(entry[1]).toUpperCase();
      if (!ID_PATTERN.test(id) || !id.startsWith(lane.prefix + '-')) {
        errors.push(issue(i + 1, 'Use an ID beginning with "' + lane.prefix + '-" (for example ' + lane.prefix + '-1).'));
      }
      if (byId.has(id)) errors.push(issue(i + 1, 'Duplicate entity ID ' + id + '.'));
      node = { id, kind: section, title: trim(entry[2]), attrs: {}, line: i + 1 };
      entities.push(node);
      if (!byId.has(id)) byId.set(id, node);
      continue;
    }
    const attribute = /^\s{2,}([A-Za-z][A-Za-z0-9 -]*):\s*(.*?)\s*$/.exec(value);
    if (attribute && node) {
      const key = canonicalAttr(attribute[1]);
      if (Object.hasOwn(node.attrs, key)) errors.push(issue(i + 1, 'Duplicate "' + attribute[1] + '" on ' + node.id + '.'));
      node.attrs[key] = trim(attribute[2]);
      continue;
    }
    if (/^\s{2,}\S/.test(value) && node) {
      node.title += ' ' + t; // human/LLM-wrapped labels without data loss
      continue;
    }
    if (t.startsWith('-') || t.startsWith('[')) errors.push(issue(i + 1, 'Start an entity with "- [' + lane.prefix + '-1] Description".'));
    else warnings.push(issue(i + 1, 'This line is not part of an entity; it remains in the text.'));
  }
  if (fields.format && fields.format !== INTEL_TEXT_FORMAT) errors.push(issue(2, 'Unsupported format. Use ' + INTEL_TEXT_FORMAT + '.'));
  if (requireBrief && !fields.format) errors.push(issue(2, 'Add Format: ' + INTEL_TEXT_FORMAT + ' so the saved model can be reopened exactly.'));
  const edges = [];
  for (const entity of entities) {
    for (const relation of relations.filter(relation => relation.on === entity.kind)) {
      const list = refs(entity.attrs[relation.field]);
      for (const reference of list) {
        const target = byId.get(reference);
        if (!target) { errors.push(issue(entity.line, entity.id + ' ' + relation.field + ' references missing ' + reference + '.')); continue; }
        if (target.kind !== relation.references) { errors.push(issue(entity.line, entity.id + ' ' + relation.field + ' expects ' + relation.references + ', not ' + target.kind + '.')); continue; }
        const from = relation.fromRef ? target.id : entity.id, to = relation.fromRef ? entity.id : target.id;
        if (!edges.some(edge => edge.from === from && edge.to === to && edge.kind === relation.kind)) edges.push({ from, to, kind: relation.kind, id: [relation.kind, from, to].join(':') });
      }
    }
  }
  if (requireBrief) {
    for (const field of ['title', 'decision', 'pir', 'cwd']) if (!fields[field]) errors.push(issue(0, 'Provide ' + ({ title: 'Title', decision: 'Decision', pir: 'PIR', cwd: 'Working folder' }[field]) + ' before saving.'));
    if (fields.title.length > 160) errors.push(issue(0, 'Assessment title must be 160 characters or fewer.'));
    if (text.length > 8000) errors.push(issue(0, 'Keep the complete text source at or below 8,000 characters for durable project storage.'));
  }
  if (entities.filter(item => item.kind === 'hypotheses').length === 1) warnings.push(issue(0, 'Consider at least one alternative hypothesis.'));
  if (!entities.some(item => item.kind === 'evidence')) warnings.push(issue(0, 'No evidence recorded. The map contains no verified observations.'));
  if (!entities.some(item => item.kind === 'judgments')) warnings.push(issue(0, 'No judgments yet. Do not treat a hypothesis as a conclusion.'));
  return { text, fields, entities, edges, errors, warnings, byId, valid: errors.length === 0 };
}

export function intelligenceStarterText({ cwd = '', title = '', decision = '', pir = '', scope = '', product = '' } = {}) {
  return [
    '# Intelligence Assessment', 'Format: BLACKICE-INTEL/1',
    'Title: ' + trim(title), 'Decision: ' + trim(decision), 'PIR: ' + trim(pir),
    'Scope: ' + trim(scope), 'Product: ' + trim(product), 'Working folder: ' + trim(cwd),
    '',
    '## Requirements',
    '- [REQ-1] DRAFT - state an essential information requirement',
    '  Priority: high',
    '',
    '## Hypotheses',
    '- [HYP-1] DRAFT - first plausible explanation',
    '  Answers: REQ-1',
    '  Indicators: Identify observations expected if true',
    '  Disconfirm: Identify observations that would weaken it',
    '- [HYP-2] DRAFT - competing alternative explanation',
    '  Answers: REQ-1',
    '  Indicators: Identify observations expected if true',
    '  Disconfirm: Identify observations that would weaken it',
    '',
    '## Collection',
    '- [COL-1] DRAFT - locate evidence that distinguishes the hypotheses',
    '  Answers: REQ-1',
    '  Tests: HYP-1, HYP-2',
    '  Source: Sources to be identified',
    '',
    '## Evidence',
    '',
    '## Judgments',
    ''
  ].join('\n');
}

export function intelligenceTextFromProject(project, cwd = '') {
  if (!project) return intelligenceStarterText({ cwd });
  const stored = String(project.context || '').replace(/\r\n/g, '\n');
  // Preserve older or incomplete text-native documents verbatim so the analyst can repair them.
  if (stored.startsWith(INTEL_TEXT_HEADER + '\n')) return stored;
  // Read-only compatibility projection for previously saved form-based plans.
  // Preserve the entire original context below an unparsed heading.
  const legacy = intelligenceProjectDraft(project);
  const base = intelligenceStarterText({ title: legacy.name || project.name, decision: legacy.decision, pir: legacy.question, scope: legacy.scope, product: legacy.product, cwd: project.cwd || cwd });
  const lines = base.split('\n'), beforeEvidence = lines.indexOf('## Evidence');
  const hypotheses = trim(legacy.hypotheses), collection = trim(legacy.collection);
  if (hypotheses) lines.splice(lines.indexOf('## Collection'), 0, '- [HYP-3] DRAFT - ' + hypotheses.replace(/\s+/g, ' ').slice(0, 380), '');
  if (collection) lines.splice(beforeEvidence + (hypotheses ? 2 : 0), 0, '- [COL-2] DRAFT - ' + collection.replace(/\s+/g, ' ').slice(0, 380), '');
  if (stored) lines.push('## Previous saved background', stored, '');
  return lines.join('\n');
}

export function intelligenceProjectFromText(source, previous = null) {
  const parsed = parseIntelligenceText(source, { requireBrief: true });
  if (!parsed.valid) throw Error(parsed.errors.map(item => (item.line ? 'Line ' + item.line + ': ' : '') + item.message).slice(0, 5).join(' | '));
  const f = parsed.fields;
  const skeleton = buildIntelligenceProject({
    name: f.title, decision: f.decision, question: f.pir, scope: f.scope, product: f.product,
    hypotheses: parsed.entities.filter(node => node.kind === 'hypotheses').map(node => node.title).join('; '),
    collection: parsed.entities.filter(node => node.kind === 'collection').map(node => node.title).join('; '),
    cwd: f.cwd
  }, previous);
  return { ...skeleton, context: parsed.text.trimEnd(), objective: [
    '## Decision to inform', f.decision, '',
    '## Priority intelligence question', f.pir, '',
    '## Scope and time horizon', f.scope, '',
    '## Intelligence product and audience', f.product
  ].join('\n') };
}

export function intelligenceMapGeometry(parsed, { availableWidth = 1550 } = {}) {
  // All five lanes fit on a desktop-width panel. Below that threshold, keep
  // legible cards and allow horizontal scrolling instead of crushing text.
  const left = 16, count = INTEL_MAP_LANES.length;
  const measured = Number(availableWidth);
  const target = Math.max(860, Math.floor(Number.isFinite(measured) && measured > 0 ? measured : 1550));
  const preferredGap = target >= 1450 ? 54 : target >= 1200 ? 36 : target >= 1050 ? 26 : 16;
  const colWidth = Math.min(232, Math.floor((target - 2 * left - (count - 1) * preferredGap) / count));
  const columnGap = Math.min(68, Math.max(preferredGap, Math.floor((target - 2 * left - count * colWidth) / (count - 1))));
  const width = 2 * left + count * colWidth + (count - 1) * columnGap;
  const top = 106, step = 142, nodeHeight = 112;
  const groups = INTEL_MAP_LANES.map((lane, index) => ({ ...lane, index, x: left + index * (colWidth + columnGap), nodes: parsed.entities.filter(n => n.kind === lane.id) }));
  const positions = new Map();
  for (const group of groups) for (const [i, entity] of group.nodes.entries()) positions.set(entity.id, { x: group.x, y: top + i * step, width: colWidth, height: nodeHeight });
  const height = Math.max(390, top + Math.max(1, ...groups.map(group => group.nodes.length)) * step + 60);
  return { width, height, colWidth, groups, positions, edges: parsed.edges.filter(edge => positions.has(edge.from) && positions.has(edge.to)) };
}
