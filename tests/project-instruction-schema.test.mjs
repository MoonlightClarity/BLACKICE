import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_TOOL, PROJECT_INSTRUCTIONS, createProjectToolHandler } from '../lib/project-tools.mjs';

const decode = response => JSON.parse(response.contentItems[0].text);
const snapshot = methods => ({ status: {}, ontology: { taskTypes: [], stepTypes: [] }, methods });
const invoke = methods => {
  const handler = createProjectToolHandler({ projects: {}, capabilities: {}, methods });
  return async args => handler({ name: PROJECT_TOOL.name, arguments: args });
};
const noRetiredMethodRecipe = value => assert.doesNotMatch(JSON.stringify(value),
  /relay_task|save_method|methodQuery|methodDomain|methodPhase|methodOutput|methodOffset|catalogRevision/);

test('project method discovery returns same-tool recovery using supported fields', async () => {
  const method = { id: 'large-procedure', name: 'Large procedure', revision: 1, instructions: 'x'.repeat(128000) };
  const call = invoke({ snapshot: () => snapshot([method]), get: id => ({ id, name: 'Full procedure', revision: 1, steps: [] }) });
  const result = await call({ action: 'methods' });
  assert.equal(result.success, true);
  const body = decode(result);
  assert.equal(body.catalogFormat, 'complete-name-index');
  assert.deepEqual(body.methods, [{ id: method.id, name: method.name, revision: 1 }]);
  assert.match(body.note, /get_method with that id/);
  assert.ok(PROJECT_TOOL.inputSchema.properties.action.enum.includes('get_method'));
  assert.ok(PROJECT_TOOL.inputSchema.properties.id);
  const full = await call({ action: 'get_method', id: body.methods[0].id });
  assert.equal(full.success, true);
  assert.equal(decode(full).id, method.id);
  noRetiredMethodRecipe(body);
});

test('oversized method responses and unsupported outlines do not advertise absent task APIs', async () => {
  const catalog = Array.from({ length: 5000 }, (_, i) => ({ id: 'm-' + i, name: 'Saved procedure ' + i, revision: 1 }));
  const call = invoke({ snapshot: () => snapshot(catalog), get: id => ({ id, instructions: 'x'.repeat(128001) }) });
  const described = await call({ action: 'describe' });
  noRetiredMethodRecipe([PROJECT_TOOL.description, PROJECT_INSTRUCTIONS, decode(described)]);
  for (const args of [{ action: 'methods' }, { action: 'get_method', id: 'm-1' }]) {
    const response = await call(args);
    assert.equal(response.success, false);
    assert.equal(decode(response).code, 'METHOD_CATALOG_LIMIT');
    assert.match(decode(response).error, /does not provide .*paging/);
    noRetiredMethodRecipe(decode(response));
  }
  const unsupported = await call({ action: 'create_method', method: { name: 'Branching', outline: {} } });
  assert.equal(unsupported.success, false);
  assert.equal(decode(unsupported).code, 'METHOD_SCHEMA_UNSUPPORTED');
  assert.match(decode(unsupported).error, /no method was saved/);
  noRetiredMethodRecipe(decode(unsupported));
});
