const string = value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const list = value => Array.isArray(value) ? value : [];
const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
const formatCount = value => count(value).toLocaleString();
const sectionRole = section => section.layer === 'tool-definition' ? 'tool-definition' : string(section.role);
const roleName = role => ({developer:'Developer / system layer',system:'System layer',user:'Prompt layer',tool:'Delivered skill instructions','tool-definition':'Tool definitions'})[role] || string(role) || 'Unspecified layer';
const stageName = stage => stage === 'adapter-prepared' ? 'Captured at the model adapter' : stage === 'engine-prepared' ? 'Captured before the model adapter' : string(stage) || 'Capture boundary not recorded';
const sectionScope = section => section.truncated === true ? 'Excerpt — middle omitted' : '';
const instructionCounts = audit => [['Developer / system instructions', audit.totals?.developerCharacters], ['Prompt instructions', audit.totals?.promptInstructionCharacters], ['Tool definitions', audit.totals?.toolDefinitionCharacters], ['Delivered skill instructions', audit.totals?.toolInstructionCharacters]].filter(([,value]) => Number.isFinite(value) && value >= 0).map(([label,value]) => label + ': ' + formatCount(value) + ' characters');
const notesOf = audit => typeof audit?.notes === 'string' ? [audit.notes] : list(audit?.notes).filter(value => typeof value === 'string');
const sectionsOf = audit => list(audit?.sections).filter(section => section && typeof section === 'object');
const validAudit = audit => audit?.version === 1 && Array.isArray(audit.sections);
const noSnapshot = 'This turn has no saved instruction snapshot. Current files cannot reconstruct what the model received.';
const pendingSnapshot = 'No instruction snapshot has been captured for this execution yet.';
const make = (doc, tag, value = '', className = '') => {
  const node = doc.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
};

/** A readable export of captured instructions. No current-source reconstruction. */
export function instructionAuditText(record, seen = new Set()) {
  const lines = seen.size ? [] : ['BLACKICE INSTRUCTION AUDIT', 'Turn: ' + string(record?.runId), ''];
  const nodes = list(record?.nodes);
  if (!nodes.some(node => validAudit(node?.audit))) return lines.concat(noSnapshot, '').join('\n');
  for (const node of nodes) {
    lines.push('EXECUTION: ' + (string(node.name) || string(node.nodeId)), 'Node: ' + string(node.nodeId));
    const audit = node.audit;
    if (!validAudit(audit)) { lines.push('Instruction snapshot unavailable for this execution.', ''); continue; }
    if (seen.has(audit)) { lines.push('Repeated audit reference; see its earlier section.', ''); continue; }
    seen.add(audit);
    lines.push(stageName(audit.captureStage));
    if (audit.capturedAt) lines.push('Captured: ' + string(audit.capturedAt));
    lines.push('Recorded instruction characters: ' + formatCount(audit.totals?.characters), ...instructionCounts(audit), '');
    for (const note of notesOf(audit)) lines.push('Note: ' + note);
    for (const [index, section] of sectionsOf(audit).entries()) {
      lines.push('', '=== ' + (index + 1) + '. ' + (string(section.title) || string(section.id) || 'Instruction section') + ' ===',
        'Layer: ' + roleName(sectionRole(section)), 'Source: ' + (string(section.source) || 'Source not recorded'));
      for (const [label, value] of [['Revision', section.revision], ['Included because', section.reason],
        ['Status', section.status], ['Request field', section.providerField], ['Scope', sectionScope(section)], ['Deliveries', section.deliveries], ['Delivery encoding', section.encoding || section.deliveryEncoding], ['SHA-256', section.sha256]]) {
        if (string(value)) lines.push(label + ': ' + string(value));
      }
      lines.push('Characters: ' + formatCount(typeof section.text === 'string' ? section.text.length : section.characters), '',
        typeof section.text === 'string' ? section.text : '(No text captured.)');
    }
    const sources = list(audit.contextSources);
    if (sources.length) {
      lines.push('', 'DATA CONTEXT — METADATA ONLY');
      for (const source of sources) {
        lines.push((string(source.title) || string(source.id) || 'Context') + ': ' +
          formatCount(source.characters) + ' characters' + (string(source.revision) ? '; revision ' + string(source.revision) : '') +
          (source.truncated ? '; excerpted' : '') + (string(source.sha256) ? '; SHA-256 ' + source.sha256 : ''));
      }
    }
    if (audit.tools) lines.push('', 'ATTACHED TOOLS', 'Count: ' + formatCount(audit.tools.count),
      'Names: ' + list(audit.tools.names).filter(value => typeof value === 'string').join(', '),
      ...(string(audit.tools.sha256) ? ['Schema SHA-256: ' + audit.tools.sha256] : []));
    lines.push('');
    for (const [key, label, missing] of [
      ['preparations', 'PLANNING PREPARATION', 'This planning preparation has no saved instruction snapshot.'],
      ['delegates', 'DELEGATED WORKER', 'This delegated worker has no saved instruction snapshot.'],
    ]) for (const child of list(audit[key])) {
      const childLabel = key === 'preparations' && child.kind === 'context-summary' ? 'CONTEXT SUMMARY' : label;
      lines.push(childLabel + ': ' + (string(child.label) || string(child.id) || 'Execution'));
      if (!validAudit(child.audit)) lines.push(missing, '');
      else lines.push(instructionAuditText({runId:record?.runId,nodes:[{nodeId:child.nodeId || child.id,name:child.label || child.id,audit:child.audit}]},seen));
    }

    seen.delete(audit);
  }
  return lines.join('\n');
}

