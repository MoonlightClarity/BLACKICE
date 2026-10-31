import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createChatGPTToolCatalog } from '../lib/chatgpt-tool-catalog.mjs';
import { DirectExecutionAPI } from '../lib/direct-execution-api.mjs';
import { ChatGPTPlanningAPI } from '../lib/chatgpt-planning.mjs';
import { chatGPTFileImportTool } from '../lib/chatgpt-file-import.mjs';
import { desktopRestartTool } from '../lib/desktop-restart-tool.mjs';
import { createDirectBrowserCredentialTools } from '../lib/browser-credential-tools.mjs';
import { createDirectConnectedBrowserTools, createDirectBrowserProfileTools } from '../lib/connected-browser-tools.mjs';

const definition = (name, extra = {}) => ({
  name,
  description: 'A fixture tool.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  scope: 'read',
  ...extra,
});
const unavailable = () => assert.fail('Discovery must not execute a tool.');
const provider = tools => ({ tools: () => tools, call: unavailable });

test('the full native catalog retains the exact 28-tool public contract and fingerprint', () => {
  // Bind the reviewed public definitions, including recursive planning,
  // bounded contained diagnostics, exact-identity ownership/debug controls,
  // the cleanup protocol and the explicit relay default for credential fill.
  // The complete fingerprint catches unreviewed contract changes.
  // Only definitions are constructed: no storage or native adapter is opened.
  const execution = new DirectExecutionAPI({ dataDir: '/unused-catalog-fixture', additionalTools: [
    chatGPTFileImportTool({ directory: '/unused-catalog-fixture/imports' }),
    ...createDirectConnectedBrowserTools({ manager: {}, connectChrome: unavailable }),
    ...createDirectBrowserProfileTools({ profiles: {}, manager: {} }),
    desktopRestartTool({ restart: { request: unavailable }, getJob: unavailable }),
    ...createDirectBrowserCredentialTools({ vault: {}, browser: {}, reauthorize: unavailable }),
  ] });
  const catalog = createChatGPTToolCatalog({ providers: [execution, new ChatGPTPlanningAPI({})], version: '2.33.5' });
  assert.deepEqual(catalog.tools().map(tool => tool.name), [
    'blackice_direct_status', 'blackice_list_jobs', 'blackice_get_job', 'blackice_cancel_job',
    'blackice_workspace_read', 'blackice_workspace_write', 'blackice_run_command', 'blackice_browser_read',
    'blackice_browser_action', 'blackice_browser_upload', 'blackice_import_file', 'blackice_connected_browser_read',
    'blackice_connected_browser_action', 'blackice_profile_list', 'blackice_profile_import', 'blackice_profile_connect',
    'blackice_restart', 'blackice_credentials_list', 'blackice_credentials_generate', 'blackice_credentials_fill',
    'blackice_list_plans', 'blackice_get_plan', 'blackice_get_run_result', 'blackice_list_swarm_plans',
    'blackice_get_swarm_plan', 'blackice_get_plan_groups', 'blackice_edit_plan', 'blackice_edit_plan_groups',
  ]);
  assert.deepEqual(catalog.status(), {
    sha256: '474cf0918763e7d89e4e7c0d80f4a04a4be59cb48a31d30f44d16655f9644a37',
    toolCount: 28,
    serverVersion: '2.33.5',
  });
  assert.equal(createHash('sha256').update(JSON.stringify(catalog.tools())).digest('hex'), catalog.status().sha256);
  const read=catalog.tools().find(tool=>tool.name==='blackice_browser_read');
  assert.equal(read.annotations.readOnlyHint,true);
  assert.ok(read.inputSchema.properties.action.enum.includes('diagnostics'));
  assert.equal(read.inputSchema.properties.after.minimum,0);
  assert.equal(read.inputSchema.properties.limit.maximum,256);
  assert.equal(read.inputSchema.properties.expectedUrl,undefined);
  assert.equal(read.inputSchema.properties.expectedDocumentId,undefined);
  const action=catalog.tools().find(tool=>tool.name==='blackice_browser_action').inputSchema;
  for(const name of ['take_ownership','transfer_ownership','debug_reset','stop'])assert.ok(action.properties.action.enum.includes(name));
  assert.deepEqual(action.properties.destination.enum,['user','task']);
  assert.equal(action.properties.destinationOwnerKey.maxLength,650);
  const fill=catalog.tools().find(tool=>tool.name==='blackice_credentials_fill').inputSchema;
  assert.equal(fill.properties.browser.default,'relay');
  assert.deepEqual(fill.properties.browser.enum,['relay']);
  const planning=catalog.tools().find(tool=>tool.name==='blackice_edit_plan').inputSchema;
  const edits=Object.fromEntries(planning.properties.operations.items.oneOf.map(operation=>[operation.properties.type.const,operation.properties]));
  assert.ok(edits.add.step.properties.operation);
  assert.ok(edits.metadata.patch.properties.facts);
  assert.ok(edits.add.step.properties.branch.properties.elif);
  assert.equal(edits.add.step.properties.branch.properties.if.$ref,'#/$defs/planExpression');
  assert.deepEqual(planning.$defs.planExpression.anyOf.filter(value=>value.properties).map(value=>Object.keys(value.properties)[0]),['fact','and','or','not','xor','compare']);
  assert.equal(edits.revisit.reason.minLength,1);
});

