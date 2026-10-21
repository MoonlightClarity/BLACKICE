/** Shared, provider-neutral outline validation and literal prompt rendering. */
export const PROMPT_TEMPLATE_LIMITS = Object.freeze({ textChars: 50_000, titleChars: 120, descriptionChars: 400, idChars: 100, variableChars: 64, documentBytes: 512 * 1024 });
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const fail = message => Object.assign(new Error(message), { status: 400, code: 'PROMPT_TEMPLATE_INVALID' });
const identifier = (value, label = 'ID') => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw fail(`${label} must contain 1 to 100 letters, numbers, underscores or hyphens.`); return value; };
const string = (value, label, maximum, required = false) => { if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || required && !value.trim()) throw fail(`${label} must be ${required ? 'nonempty ' : ''}text of at most ${maximum.toLocaleString()} characters.`); return value; };
const variables = value => [...value.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g)].map(match => match[1]);
const label = value => value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, char => char.toUpperCase());
const metadataKeys = ['revision', 'builtin', 'deleted', 'createdAt', 'updatedAt', 'action', 'provenance', 'restoredFromRevision'];

export function validatePromptTemplate(value, { allowMetadata = true } = {}) {
  if (!plain(value) || Object.keys(value).some(key => !['id', 'title', 'description', 'sections', ...(allowMetadata ? metadataKeys : [])].includes(key))) throw fail('Choose a prompt title, description and ordered sections.');
  const result = { ...(value.id === undefined ? {} : { id: identifier(value.id, 'Prompt ID') }), title: string(value.title, 'Prompt title', PROMPT_TEMPLATE_LIMITS.titleChars, true).trim(), description: value.description === undefined ? '' : string(value.description, 'Description', PROMPT_TEMPLATE_LIMITS.descriptionChars).trim(), sections: [] };
  if (!Array.isArray(value.sections) || !value.sections.length) throw fail('Add at least one outline section.');
  let size = result.title.length + result.description.length, previousLevel = 0;
  const seen = new Set();
  for (const [index, item] of value.sections.entries()) {
    if (!plain(item) || Object.keys(item).some(key => !['id', 'title', 'content', 'level'].includes(key))) throw fail('Each outline section needs an ID, title, content and level.');
    const id = identifier(item.id, 'Section ID'); if (seen.has(id)) throw fail('Each outline section needs a unique ID.'); seen.add(id);
    const title = string(item.title, 'Section title', PROMPT_TEMPLATE_LIMITS.titleChars).trim(), content = string(item.content, 'Section content', PROMPT_TEMPLATE_LIMITS.textChars);
    if (!Number.isSafeInteger(item.level) || item.level < 0 || item.level > 4 || index === 0 && item.level !== 0 || item.level > previousLevel + 1) throw fail('Outline levels run from 0 to 4, start at 0, and increase one level at a time.');
    previousLevel = item.level; size += title.length + content.length;
    if (size > PROMPT_TEMPLATE_LIMITS.textChars) throw fail('This outline is too long. Keep its text within 50,000 characters.');
    result.sections.push({ id, title, content, level: item.level });
  }
  for (let index = 0; index < result.sections.length; index++) { const item = result.sections[index]; if (!item.title && !item.content.trim() && !(result.sections[index + 1]?.level > item.level)) throw fail('A section needs a title, content, or a nested section.'); }
  if (JSON.stringify(result).length > PROMPT_TEMPLATE_LIMITS.documentBytes) throw fail('This outline document is too large.');
  if (allowMetadata) {
    if (value.revision !== undefined) { if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw fail('Prompt revision must be a positive integer.'); result.revision = value.revision; }
    for (const key of ['builtin', 'deleted']) if (value[key] !== undefined) { if (typeof value[key] !== 'boolean') throw fail(`Invalid prompt ${key}.`); result[key] = value[key]; }
    // Other metadata is persisted and validated by the store, never executable.
  }
  return result;
}

export function promptTemplateFields(value) {
  const template = validatePromptTemplate(value), seen = new Set(), fields = [];
  for (const section of template.sections) for (const key of variables(`${section.title}\n${section.content}`)) if (!seen.has(key)) { seen.add(key); fields.push({ key, label: label(key), required: key === 'task' }); }
  return fields;
}