/** DOM text nodes keep instruction text inert, including HTML and Markdown. */
export function renderInstructionAudit(container, audit, seen = new Set()) {
  const doc = container.ownerDocument;
  container.replaceChildren();
  if (!validAudit(audit)) { container.append(make(doc, 'p', noSnapshot, 'next-help')); return; }
  if (seen.has(audit)) { container.append(make(doc,'p','Repeated audit reference; see its earlier section.','next-help')); return; }
  seen.add(audit);
  const summary = make(doc, 'div', '', 'next-instruction-summary');
  summary.append(make(doc, 'strong', stageName(audit.captureStage)),
    make(doc, 'p', sectionsOf(audit).length + ' sections · ' + formatCount(audit.totals?.characters) + ' characters' +
      (audit.tools ? ' · ' + formatCount(audit.tools.count) + ' attached tools' : ''), 'next-help'));
  const counts = instructionCounts(audit);
  if (counts.length) summary.append(make(doc, 'p', counts.join(' · '), 'next-help'));
  if (audit.capturedAt) summary.append(make(doc, 'p', 'Captured ' + string(audit.capturedAt), 'next-help'));
  summary.append(make(doc, 'p', 'These are the instructions recorded for this execution. Later SOUL or skill edits do not change this record.', 'next-help'));
  container.append(summary);
  for (const note of notesOf(audit)) container.append(make(doc, 'p', note, 'next-instruction-note'));
  const groups = new Map();
  for (const [index, section] of sectionsOf(audit).entries()) {
    const role = sectionRole(section);
    if (!groups.has(role)) {
      const group = make(doc, 'section', '', 'next-instruction-layer');
      group.append(make(doc, 'h3', roleName(role)));
      if (role === 'tool-definition') group.append(make(doc, 'p', 'Descriptions and parameter guidance advertised to the model for this execution.', 'next-help'));
      container.append(group); groups.set(role, group);
    }
    const detail = make(doc, 'details', '', 'next-instruction-section');
    const label = make(doc, 'summary');
    label.append(make(doc, 'span', (index + 1) + '. ' + (string(section.title) || string(section.id) || 'Instruction section')),
      make(doc, 'small', formatCount(typeof section.text === 'string' ? section.text.length : section.characters) + ' characters' + (sectionScope(section) ? ' · ' + sectionScope(section) : '')));
    detail.append(label);
    const meta = make(doc, 'dl', '', 'next-instruction-source');
    for (const [name, value] of [['Source', section.source || 'Source not recorded'], ['Revision', section.revision],
      ['Included because', section.reason], ['Status', section.status], ['Request field', section.providerField], ['Scope', sectionScope(section)], ['Deliveries', section.deliveries], ['Delivery encoding', section.encoding || section.deliveryEncoding]]) {
      if (!string(value)) continue;
      meta.append(make(doc, 'dt', name), make(doc, 'dd', string(value)));
    }
    detail.append(meta);
    const body = make(doc, 'div', typeof section.text === 'string' ? section.text : '(No text captured.)', 'next-instruction-text');
    detail.append(body);
    if (string(section.sha256)) detail.append(make(doc, 'p', 'SHA-256: ' + section.sha256, 'next-instruction-hash'));
    groups.get(role).append(detail);
  }
  if (list(audit.contextSources).length || audit.tools) {
    const metadata = make(doc, 'details', '', 'next-instruction-section');
    metadata.append(make(doc, 'summary', 'Other context and tool metadata'));
    for (const source of list(audit.contextSources)) metadata.append(make(doc, 'p',
      (string(source.title) || string(source.id) || 'Context') + ' · ' + formatCount(source.characters) + ' characters' +
      (string(source.revision) ? ' · revision ' + string(source.revision) : '') + (source.truncated ? ' · excerpted' : ''), 'next-help'));
    if (audit.tools) metadata.append(make(doc, 'p', 'Attached tools: ' + list(audit.tools.names).filter(value => typeof value === 'string').join(', '), 'next-help'));
    container.append(metadata);
  }
  for (const [key, label, missing] of [
    ['preparations', 'Planning preparation', 'This planning preparation has no saved instruction snapshot.'],
    ['delegates', 'Delegated worker', 'This delegated worker has no saved instruction snapshot.'],
  ]) for (const child of list(audit[key])) {
    const detail=make(doc,'details','','next-instruction-section next-instruction-nested '+(key==='preparations'?'next-instruction-preparation':'next-instruction-worker'));
    const childLabel=key==='preparations'&&child.kind==='context-summary'?'Context summary':label;
    detail.append(make(doc,'summary',childLabel+' · '+(string(child.label)||string(child.id)||'Execution')));
    detail.append(make(doc,'p','Separate instruction snapshot · '+(string(child.nodeId)||string(child.id)),'next-help'));
    const body=make(doc,'div');detail.append(body);container.append(detail);
    if(validAudit(child.audit))renderInstructionAudit(body,child.audit,seen);
    else body.append(make(doc,'p',missing,'next-help'));
  }

  seen.delete(audit);
}