test('each provider is sampled once and dispatch remains paired with its captured definition', async () => {
  const tools = [definition('blackice_fixture', { requiredScopes: ['commands:run'] })];
  const calls = [];
  let discoveries = 0;
  const execution = {
    label: 'original-provider',
    tools() { discoveries++; return tools; },
    call(name, args, client) { calls.push({ label: this.label, name, args, client }); return 'original-result'; },
  };
  const catalog = createChatGPTToolCatalog({ providers: [execution], version: 'fixture' });
  const original = catalog.status();
  tools[0].requiredScopes[0] = 'browser:write';
  tools[0].description = 'Changed after discovery.';
  execution.tools = () => [definition('blackice_other')];
  execution.call = () => assert.fail('The captured request must retain its original handler.');

  const entry = catalog.get('blackice_fixture');
  const args = { value: 'request' }, client = { id: 'same-grant', scopes: ['read', 'commands:run'] };
  assert.deepEqual(entry.requiredScopes, ['read', 'commands:run']);
  assert.equal(entry.definition.description, 'A fixture tool.');
  assert.equal(catalog.get('blackice_other'), undefined);
  assert.equal(await entry.call(args, client), 'original-result');
  assert.deepEqual(calls, [{ label: 'original-provider', name: 'blackice_fixture', args, client }]);
  assert.equal(discoveries, 1);
  assert.deepEqual(catalog.status(), original);
  catalog.tools(); catalog.get('blackice_fixture');
  assert.equal(discoveries, 1);

  const next = createChatGPTToolCatalog({ providers: [execution], version: 'fixture' });
  assert.equal(next.get('blackice_fixture'), undefined);
  assert.notEqual(next.status().sha256, original.sha256);
});

test('duplicate tool identity fails before either provider can execute', () => {
  const first = provider([definition('blackice_shared')]);
  const second = provider([definition('blackice_shared', { scope: 'commands:run' })]);
  const isDuplicate = error => error.code === 'CHATGPT_TOOL_CATALOG_INVALID'
    && error.status === 503 && /blackice_shared.*more than once/.test(error.message);
  assert.throws(() => createChatGPTToolCatalog({ providers: [first, second], version: 'fixture' }), isDuplicate);
  assert.throws(() => createChatGPTToolCatalog({ providers: [provider([
    definition('blackice_shared'), definition('blackice_shared'),
  ])], version: 'fixture' }), isDuplicate);
});

test('caller and provider mutations cannot change snapshots or their authorization scopes', () => {
  const original = definition('blackice_fixture', {
    requiredScopes: ['browser:write', 'files:read', 'browser:write'],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    _meta: { 'fixture/preserved': { nested: ['original'] } },
  });
  const catalog = createChatGPTToolCatalog({ providers: [provider([original])], version: 'fixture' });
  const serialized = JSON.stringify(catalog.tools()), fingerprint = catalog.status().sha256;
  const tools = catalog.tools(), entry = catalog.get(original.name);
  original.annotations.destructiveHint = false;
  original._meta['fixture/preserved'].nested.push('provider mutation');
  original.inputSchema.properties.value.type = 'number';
  tools[0].securitySchemes[0].scopes.push('caller mutation');
  tools[0]._meta.securitySchemes[0].scopes.push('metadata mutation');
  entry.requiredScopes.length = 0;
  entry.definition._meta['fixture/preserved'].nested.push('entry mutation');
  entry.definition.annotations.destructiveHint = false;
  catalog.status().sha256 = 'fake';

  assert.equal(JSON.stringify(catalog.tools()), serialized);
  assert.equal(catalog.status().sha256, fingerprint);
  assert.deepEqual(catalog.get('blackice_fixture').requiredScopes, ['read', 'browser:write', 'files:read']);
  assert.deepEqual(catalog.get('blackice_fixture').definition.annotations, {
    readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
  });
});

test('scope aliases and existing metadata preserve their wire representation and provider order', () => {
  const providers = [provider([
    definition('blackice_first', { requiredScopes: ['files:write'], scopes: ['ignored'], requiredScope: 'ignored' }),
    definition('blackice_second', { scope: undefined, requiredScope: 'planning:write' }),
  ]), provider([
    definition('blackice_third', { scopes: ['browser:read'], _meta: { 'fixture/preserved': true }, outputSchema: { type: 'object' } }),
    definition('blackice_fourth', { scope: undefined }),
  ])];
  const catalog = createChatGPTToolCatalog({ providers, version: 'fixture' });
  const tools = catalog.tools();
  assert.deepEqual(tools.map(tool => tool.name), ['blackice_first', 'blackice_second', 'blackice_third', 'blackice_fourth']);
  assert.deepEqual(tools.map(tool => tool.securitySchemes[0].scopes), [
    ['read', 'files:write'], ['read', 'planning:write'], ['read', 'browser:read'], ['read'],
  ]);
  for (const tool of tools) {
    for (const key of ['scope', 'requiredScope', 'requiredScopes', 'scopes']) assert.equal(Object.hasOwn(tool, key), false);
    assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
    assert.notEqual(tool._meta.securitySchemes, tool.securitySchemes);
    assert.equal(tool._meta['openai/toolInvocation/invoking'], 'Contacting BLACKICE');
    assert.equal(tool._meta['openai/toolInvocation/invoked'], 'Action status received');
  }
  assert.equal(tools[2]._meta['fixture/preserved'], true);
  assert.deepEqual(tools[2].outputSchema, { type: 'object' });
});
