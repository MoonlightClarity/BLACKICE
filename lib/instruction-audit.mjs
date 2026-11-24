import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const section = (value, index) => {
  const text = String(value.text ?? '');
  const result = {
    id: String(value.id || 'section-' + (index + 1)),
    title: String(value.title || value.id || 'Instructions'),
    source: String(value.source || 'lib/engine.mjs'),
    role: String(value.role || 'user'),
    layer: String(value.layer || (value.role === 'developer' ? 'developer' : 'prompt')),
    reason: String(value.reason || 'Included by the active runtime'),
    text, characters: text.length, sha256: hash(text),
    status: String(value.status || 'prepared'),
  };
  for (const key of ['revision', 'sourceHash', 'truncated', 'encoding', 'wireCharacters', 'wireSha256', 'providerField', 'toolName', 'origin', 'reviewAudience']) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
};
const totals = (sections, toolCount) => ({
  characters: sections.reduce((sum, item) => sum + item.characters, 0),
  developerCharacters: sections.filter(item => item.layer === 'developer').reduce((sum, item) => sum + item.characters, 0),
  promptInstructionCharacters: sections.filter(item => item.layer === 'prompt').reduce((sum, item) => sum + item.characters, 0),
  toolInstructionCharacters: sections.filter(item => item.layer === 'tool').reduce((sum, item) => sum + item.characters, 0),
  toolDefinitionCharacters: sections.filter(item => item.layer === 'tool-definition').reduce((sum, item) => sum + item.characters, 0),
  sections: sections.length, toolCount,
});

// Description strings are executable context too. Keep their exact decoded text,
// including property descriptions, with field labels instead of a wall of JSON.
function toolDefinitionCapture(tools, { source = 'lib/engine.mjs: dynamicTools', providerField = 'dynamicTools' } = {}) {
  const sections = [], names = [];
  for (const [index, tool] of tools.entries()) {
    const value = tool?.function || tool;
    const name = String(value?.name || tool?.name || tool?.type || 'tool-' + (index + 1));
    names.push(name);
    const descriptions = [];
    const visit = (item, field) => {
      if (!item || typeof item !== 'object') return;
      for (const [key, child] of Object.entries(item)) {
        const path = field ? field + '.' + key : key;
        if (key === 'description' && typeof child === 'string' && child) descriptions.push(path + ':\n' + child);
        else if (child && typeof child === 'object') visit(child, path);
      }
    };
    visit(tool, '');
    const wireText = JSON.stringify(tool);
    sections.push(section({ id: 'tool-definition-' + name + '-' + index, title: name, toolName: name,
      source, role: 'tool-definition', layer: 'tool-definition', text: descriptions.join('\n\n'),
      reason: 'Attached operation description and argument documentation; separate from delivered skill content',
      encoding: 'Exact decoded JSON description strings; field-path labels are added for readability',
      wireCharacters: wireText.length, wireSha256: hash(wireText), providerField: providerField + '[' + index + ']',
    }, sections.length));
  }
  return { sections, tools: { count: names.length, names, sha256: hash(JSON.stringify(tools)), source, providerField, status: 'prepared' } };
}

function withToolDefinitions(audit, tools, options) {
  const capture = toolDefinitionCapture(tools, options);
  const previous = audit.sections.filter(item => item.layer === 'tool-definition');
  const acceptedUnchanged = audit.tools?.status === 'accepted' && audit.tools.sha256 === capture.tools.sha256
    && previous.length === capture.sections.length && capture.sections.every((item, index) =>
      previous[index].status === 'accepted' && previous[index].wireSha256 === item.wireSha256
      && previous[index].sha256 === item.sha256 && previous[index].text === item.text);
  if (acceptedUnchanged) {
    capture.tools.status = 'accepted';
    capture.sections = capture.sections.map(item => ({ ...item, status: 'accepted' }));
  }
  const sections = [...audit.sections.filter(item => item.layer !== 'tool-definition'), ...capture.sections];
  return freeze({ ...audit, sections, tools: capture.tools, totals: totals(sections, capture.tools.count) });
}

// Native thread/resume retains the catalog attached at thread/start. Current
// source must never be presented as a capture of that immutable saved catalog.
export function withSavedToolDefinitions(audit, savedAudit, { names = [], sourceRunId, threadId } = {}) {
  if (!audit?.sections) return audit;
  const saved = savedAudit?.sections?.filter(item => item.layer === 'tool-definition') || [];
  const known = savedAudit?.tools?.status !== 'unavailable' && savedAudit?.tools?.sha256
    && savedAudit.tools.names?.length === names.length && names.every(name => savedAudit.tools.names.includes(name))
    && saved.length === names.length;
  const originalRunId = known ? savedAudit.tools.sourceRunId || sourceRunId : sourceRunId;
  const source = 'Saved native tool catalog' + (originalRunId ? ' from run ' + originalRunId : '');
  const definitions = known ? saved.map(item => ({ ...item, definitionSource: item.definitionSource || item.source,
    source: source + ' — ' + (item.definitionSource || item.source),
    reason: 'Retained by the resumed native thread. Current source definitions were not resent.', status: 'saved',
  })) : [section({ id: 'saved-tool-definitions-unavailable', title: 'Saved native tool definitions',
    source, role: 'tool-definition', layer: 'tool-definition', text: '', status: 'unavailable',
    reason: 'This native thread has saved tool names, but their actual descriptions were not captured. Current definitions are not a substitute. Tools: ' + names.join(', '),
  }, 0)];
  const sections = [...audit.sections.filter(item => item.layer !== 'tool-definition'), ...definitions];
  const tools = { ...(known ? savedAudit.tools : {}), count: names.length, names: [...names], source,
    status: known ? 'saved' : 'unavailable', ...(originalRunId ? { sourceRunId: originalRunId } : {}), ...(threadId ? { threadId } : {}),
    ...(!known ? { sha256: null } : {}),
  };
  return freeze({ ...audit, sections, tools, totals: totals(sections, names.length) });
}

