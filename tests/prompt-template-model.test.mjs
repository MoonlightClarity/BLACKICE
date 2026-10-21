import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PROMPT_TEMPLATES, validatePromptTemplate, promptTemplateFields, renderPromptTemplate } from '../public/prompt-template-model.mjs';

const outline = sections => ({ title: 'Test outline', description: '', sections });
const section = (id, title, content, level = 0) => ({ id, title, content, level });

test('prompt fields follow outline appearance order, humanize keys, and require only task', () => {
  const template = outline([section('goal', '{{audience}} goal', '{{task}} then {{audience}} and {{done_when}}'), section('next', '', '{{camelCase}}')]);
  assert.deepEqual(promptTemplateFields(template), [{ key: 'audience', label: 'Audience', required: false }, { key: 'task', label: 'Task', required: true }, { key: 'done_when', label: 'Done when', required: false }, { key: 'camelCase', label: 'Camel Case', required: false }]);
  assert.throws(() => renderPromptTemplate(template), /Task must be nonempty/);
  assert.throws(() => renderPromptTemplate(template, { task: 'okay', unknown: 'value' }), /Unknown prompt field/);
  assert.throws(() => renderPromptTemplate(template, { task: 42 }), /Task must be/);
});

test('prompt substitution is literal, nonrecursive, and never evaluates inserted code or dollar patterns', () => {
  const template = outline([section('goal', 'Goal', '{{ task }}'), section('context', 'Context', '{{context}}')]);
  const inserted = '{{context}} $& $1 ${process.env.SECRET} <script>alert(1)</script> C:\\Users\\Example';
  const rendered = renderPromptTemplate(template, { task: inserted, context: 'visible context' });
  assert.equal(rendered.text, `## Goal\n\n${inserted}\n\n## Context\n\nvisible context`);
  assert.deepEqual(rendered.values, { task: inserted, context: 'visible context' });
  assert.deepEqual(template.sections[0], section('goal', 'Goal', '{{ task }}'), 'render never rewrites the authored outline');
});

test('blank optional prompt bodies disappear and retained children keep their ancestors', () => {
  const template = outline([section('goal', 'Goal', '{{task}}'), section('optional', 'Empty context', '{{context}}'), section('parent', 'Requirements', ''), section('child', 'Acceptance', '{{done_when}}', 1), section('emptychild', 'Unused', '{{extra}}', 1)]);
  const rendered = renderPromptTemplate(template, { task: 'Build chess', done_when: 'Checkmate works' });
  assert.equal(rendered.text, '## Goal\n\nBuild chess\n\n## Requirements\n\n### Acceptance\n\nCheckmate works');
  assert.equal(rendered.values.context, ''); assert.equal(rendered.values.extra, '');
});

test('static prompt instructions survive blank optional placeholders inside the same section', () => {
  const rendered = renderPromptTemplate(outline([section('method', 'Method', 'Always verify the actual result. {{notes}}')]), {});
  assert.equal(rendered.text, '## Method\n\nAlways verify the actual result.');
});

test('title-only prompt sections render their literal content and populated variables', () => {
  assert.equal(renderPromptTemplate(outline([section('goal', '{{task}}', '')]), { task: 'Build chess' }).text, '## Build chess');
  assert.equal(renderPromptTemplate(outline([section('heading', 'A standalone instruction', '')])).text, '## A standalone instruction');
  const nested = outline([section('parent', 'Optional group', ''), section('child', 'Context', '{{context}}', 1), section('goal', 'Goal', '{{task}}')]);
  assert.equal(renderPromptTemplate(nested, { task: 'Build chess' }).text, '## Goal\n\nBuild chess', 'empty structural groups still disappear when every optional child is blank');
});

test('prompt hierarchy is flat, ordered, bounded and rejects duplicate or unsafe section IDs', () => {
  for (const sections of [[section('a', 'A', 'body', 1)], [section('a', 'A', 'body'), section('b', 'B', 'body', 2)], [section('a', 'A', 'body'), section('a', 'B', 'other')], [section('../bad', 'A', 'body')], [section('a', 'A', 'body', 5)]]) assert.throws(() => validatePromptTemplate(outline(sections)));
  const deep = outline(Array.from({ length: 5 }, (_, index) => section(`s${index}`, `Level ${index}`, index === 4 ? 'leaf' : '', index)));
  assert.equal(renderPromptTemplate(deep).text, '## Level 0\n\n### Level 1\n\n#### Level 2\n\n##### Level 3\n\n###### Level 4\n\nleaf');
});

test('prompt rendering rejects oversized output before accepting it as a composer message', () => {
  const template = outline([section('goal', '', '{{task}} {{task}}')]);
  assert.throws(() => renderPromptTemplate(template, { task: 'x'.repeat(25_000) }), /rendered prompt is too long/);
  assert.equal(renderPromptTemplate(outline([section('goal', '', '{{task}}')]), { task: 'x'.repeat(50_000) }).text.length, 50_000);
  assert.throws(() => validatePromptTemplate(outline([section('goal', '', 'x'.repeat(50_000))])), /outline is too long/, 'source title and all section text contribute to the same authoring budget');
  assert.throws(() => renderPromptTemplate(outline([section('repeated', '', '{{task}}'.repeat(6000))]), { task: 'x'.repeat(50_000) }), /rendered prompt is too long/, 'expansion stops at the output budget before building hundreds of megabytes');
});

test('prompt values with prototype-like names remain plain data and cannot change prototypes', () => {
  const template = outline([section('goal', '', '{{constructor}} {{toString}} {{task}}')]);
  const rendered = renderPromptTemplate(template, JSON.parse('{"constructor":"literal constructor","toString":"literal string","task":"done"}'));
  assert.equal(rendered.text, 'literal constructor literal string done');
  assert.equal(Object.getPrototypeOf(rendered.values), Object.prototype);
  assert.throws(() => renderPromptTemplate(template, JSON.parse('{"task":"done","__proto__":"bad"}')), /Unknown prompt field/);
});

test('malformed placeholder syntax is literal and does not create hidden variables', () => {
  const template = outline([section('literal', '', '{{}} {{1bad}} {{a.b}} {{unclosed and {{valid_key}}')]);
  assert.deepEqual(promptTemplateFields(template), [{ key: 'valid_key', label: 'Valid key', required: false }]);
  assert.equal(renderPromptTemplate(template, { valid_key: 'yes' }).text, '{{}} {{1bad}} {{a.b}} {{unclosed and yes');
});

test('every built-in is immutable, independently renderable, and provider-neutral', () => {
  assert.equal(BUILTIN_PROMPT_TEMPLATES.length, 6);
  for (const template of BUILTIN_PROMPT_TEMPLATES) { assert.equal(template.builtin, true); assert.ok(Object.isFrozen(template)); assert.ok(Object.isFrozen(template.sections)); assert.ok(Object.isFrozen(template.sections[0])); const rendered = renderPromptTemplate(template, { task: 'A concrete requested result' }); assert.match(rendered.text, /A concrete requested result/); assert.equal(rendered.template.revision, 1); assert.doesNotMatch(rendered.text, /OPENAI_API_KEY|anthropic_version|<\|im_start\|>/); }
});
