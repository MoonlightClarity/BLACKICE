import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTConnector } from '../lib/chatgpt-connector.mjs';
import { fullDirectCatalog } from './fixtures/full-direct-catalog.mjs';

test('full connector catalog references only tools that are attached by the server', async () => {
  const { catalog, sources } = await fullDirectCatalog();
  const tools = catalog.tools(), names = new Set(tools.map(tool => tool.name));
  assert.equal(tools.length, 46);
  assert.equal(Object.keys(sources).length, tools.length);
  assert.equal(names.has('blackice_planning_cycle'), false);
  const descriptions = value => Array.isArray(value) ? value.flatMap(descriptions) : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, item]) => key === 'description' && typeof item === 'string' ? [item] : descriptions(item)) : [];
  for (const tool of tools) {
    assert.ok(tool.description.trim(), tool.name + ' needs a description');
    for (const text of descriptions(tool)) for (const [name] of text.matchAll(/\bblackice_[a-z0-9_]+\b/g)) {
      assert.ok(names.has(name), tool.name + ' refers to unattached ' + name);
    }
  }
});

test('connector schema guidance names graph tools only when the catalog attaches them', async () => {
  const { catalog } = await fullDirectCatalog();
  assert.match(ChatGPTConnector.prototype.instructions.call({}, catalog), /blackice_planning_graph_read action:schema/);
  const reduced = { get: name => name === 'blackice_planning_graph_read' ? undefined : catalog.get(name) };
  assert.doesNotMatch(ChatGPTConnector.prototype.instructions.call({}, reduced), /blackice_planning_graph_read/);
});