// Capture only instruction sources, never the entire task, profile, or transcript.
// matchText is transient: it proves a decoded source is in the prepared prompt.
export function createInstructionAudit({ developerInstructions = '', prompt = '', sections = [], tools = [], contextSources = [] } = {}) {
  if (typeof developerInstructions !== 'string' || typeof prompt !== 'string') throw new TypeError('Instruction audit inputs must be text.');
  const selected = [];
  let cursor = 0;
  for (const candidate of sections) {
    if (!candidate || typeof candidate.text !== 'string' || !candidate.text && !candidate.captureEmpty) continue;
    if (!candidate.text && candidate.captureEmpty) {
      selected.push(section(candidate, selected.length));
      continue;
    }
    if (candidate.role === 'developer' || candidate.layer === 'developer') {
      selected.push(section({ ...candidate, layer: 'developer' }, selected.length));
      continue;
    }
    const match = candidate.matchText ?? candidate.text;
    const offset = typeof match === 'string' ? prompt.indexOf(match, cursor) : -1;
    if (offset < 0) continue;
    cursor = offset + match.length;
    selected.push(section(candidate, selected.length));
  }
  const describedDeveloper = selected.filter(item => item.layer === 'developer').map(item => item.text).join('');
  const notes = [
    'This records BLACKICE instructions prepared for this execution. Preparation alone does not prove provider acceptance.',
    'Provider-owned instructions, ordinary user task text, USER.md personal facts, conversation history and ordinary tool results are not copied into this instruction audit. The active goal contract is a narrow exception: its objective is captured exactly because the host sends it as developer instructions.',
    'Tool definition descriptions, including argument documentation, are decoded for readability. Field labels are display annotations; the wire hash covers the complete schema. Other schema fields are not duplicated here.',
    'SOUL content is decoded from its active JSON envelope for readability; its revision and any excerpt marker are preserved. Edits take effect at the next execution.',
    'Only captured instruction sources are shown. Earlier runs without a capture cannot be reconstructed exactly from current files.',
  ];
  let captured = selected;
  if (describedDeveloper !== developerInstructions) {
    captured = selected.filter(item => item.layer !== 'developer');
    if (developerInstructions) captured.unshift(section({ id: 'effective-developer', title: 'Effective developer instructions', source: 'lib/engine.mjs', role: 'developer', text: developerInstructions, reason: 'The active execution replaced the usual developer bundle' }, 0));
  }
  return withToolDefinitions({
    version: 1, captureStage: 'engine-prepared', capturedAt: new Date().toISOString(), delivery: 'prepared',
    sections: captured,
    developer: { characters: developerInstructions.length, sha256: hash(developerInstructions) },
    contextSources: structuredClone(contextSources),
    notes,
  }, tools);
}

// Adapters report the exact final high-priority string after their own additions.
// Replace a changed bundle in full instead of pretending old section boundaries fit.
export function withPreparedAdapterInstructions(audit, { developerInstructions = '', adapter = 'unknown', role = 'developer', source = 'runtime adapter', providerField, tools, toolSource = source, toolProviderField = 'tools', preparation } = {}) {
  if (preparation && typeof preparation.id === 'string') {
    const child = withPreparedAdapterInstructions(createInstructionAudit({ developerInstructions,
      prompt: preparation.prompt || '', sections: preparation.sections || [], tools: tools || [] }),
    { developerInstructions, adapter, role, source, providerField, tools, toolSource, toolProviderField });
    return withPreparationInstructionAudit(audit, { id: preparation.id, label: preparation.label, kind: preparation.kind,
      audit: preparation.accepted ? withInstructionAcceptance(child) : child });
  }
  if (!audit || audit.version !== 1 || typeof developerInstructions !== 'string') return audit;
  const current = audit.sections.filter(item => item.layer === 'developer');
  const previous = current.map(item => item.text).join('');
  let developer = [];
  if (developerInstructions.startsWith(previous)) {
    developer = current.map(item => ({ ...item, role, ...(providerField ? { providerField } : {}) }));
    const extra = developerInstructions.slice(previous.length);
    if (extra) developer.push(section({ id: 'adapter-addendum-' + (current.length + 1), title: 'Runtime adapter additions', source, role, layer: 'developer', text: extra, reason: 'Added by ' + adapter + ' after engine composition', providerField }, developer.length));
  } else if (developerInstructions) {
    developer = [section({ id: 'adapter-developer', title: 'Final runtime instructions', source, role, layer: 'developer', text: developerInstructions, reason: 'The adapter supplied a different effective instruction string', providerField }, 0)];
  }
  const sections = [...developer, ...audit.sections.filter(item => item.layer !== 'developer')];
  const updated = { ...audit, captureStage: 'adapter-prepared', adapter,
    sections, totals: totals(sections, audit.tools.count),
    developer: { characters: developerInstructions.length, sha256: hash(developerInstructions), role, ...(providerField ? { providerField } : {}) },
  };
  return Array.isArray(tools) ? withToolDefinitions(updated, tools, { source: toolSource, providerField: toolProviderField }) : freeze(updated);
}