export function renderPromptTemplate(value, requestedValues = {}) {
  const template = validatePromptTemplate(value), fields = promptTemplateFields(template);
  if (!plain(requestedValues)) throw fail('Prompt field values must be an object of text values.');
  const keys = new Set(fields.map(field => field.key));
  for (const key of Object.keys(requestedValues)) if (!keys.has(key)) throw fail(`Unknown prompt field: ${key}.`);
  const values = Object.create(null);
  for (const field of fields) { const input = Object.hasOwn(requestedValues, field.key) ? requestedValues[field.key] : ''; values[field.key] = string(input, field.label, PROMPT_TEMPLATE_LIMITS.textChars, field.required); }
  const tooLong = () => { throw fail('The rendered prompt is too long. Keep it within 50,000 characters.'); };
  const substitute = source => {
    const parts = []; let cursor = 0, length = 0;
    for (const match of source.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g)) { const literal = source.slice(cursor, match.index), inserted = values[match[1]]; length += literal.length + inserted.length; if (length > PROMPT_TEMPLATE_LIMITS.textChars) tooLong(); parts.push(literal, inserted); cursor = match.index + match[0].length; }
    const suffix = source.slice(cursor); if (length + suffix.length > PROMPT_TEMPLATE_LIMITS.textChars) tooLong(); parts.push(suffix); return parts.join('');
  };
  let expandedLength = 0;
  const sections = template.sections.map((section, index) => {
    const body = substitute(section.content).trim();
    const leaf = !(template.sections[index + 1]?.level > section.level), headingOnly = !section.content.trim() && (leaf || variables(section.title).some(key => values[key].trim()));
    const renderedTitle = headingOnly ? substitute(section.title).trim() : null;
    expandedLength += body.length + (renderedTitle?.length || 0); if (expandedLength > PROMPT_TEMPLATE_LIMITS.textChars) tooLong();
    return { ...section, body, renderedTitle, keep: Boolean(body || renderedTitle) };
  });
  // A retained child keeps its structural ancestors, without empty optional siblings.
  const ancestors = [], parents = sections.map((section, index) => { while (ancestors.length && sections[ancestors.at(-1)].level >= section.level) ancestors.pop(); const parent = ancestors.at(-1) ?? -1; ancestors.push(index); return parent; });
  for (let index = sections.length - 1; index >= 0; index--) if (sections[index].keep && parents[index] >= 0) sections[parents[index]].keep = true;
  let outputLength = 0;
  const text = sections.filter(section => section.keep).map((section, index) => { const title = section.renderedTitle ?? substitute(section.title).trim(), heading = title ? `${'#'.repeat(section.level + 2)} ${title}` : ''; outputLength += (index ? 2 : 0) + heading.length + (heading && section.body ? 2 : 0) + section.body.length; if (outputLength > PROMPT_TEMPLATE_LIMITS.textChars) tooLong(); return [heading, section.body].filter(Boolean).join('\n\n'); }).join('\n\n');
  if (!text.trim()) throw fail('Fill in a prompt field or add some outline content.');
  if (text.length > PROMPT_TEMPLATE_LIMITS.textChars) tooLong();
  return { text, template: { ...(template.id ? { id: template.id } : {}), title: template.title, ...(template.revision ? { revision: template.revision } : {}) }, values: { ...values } };
}

const section = (id, title, content, level = 0) => ({ id, title, content, level });
const builtin = (id, title, description, sections) => ({ id: `builtin_${id}`, title, description, sections, revision: 1, builtin: true, deleted: false });
const builtins = [
  builtin('task', 'Clear task', 'A goal, useful context and a clear result.', [section('goal', 'Goal', '{{task}}'), section('context', 'Context', '{{context}}'), section('constraints', 'Constraints', '{{constraints}}'), section('result', 'Deliverable', '{{deliverable}}'), section('method', 'Working approach', 'Choose the tools suited to this task. Complete the work, verify the result, and report concrete outcomes and remaining limitations.')]),
  builtin('build', 'Build something', 'Turn an idea into a working, checked result.', [section('goal', 'Build', '{{task}}'), section('context', 'Existing project', '{{context}}'), section('requirements', 'Requirements', '{{requirements}}'), section('constraints', 'Constraints', '{{constraints}}'), section('done', 'Done means', '{{done_when}}'), section('approach', 'Approach', 'Inspect the current project and choose appropriate tools before changing it. Implement the complete requested behavior, check the important paths, and explain how to run or use the result.')]),
  builtin('fix', 'Fix a problem', 'Reproduce a failure and check the repair.', [section('goal', 'Problem', '{{task}}'), section('expected', 'Expected behavior', '{{expected}}'), section('actual', 'What happens', '{{actual}}'), section('context', 'Reproduction and context', '{{context}}'), section('method', 'Approach', 'Trace the cause using current evidence. Make a focused repair, verify the original failure and relevant neighboring behavior, and report what changed and what was tested.')]),
  builtin('research', 'Research', 'Answer a question using evidence and useful comparisons.', [section('question', 'Question', '{{task}}'), section('context', 'Context', '{{context}}'), section('scope', 'Scope', '{{scope}}'), section('deliverable', 'Useful result', '{{deliverable}}'), section('method', 'Evidence', 'Choose suitable sources and tools. Distinguish verified facts from inference, compare meaningful alternatives, cite supporting sources, and make uncertainty clear.')]),
  builtin('decision', 'Make a decision', 'Compare options against the outcome that matters.', [section('goal', 'Decision', '{{task}}'), section('options', 'Options', '{{options}}'), section('criteria', 'What matters', '{{criteria}}'), section('context', 'Context and constraints', '{{context}}'), section('result', 'Result', 'Compare the tradeoffs against the stated criteria. Recommend a course of action with supporting evidence, assumptions, and a concrete next step.')]),
  builtin('workflow', 'Create a workflow', 'Define repeatable work, triggers and completion checks.', [section('goal', 'Outcome', '{{task}}'), section('trigger', 'When it runs', '{{trigger}}'), section('inputs', 'Inputs and connections', '{{inputs}}'), section('steps', 'Steps or agents', '{{steps}}'), section('done', 'Completion checks', '{{done_when}}'), section('method', 'Execution', 'Inspect the available models, tools and saved configuration. Build the workflow through BLACKICE tools, verify its settings and trigger behavior, and report the actual saved receipt. Preserve user choices about concurrency and retries.')]),
];
for (const item of builtins) { for (const itemSection of item.sections) Object.freeze(itemSection); Object.freeze(item.sections); Object.freeze(item); }
export const BUILTIN_PROMPT_TEMPLATES = Object.freeze(builtins);
