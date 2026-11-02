/**
 * Bounded, deterministic XML authoring view of planning modules.
 * The saved graph, provenance and tool outcomes remain host-controlled. XML
 * edits can only change declared module inputs through the revisioned API.
 */
import { planningModuleTemplate, planningOutlineRows } from './planning-browser-model.mjs';

export const PLANNING_PROGRAM_XML_VERSION = 1;
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
export const planningXmlEscape = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);
function invalid(message) { throw Object.assign(new Error(message), { code: 'PLANNING_XML_INVALID' }); }
function decode(value) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(value) || /[<>]/.test(value)) invalid('Module XML contains unsupported markup or an entity.');
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]);
}
const field = (name, value, indent = '  ') => indent + '<' + name + '>' + planningXmlEscape(value) + '</' + name + '>';
const editableFields = node => [
  field('kind', node.kind), field('title', node.title),
  field('prompt', node.prompt), field('done-when', node.doneWhen || ''),
  field('skip-reason', node.skipReason || '')
];
export function planningModuleXml(node) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(node?.id || '')) invalid('Module ID must be a saved, stable ID.');
  planningModuleTemplate(node.kind);
  return '<module version="1" id="' + node.id + '">\n' + editableFields(node).join('\n') + '\n</module>';
}

/** Export of the *actual* saved recursive outline; not a fabricated execution log. */
export function planningProgramXml(request) {
  const rows = planningOutlineRows(request);
  const result = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<planning-program version="1" request-id="' + planningXmlEscape(request.id) + '" revision="' + Number(request.revision) + '">',
    field('objective', request.objective, '  '), '  <outline>'];
  let depth = 0;
  for (const node of rows) {
    while (depth > node.depth) { depth--; result.push('    '.repeat(depth + 2) + '</module>'); }
    const prefix = '    '.repeat(node.depth + 2);
    result.push(prefix + '<module id="' + planningXmlEscape(node.id) + '" number="' + planningXmlEscape(node.number) +
      '" kind="' + planningXmlEscape(node.kind) + '" state="' + planningXmlEscape(node.readiness?.state || 'pending') + '">');
    for (const [name, value] of [['title', node.title], ['prompt', node.prompt], ['done-when', node.doneWhen || ''], ['skip-reason', node.skipReason || '']])
      result.push(field(name, value, prefix + '  '));
    depth = node.depth + 1;
  }
  while (depth > 0) { depth--; result.push('    '.repeat(depth + 2) + '</module>'); }
  result.push('  </outline>', '</planning-program>');
  return result.join('\n');
}

/** Strict single-module XML input: no DTD, entities, namespaces, or extra fields. */
export function parsePlanningModuleXml(source, { expectedId } = {}) {
  if (typeof source !== 'string' || source.length > 22000 || /<!|<\?/.test(source)) invalid('Use one bounded module XML element without declarations or directives.');
  const root = /^\s*<module version="1" id="([A-Za-z0-9][A-Za-z0-9_-]{0,119})">([\s\S]*?)<\/module>\s*$/.exec(source);
  if (!root) invalid('Expected one <module version="1" id="..."> element.');
  if (expectedId && root[1] !== expectedId) invalid('The XML module ID does not match the selected saved module.');
  let body = root[2];
  const result = {};
  for (const [tag, key] of [['kind', 'kind'], ['title', 'title'], ['prompt', 'prompt'], ['done-when', 'doneWhen'], ['skip-reason', 'skipReason']]) {
    const expression = new RegExp('^\\s*<' + tag + '>([^<>]*)<\\/' + tag + '>');
    const match = expression.exec(body);
    if (!match) invalid('Missing or malformed <' + tag + '> field.');
    result[key] = decode(match[1]).trim();
    body = body.slice(match[0].length);
  }
  if (body.trim()) invalid('The module XML contains unsupported fields.');
  planningModuleTemplate(result.kind);
  if (!result.title || !result.prompt) invalid('Every module needs a title and one bounded question or instruction.');
  if (result.doneWhen.length > 1000 || result.skipReason.length > 1000 ||
      result.title.length > 240 || result.prompt.length > 12000) invalid('A module field exceeds its saved bound.');
  if (result.kind === 'action' && !result.doneWhen) invalid('An executable action needs an observable completion check.');
  if (result.skipReason && ['cycle', 'viability', 'inference', 'plan', 'think', 'respond'].includes(result.kind))
    invalid('Required response-cycle stages cannot be skipped through optional-module XML.');
  return { id: root[1], patch: result };
}


/**
 * Parse the complete planning outline as bounded XML. Derived number/state
 * attributes are presentation only; the host recalculates them after saving.
 * This parser intentionally supports no DTD, comments, namespaces, arbitrary
 * attributes, processing instructions or entity references.
 */