export function withInstructionAcceptance(audit) {
  return audit?.version === 1 ? freeze({ ...audit, delivery: 'accepted', acceptedAt: new Date().toISOString(),
    tools: { ...audit.tools, status: ['unavailable', 'saved'].includes(audit.tools?.status) ? audit.tools.status : 'accepted' },
    sections: audit.sections.map(item => ({ ...item, status: ['unavailable', 'saved'].includes(item.status) ? item.status : 'accepted' })),
  }) : audit;
}

export function withDeliveredSkillInstructions(audit, skill, wireText) {
  if (!audit?.sections || typeof skill?.content !== 'string' || !skill.content || typeof wireText !== 'string') return audit;
  const digest = hash(skill.content), sourceRevision = skill.source === 'user' ? skill.revision : skill.provenance?.revision ?? skill.revision;
  const id = 'loaded-skill-' + skill.id + '-' + digest.slice(0, 16);
  const existing = audit.sections.find(item => item.id === id);
  const sections = existing ? audit.sections.map(item => item.id === id ? { ...item, deliveries: (item.deliveries || 1) + 1 } : item) : [...audit.sections, {
    ...section({ id, title: skill.title || skill.id, source: (skill.source === 'user' ? 'Owner skill: ' : 'Bundled skill: ') + skill.id,
      role: 'tool', layer: 'tool', revision: sourceRevision, text: skill.content, status: 'delivered',
      encoding: 'Skill tool result JSON.content', wireCharacters: wireText.length, wireSha256: hash(wireText),
      reason: 'Read on demand and delivered by relay_skills during this execution' }, audit.sections.length), deliveries: 1,
  }];
  return freeze({ ...audit, sections, totals: totals(sections, audit.tools.count) });
}

export function withDelegateInstructionAudit(parent, { id, nodeId, label, audit } = {}) {
  if (!parent || parent.version !== 1 || !audit || typeof id !== 'string') return parent;
  const record = { id, nodeId: String(nodeId || id), label: String(label || id), audit };
  const previous = parent.delegates || [];
  const delegates = previous.some(item => item.id === id) ? previous.map(item => item.id === id ? record : item) : [...previous, record];
  return freeze({ ...parent, delegates });
}

export function withPreparationInstructionAudit(parent, { id, label, kind, audit } = {}) {
  if (!audit || typeof id !== 'string') return parent;
  const current = parent?.version === 1 ? parent : { ...createInstructionAudit(), captureStage: 'preparation-only',
    notes: ['The main execution has not been prepared. Captured preparation requests are shown separately.'] };
  const record = { id, label: String(label || id), ...(kind ? { kind: String(kind) } : {}), audit };
  const previous = current.preparations || [];
  const preparations = previous.some(item => item.id === id) ? previous.map(item => item.id === id ? record : item) : [...previous, record];
  return freeze({ ...current, preparations });
}

export function identityAuditSources(identity) {
  if (!identity?.documents?.soul || typeof identity.text !== 'string') return { sections: [], contextSources: [] };
  const soul = identity.documents.soul, user = identity.documents.user;
  const line = identity.text.split('\n').find(value => value.startsWith('SOUL_DOCUMENT='));
  const preamble = identity.text.slice(0, identity.text.indexOf('\n'));
  return {
    sections: [
      { id: 'identity-context', title: 'Identity context envelope', source: 'lib/identity.mjs', role: 'user', text: preamble, reason: 'Explains the active identity snapshot' },
      ...(line ? [{ id: 'soul', title: 'SOUL.md — active behavior', source: 'SOUL.md', role: 'user', revision: soul.revision, sourceHash: soul.hash, truncated: soul.truncated, text: soul.content, matchText: line, encoding: 'SOUL_DOCUMENT.content JSON string', wireCharacters: line.length, wireSha256: hash(line), reason: 'Owner-controlled behavior captured at execution admission' }] : []),
    ],
    contextSources: user ? [{ id: 'user-profile', title: 'USER.md personal facts', role: 'user', kind: 'data', revision: user.revision, characters: user.content.length, sha256: hash(user.content), truncated: user.truncated }] : [],
  };
}
