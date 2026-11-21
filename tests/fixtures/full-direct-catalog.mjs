// Match server.mjs's registered connector providers with both desktop extensions.
// Construct definitions only: no store is opened and no handler is executed.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function fullDirectCatalog(root = fileURLToPath(new URL('../../', import.meta.url))) {
  const load = file => import(pathToFileURL(path.join(root, 'lib', file)).href);
  const unavailable = () => { throw new Error('Catalog inspection must not execute a handler.'); };
  const sources = {}, additional = [];
  const add = (file, factory, entries) => { for (const entry of entries) { additional.push(entry); sources[entry.definition.name] = { file: 'lib/' + file, factory }; } };
  add('visual-artifacts.mjs','visualTool',[(await load('visual-artifacts.mjs')).visualTool({})]);
  add('conversation-goals-direct-tool.mjs','conversationGoalsDirectTool',[(await load('conversation-goals-direct-tool.mjs')).conversationGoalsDirectTool({ goals: { get: unavailable, control: unavailable } })]);
  add('native-task-context-bridge.mjs','createNativeTaskContextTool',[(await load('native-task-context-bridge.mjs')).createNativeTaskContextTool({ getBridge: unavailable })]);
  const store = Object.fromEntries(['list','get','create','addNode','updateNode','link','addSource'].map(name => [name, unavailable]));
  add('direct-planning-browser-tools.mjs','createDirectPlanningBrowserTools',(await load('direct-planning-browser-tools.mjs')).createDirectPlanningBrowserTools({ store }));
  add('direct-planning-execution-tools.mjs','createDirectPlanningExecutionTools',(await load('direct-planning-execution-tools.mjs')).createDirectPlanningExecutionTools({ store, runner: { start: unavailable, cancel: unavailable, status: unavailable } }));
  add('provider-setup-tools.mjs','createDirectProviderSetupTools',(await load('provider-setup-tools.mjs')).createDirectProviderSetupTools({ runtime: {}, browser: {}, reauthorize: unavailable }));
  add('chatgpt-file-import.mjs','chatGPTFileImportTool',[(await load('chatgpt-file-import.mjs')).chatGPTFileImportTool({ directory: '/unused-catalog-fixture/imports' })]);
  add('chatgpt-start-chat.mjs','chatGPTStartChatTool',[(await load('chatgpt-start-chat.mjs')).chatGPTStartChatTool({ engine: { startRun: unavailable }, defaultCwd: '/unused-catalog-fixture' })]);
  add('planning-ontology-direct-tool.mjs','planningOntologyDirectTool',[(await load('planning-ontology-direct-tool.mjs')).planningOntologyDirectTool({ runtimeSettings: { get: unavailable, update: unavailable } })]);
  const connected = await load('connected-browser-tools.mjs');
  add('connected-browser-tools.mjs','createDirectConnectedBrowserTools',connected.createDirectConnectedBrowserTools({ manager: {}, connectChrome: unavailable }));
  add('connected-browser-tools.mjs','createDirectBrowserProfileTools',connected.createDirectBrowserProfileTools({ profiles: {}, manager: {} }));
  add('desktop-restart-tool.mjs','desktopRestartTool',[(await load('desktop-restart-tool.mjs')).desktopRestartTool({ restart: { request: unavailable }, getJob: unavailable })]);
  add('frontend-devtools-tool.mjs','frontendDevtoolsTool',[(await load('frontend-devtools-tool.mjs')).frontendDevtoolsTool({ frontend: { execute: unavailable } })]);
  add('browser-credential-tools.mjs','createDirectBrowserCredentialTools',(await load('browser-credential-tools.mjs')).createDirectBrowserCredentialTools({ vault: {}, browser: {}, reauthorize: unavailable }));
  const { DirectExecutionAPI } = await load('direct-execution-api.mjs');
  const execution = new DirectExecutionAPI({ dataDir: '/unused-catalog-fixture', allowedRoot: '/unused-catalog-fixture', additionalTools: additional });
  for (const tool of execution.tools()) if (!sources[tool.name]) sources[tool.name] = {
    file: tool.name === 'blackice_task_contract' ? 'lib/direct-task-contract-tools.mjs' : tool.name === 'blackice_task_context' ? 'lib/direct-task-context-tools.mjs' : 'lib/direct-execution-api.mjs',
    factory: tool.name === 'blackice_task_contract' ? 'createDirectTaskContractTools' : tool.name === 'blackice_task_context' ? 'createDirectTaskContextTools' : 'DirectExecutionAPI.tools',
  };
  const { ChatGPTPlanningAPI } = await load('chatgpt-planning.mjs');
  const planning = new ChatGPTPlanningAPI({});
  for (const tool of planning.tools()) sources[tool.name] = { file: 'lib/chatgpt-planning.mjs', factory: 'ChatGPTPlanningAPI.tools' };
  const { createChatGPTToolCatalog } = await load('chatgpt-tool-catalog.mjs');
  const catalog = createChatGPTToolCatalog({ providers: [execution, planning], version: 'inspection' });
  return { catalog, sources };
}