export function parsePlanningProgramXml(source) {
  if (typeof source !== 'string' || source.length > 512000) invalid('Planning program XML exceeds its edit bound.');
  const declaration = /^\s*<\?xml version="1\.0" encoding="UTF-8"\?>\s*/.exec(source);
  if (!declaration) invalid('Expected the versioned UTF-8 planning XML declaration.');
  const body = source.slice(declaration[0].length);
  if (/<!|<\?/.test(body)) invalid('Planning XML cannot contain directives, comments or external entities.');
  const tokens = body.match(/<[^>]*>|[^<]+/g) || [];
  if (tokens.join('') !== body) invalid('Malformed planning XML.');
  const stack = [], nodes = [], identities = new Set();
  let requestId = '', revision = 0, objective = '', outlineFound = false;
  const requiredFields = ['title', 'prompt', 'done-when', 'skip-reason'];
  const top = () => stack.at(-1);
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (top()?.field) top().raw += token;
      else if (token.trim()) invalid('Unexpected free text in planning XML.');
      continue;
    }
    if (/^<\/[a-z-]+>$/.test(token)) {
      const name = token.slice(2, -1);
      if (top()?.name !== name) invalid('Planning XML elements must be properly nested.');
      const closed = stack.pop();
      if (closed.field) {
        const parent = top();
        const value = decode(closed.raw).trim();
        if (name === 'objective') {
          if (parent?.name !== 'planning-program') invalid('Objective must belong to the planning program.');
          objective = value;
        } else {
          if (parent?.name !== 'module') invalid('Module fields must belong to their module.');
          parent.node[name] = value;
        }
      } else if (name === 'module') {
        if (requiredFields.some(field => !Object.hasOwn(closed.node, field))) invalid('Each module needs every declared field.');
        if (!closed.node.title) invalid('Modules need a bounded title.');
        if (closed.node.title.length > 240 || closed.node.prompt.length > 12000 ||
            closed.node['done-when'].length > 1000 || closed.node['skip-reason'].length > 1000)
          invalid('A planning module field exceeds its saved bound.');
        // Existing action drafts may lack done-when; the runtime prevents execution
        // until one is saved, and new XML leaves must supply it.
        if (closed.node['skip-reason'] && ['cycle', 'viability', 'inference', 'plan', 'think', 'respond'].includes(closed.node.kind))
          invalid('Mandatory response-cycle stages cannot be skipped.');
      }
      continue;
    }
    if (token === '<outline>') {
      if (top()?.name !== 'planning-program' || outlineFound) invalid('Expected one outline inside the planning program.');
      outlineFound = true; stack.push({ name: 'outline' }); continue;
    }
    if (token === '<objective>' || requiredFields.some(name => token === '<' + name + '>')) {
      const name = token.slice(1, -1), parent = top();
      if (name === 'objective') {
        if (parent?.name !== 'planning-program' || objective) invalid('Expected one objective before the outline.');
      } else {
        if (parent?.name !== 'module' || Object.hasOwn(parent.node, name) || parent.startedChildren)
          invalid('Module fields must be unique and appear before child modules.');
      }
      stack.push({ name, field: true, raw: '' }); continue;
    }
    const root = /^<planning-program version="1" request-id="([A-Za-z0-9][A-Za-z0-9_-]{0,119})" revision="([1-9][0-9]*)">$/.exec(token);
    if (root) {
      if (stack.length) invalid('Expected one planning program root.');
      requestId = root[1]; revision = Number(root[2]);
      if (!Number.isSafeInteger(revision)) invalid('Planning revision must be an integer.');
      stack.push({ name: 'planning-program' }); continue;
    }
    const module = /^<module id="([A-Za-z0-9][A-Za-z0-9_-]{0,119})" number="([1-9][0-9]*(?:\.[1-9][0-9]*)*)" kind="([a-z_]+)" state="([A-Za-z0-9_-]+)">$/.exec(token);
    if (module) {
      const parent = top();
      if (!['module', 'outline'].includes(parent?.name)) invalid('Modules must be nested inside the outline.');
      if (parent.name === 'module') {
        if (requiredFields.some(field => !Object.hasOwn(parent.node, field)))
          invalid('Complete a module definition before adding nested substeps.');
        parent.startedChildren = true;
      }
      if (identities.has(module[1])) invalid('Module IDs must be unique.');
      identities.add(module[1]);
      if (nodes.length >= 500 || stack.filter(item => item.name === 'module').length >= 32)
        invalid('Planning modules exceed the capacity or nesting bound.');
      planningModuleTemplate(module[3]);
      const node = { id: module[1], parentId: parent.name === 'module' ? parent.node.id : null,
        kind: module[3], number: module[2], displayState: module[4] };
      nodes.push(node);
      stack.push({ name: 'module', node, startedChildren: false }); continue;
    }
    invalid('Planning XML contains an unsupported element or attribute.');
  }
  if (stack.length || !requestId || !outlineFound || !objective) invalid('Planning XML is incomplete.');
  return { requestId, expectedRevision: revision, objective,
    nodes: nodes.map(node => ({ id: node.id, parentId: node.parentId, kind: node.kind,
      title: node.title, prompt: node.prompt, doneWhen: node['done-when'],
      skipReason: node['skip-reason'] })) };
}
