import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BROWSER_CLEANUP_PROTOCOL } from '../lib/browser-cleanup-policy.mjs';
import { legacyBrowserCleanupProtocol, legacyToolCatalogVersion, legacyToolCatalogSha256 } from './fixtures/chatgpt-tool-catalog-legacy-policy.mjs';
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

test('the configured catalog retains 34 tools with reviewed authentication, canonical creation, fill and conversation contracts', () => {
  // Bind the reviewed public definitions, including recursive planning,
  // bounded contained diagnostics, exact-identity ownership/debug controls,
  // the cleanup protocol, the explicit relay default for credential fill,
  // and the distinction between fill text and selection-only value.
  // The complete fingerprint catches unreviewed contract changes.
  // Only definitions are constructed: no storage or native adapter is opened.
  const execution = new DirectExecutionAPI({ dataDir: '/unused-catalog-fixture', additionalTools: [
    chatGPTFileImportTool({ directory: '/unused-catalog-fixture/imports' }),
    ...createDirectConnectedBrowserTools({ manager: {}, connectChrome: unavailable }),
    ...createDirectBrowserProfileTools({ profiles: {}, manager: {} }),
    desktopRestartTool({ restart: { request: unavailable }, getJob: unavailable }),
    ...createDirectBrowserCredentialTools({ vault: {}, browser: {}, reauthorize: unavailable }),
  ] });
  // Pin the current reviewed contract and reconstruct historical contracts below.
  const catalog = createChatGPTToolCatalog({ providers: [execution, new ChatGPTPlanningAPI({})], version: '2.40.8' });
  assert.deepEqual(catalog.tools().map(tool => tool.name), [
    'blackice_direct_status', 'blackice_list_jobs', 'blackice_get_job', 'blackice_cancel_job',
    'blackice_workspace_read', 'blackice_workspace_write', 'blackice_run_command', 'blackice_browser_read',
    'blackice_browser_action', 'blackice_browser_upload', 'blackice_task_contract', 'blackice_task_context', 'blackice_import_file', 'blackice_connected_browser_read',
    'blackice_connected_browser_action', 'blackice_profile_list', 'blackice_profile_import', 'blackice_profile_connect',
    'blackice_restart', 'blackice_credentials_list', 'blackice_credentials_generate', 'blackice_credentials_save', 'blackice_credentials_update', 'blackice_credentials_associate', 'blackice_credentials_fill', 'blackice_credentials_authenticate',
    'blackice_list_plans', 'blackice_get_plan', 'blackice_get_run_result', 'blackice_list_swarm_plans',
    'blackice_get_swarm_plan', 'blackice_get_plan_groups', 'blackice_edit_plan', 'blackice_edit_plan_groups',
  ]);
  assert.deepEqual(catalog.status(), {
    // A complete reviewed current contract, not an inferred version or reused old SHA.
    sha256: '24d9aecf95a3c3e1dc4e6e03a026d06cdee6e028eb1cec554fd488a55441658a',
    toolCount: 34,
    serverVersion: '2.40.8',
  });
  const sha=tools=>createHash('sha256').update(JSON.stringify(tools)).digest('hex');
  const currentTools=catalog.tools();
  assert.equal(sha(currentTools),catalog.status().sha256);
  const currentAction=currentTools.find(tool=>tool.name==='blackice_browser_action');
  assert.ok(currentAction.description.endsWith(BROWSER_CLEANUP_PROTOCOL),'The active contract must carry the reviewed scoped-cleanup protocol.');
  assert.match(BROWSER_CLEANUP_PROTOCOL,/limited DOM inspection for deliberate per-page manual review/);
  assert.match(BROWSER_CLEANUP_PROTOCOL,/pending effects/);


  // Reconstruct the prior catalog by removing only reviewed native filename-search fields.
  // Historical hashes remain immutable; a new schema must not rewrite old contracts.
  // The in-use release changes exactly one action and its explicit boolean field.
  // Removing those reviewed additions must recover the complete prior catalog.
  assert.equal(currentAction.inputSchema.properties.action.enum.filter(action=>action==='tab_mark').length,1);
  assert.deepEqual(currentAction.inputSchema.properties.inUse,{type:'boolean',description:'For tab_mark: protect an owned tab (true), or release your own mark (false). No ownership transfer; human marks remain protected.'});
  assert.deepEqual(catalog.get('blackice_browser_action').requiredScopes,['read','browser:write']);
  const beforeRecovery=structuredClone(currentTools);
  const browserRead=beforeRecovery.find(tool=>tool.name==='blackice_browser_read');
  assert.match(browserRead.description,/current tabs \(use query:"stopped-task-recovery" on tabs only for explicit stopped-task recovery\)/);
  assert.deepEqual(browserRead.inputSchema.properties.query,{type:'string',maxLength:1000});
  browserRead.description=browserRead.description.replace('current tabs (use query:"stopped-task-recovery" on tabs only for explicit stopped-task recovery)','tabs');
  assert.equal(sha(beforeRecovery),'347c0b72f3824ee213937e1f6b2dc06b22ceea05a5b05f3fbbb67b9d483f8dfe');
  const beforeDocuments=structuredClone(beforeRecovery);
  const documentTool=beforeDocuments.find(tool=>tool.name==='blackice_workspace_read');
  const fields=['startPage','pageCount','startChar','charCount','sheet','startRow','rowCount','startColumn','columnCount'];
  for (const field of fields) {
    assert.equal(documentTool.inputSchema.properties[field]?.type,field==='sheet'?'string':'integer',field);
    delete documentTool.inputSchema.properties[field];
  }
  assert.match(documentTool.description,/read supports local DOCX, PDF and XLSX directly, no conversion required/);
  documentTool.description=documentTool.description.replace(' read supports local DOCX, PDF and XLSX directly, no conversion required.','');
  assert.equal(sha(beforeDocuments),'eb2f9b5653affa2756c6afb350d587f6c6566d1b65c70af59b5ebac9c04bde91');
  const beforeWide=structuredClone(beforeDocuments),wide=beforeWide.find(tool=>tool.name==='blackice_workspace_read');
  assert.equal(wide.inputSchema.properties.roots.maxItems,64);
  assert.match(wide.description,/computer-wide filesystem roots/);
  assert.deepEqual(catalog.get('blackice_workspace_read').requiredScopes,['read','files:read']);
  wide.inputSchema.properties.roots.maxItems=8;
  wide.description="Inspect local files through BLACKICE's bounded file handler. find searches literal filenames/paths, not file contents, and returns resumable pages with coverage and errors. Omitted path/roots searches the working folder and OS-resolved Documents/Desktop/Downloads; exact roots are returned. Relative paths use the configured working directory and explicit absolute paths are supported. Returns a durable job immediately; retrieve its result with blackice_get_job. No model is started.";
  assert.equal(sha(beforeWide),'e71da7e882b95a01424706fe9e7b695987d563296399e09d190333a35212fd56');
  const beforeMark=structuredClone(beforeWide),oldAction=beforeMark.find(tool=>tool.name==='blackice_browser_action');
  oldAction.inputSchema.properties.action.enum=oldAction.inputSchema.properties.action.enum.filter(action=>action!=='tab_mark');
  delete oldAction.inputSchema.properties.inUse;
  assert.equal(sha(beforeMark),'027a4c2ad0448239f1d6e39062d04f7a588688ea6c49ed6229681562b79350e8');
  const beforeFind=structuredClone(beforeMark);
  const findTool=beforeFind.find(tool=>tool.name==='blackice_workspace_read');
  assert.deepEqual(findTool.inputSchema.properties.action.enum,['list','read','search','find','patch_history']);
  assert.deepEqual(findTool.inputSchema.properties.match,{enum:['name','path']});
  assert.equal(findTool.inputSchema.properties.roots.maxItems,8);
  assert.equal(findTool.inputSchema.properties.extensions.maxItems,16);
  assert.equal(findTool.inputSchema.properties.cursor.maxLength,256);
  assert.deepEqual(findTool.inputSchema.properties.timeoutMs,{type:'integer',minimum:100,maximum:10000});
  findTool.inputSchema.properties.action.enum=['list','read','search','patch_history'];
  for(const key of ['roots','match','extensions','cursor','timeoutMs'])delete findTool.inputSchema.properties[key];
  findTool.description="Inspect local files through BLACKICE's bounded file handler. Relative paths use the configured working directory and explicit absolute paths are supported. Returns a durable job immediately; retrieve its result with blackice_get_job. No model is started.";
  assert.equal(sha(beforeFind),'8319ea9cb8f5dc9249936ff562d896ed989e22c5f3a3255d13aab4d0d0db3fc8');

  // .104 changes exactly the shared task-context description (21 occurrences)
  // and optional authenticate form description. Keep every historical hash.
  // Remove only the reviewed SSO action before checking preserved historical contracts.
  const reviewed100=structuredClone(beforeFind.filter(tool=>tool.name!=='blackice_credentials_associate'));
  const oldContext='Host-issued context for this exact task and authenticated owner. Required to opt this call into protected task execution. Never infer it from the grant or another conversation.';
  const newContext='Host-issued context for this exact task and authenticated owner. Optional metadata for browser calls; never a prerequisite to browser dispatch. Non-browser adapters may use it for explicit task-scoped execution. Never infer it from the grant or another conversation.';
  let contextDescriptions=0;
  const restoreContext=value=>{if(!value||typeof value!=='object')return;for(const [key,entry]of Object.entries(value)){if(key==='taskContext'&&Object.hasOwn(entry,'description')){assert.equal(entry.description,newContext);entry.description=oldContext;contextDescriptions++;}else restoreContext(entry);}};
  restoreContext(reviewed100);assert.equal(contextDescriptions,21);
  const reviewedAuthentication=reviewed100.find(tool=>tool.name==='blackice_credentials_authenticate');
  assert.ok(reviewedAuthentication.description.startsWith('Dispatch one authorized same-origin HTTPS POST login/signup'));
  reviewedAuthentication.description=reviewedAuthentication.description.replace('Dispatch one authorized same-origin HTTPS POST login/signup','Dispatch one authorized credential-only HTTPS login/signup');
  assert.equal(sha(reviewed100),'c439ec5da1acd8890fe279f7852dd11c043793d7c1a7c1aa25e9061ea4b41032');

  // Undo exactly the reviewed .100 additions before testing historical hashes.
  // These literals are the parent da1cb32 contract, not refreshed fingerprints.
  for (const name of ['blackice_credentials_save', 'blackice_credentials_update']) {
    const entry = catalog.get(name), tool = entry.definition;
    assert.deepEqual(entry.requiredScopes, ['read', 'browser:write']);
    assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, name.endsWith('_save')
      ? ['requestId', 'origin', 'password', 'expectedRevision']
      : ['requestId', 'origin', 'password', 'expectedRevision', 'credentialId', 'revision']);
    assert.equal(tool.inputSchema.properties.expectedRevision.minimum, 0);
    assert.equal(tool.inputSchema.properties.password.maxLength, 1024);
  }
  const priorTools=structuredClone(reviewed100.filter(tool=>!['blackice_credentials_save','blackice_credentials_update'].includes(tool.name)));
  const priorAction=priorTools.find(tool=>tool.name==='blackice_browser_action');
  assert.deepEqual(priorAction.inputSchema.properties.expectedOwnerKey, { type:'string', minLength:1, maxLength:650 });
  delete priorAction.inputSchema.properties.expectedOwnerKey;
  assert.equal(priorAction.inputSchema.properties.promptText.description, 'Response to the exact observed JavaScript prompt within the authorized task.');
  priorAction.inputSchema.properties.promptText.description='Response to an observed ordinary JavaScript prompt. Never supply passwords or authentication secrets.';
  const currentAccountGuidance='Use ordinary browser controls for authorized account fields, required acknowledgements and submission. The password manager and legacy blackice_credentials_generate/blackice_credentials_fill helpers are optional continuity tools, not prerequisites to browser input.';
  assert.ok(priorAction.description.includes(currentAccountGuidance));
  priorAction.description=priorAction.description.replace(currentAccountGuidance,'Use blackice_credentials_generate and blackice_credentials_fill for account passwords; never put plaintext passwords or authentication secrets in generic input or promptText.');
  const priorAuthentication=priorTools.find(tool=>tool.name==='blackice_credentials_authenticate');
  assert.ok(priorAuthentication.description.includes('The helper result returns no password text.'));
  priorAuthentication.description=priorAuthentication.description.replace('The helper result returns no password text.','Passwords remain secret.');
  assert.equal(sha(priorTools),'9e67ae699068c08d0d582fd52754d5d642be447f278690e2d61a4a1a9f305bf2');

  // Rebuild ONLY the historical cleanup description from its immutable fixture.
  const historicalTools=structuredClone(priorTools);
  const historicalAction=historicalTools.find(tool=>tool.name==='blackice_browser_action');
  historicalAction.description=historicalAction.description.slice(0,-BROWSER_CLEANUP_PROTOCOL.length)+legacyBrowserCleanupProtocol;
  const withoutDescription=tools=>tools.map(({description,...unchanged})=>unchanged);
  assert.deepEqual(withoutDescription(historicalTools),withoutDescription(priorTools));
  assert.equal(sha(historicalTools),legacyToolCatalogSha256);
  assert.deepEqual({sha256:sha(historicalTools),toolCount:historicalTools.length,serverVersion:legacyToolCatalogVersion},{
    sha256:'6ef69a4088e9cb7df34f62291f92435f82eacc769cf3bf44d669fbf06ec1e224',
    toolCount:31,
    serverVersion:'2.33.5',
  });

  // Authentication is one reviewed addition; it does not relax the existing
  // fill schema or permit plaintext secrets or caller-supplied authority.
  const authentication = catalog.tools().find(tool => tool.name === 'blackice_credentials_authenticate');
  const credentialFill = catalog.tools().find(tool => tool.name === 'blackice_credentials_fill');
  assert.deepEqual(authentication.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(catalog.get(authentication.name).requiredScopes, ['read', 'browser:write']);
  assert.deepEqual(authentication.inputSchema, {
    type: 'object',
    properties: {
      ...credentialFill.inputSchema.properties,
      intent: { type: 'string', enum: ['login', 'signup'] },
      submitRef: { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['requestId', 'origin', 'credentialId', 'revision', 'browser', 'tabId', 'expectedUrl', 'expectedDocumentId', 'passwordRef', 'intent', 'submitRef'],
    additionalProperties: false,
  });
  assert.match(authentication.description, /Reuse the same requestId after uncertainty; dispatch is not authentication proof/);
  const previousTools = structuredClone(historicalTools.filter(tool => tool.name !== authentication.name));
  assert.equal(previousTools.length, 30);
  // Verify and undo only the intentional archive/Trash cleanup protocol change
  // before comparing the prior reviewed complete catalog and subsequent deltas.
  const browserDescription=previousTools.find(tool=>tool.name==='blackice_browser_action');
  const currentCleanup='Before reporting task completion, save necessary results/URLs, and leave conversation tabs available for review. Tabs close when the user archives or trashes that conversation, or explicitly uses Close All Tabs in the browser; do not close tabs merely because an agent finished a task. A user-requested individual close still uses blackice_browser_action action close with the exact observed tabId.';
  const previousCleanup='Before reporting task completion, save necessary results/URLs, read current tabs and downloads, and close only the recorded task-created tabs that are no longer needed, using blackice_browser_action action close and the exact observed tabId.';
  assert.ok(browserDescription.description.includes(currentCleanup));
  browserDescription.description=browserDescription.description.replace(currentCleanup,previousCleanup);
  assert.equal(createHash('sha256').update(JSON.stringify(previousTools)).digest('hex'), 'edc72dde20a39a88f159440f83ab255d7cd9205531dff5dbe3df9a1db1801e92');

  // Undo exactly the reviewed conversation scope additions and prove that all
  // other fields, grants and tool contracts retain the preceding fingerprint.

  const scopedNames = ['blackice_browser_read', 'blackice_browser_action', 'blackice_browser_upload', 'blackice_credentials_fill'];
  for (const name of scopedNames) {
    const tool = previousTools.find(item => item.name === name);
    assert.deepEqual(tool.inputSchema.properties.conversationId, {
      type: 'string', minLength: 1, maxLength: 200,
      description: name === 'blackice_credentials_fill'
        ? 'Use the same saved conversationId as the browser calls for this tab.'
        : 'Optional saved BLACKICE conversation ID from action tabs. Reuse it for every browser call in that conversation. Omit only for legacy connection-owned work; the host never guesses from the selected UI conversation.',
    });
    assert.equal(tool.inputSchema.required.includes('conversationId'), false);
    delete tool.inputSchema.properties.conversationId;
  }
  const previousRead = previousTools.find(tool => tool.name === 'blackice_browser_read');
  const scopeReadDescription = 'Supply conversationId from the tabs catalog to isolate one saved conversation. ';
  assert.ok(previousRead.description.includes(scopeReadDescription));
  previousRead.description = previousRead.description.replace(scopeReadDescription, '');
  const previousAction = previousTools.find(tool => tool.name === 'blackice_browser_action');
  const scopeActionDescription = 'Optional conversationId keeps all browser actions in one saved conversation. ';
  assert.ok(previousAction.description.includes(scopeActionDescription));
  previousAction.description = previousAction.description.replace(scopeActionDescription, '');
  const currentOwnershipDescription = 'Supply the same saved conversationId on every browser call to scope work to that conversation. Calls without conversationId retain a connection-wide owner: never treat all connection tabs as yours. Personal tabs and other conversations remain separate; transfer ownership explicitly when moving work.';
  const previousOwnershipDescription = 'Direct tools share a connection-wide owner, not a per-conversation owner: never treat all connection tabs as yours.';
  assert.ok(previousAction.description.includes(currentOwnershipDescription));
  previousAction.description = previousAction.description.replace(currentOwnershipDescription, previousOwnershipDescription);
  assert.equal(createHash('sha256').update(JSON.stringify(previousTools)).digest('hex'), 'd533e432aa394fc9e8c75e800fe4fc5f2c8087ae65f41ef773a46d9005cae3d4');

  // Preserve the two previously reviewed fill-description changes as another
  // exact delta, rather than replacing their existing contract assertions.
  const previousBrowserInput = previousTools.find(tool => tool.name === 'blackice_browser_action').inputSchema.properties;
  assert.deepEqual(previousBrowserInput.text, {
    type: 'string', maxLength: 16384,
    description: 'Required replacement text for fill; text:"" intentionally clears the field. Omit value when filling. Also used for type or expected text for wait.',
  });
  assert.deepEqual(previousBrowserInput.value, {
    type: 'string', maxLength: 16384,
    description: 'Selection-only value for action:"select". Fill requires text and does not accept value.',
  });
  delete previousBrowserInput.text.description;
  delete previousBrowserInput.value.description;
  assert.equal(createHash('sha256').update(JSON.stringify(previousTools)).digest('hex'), 'd4acb0fd8a4e2bf55a60230222896534311914bf2eb723db13bd5fab5c28c0dc');

  // Preserve the earlier canonical-creation review as a second exact delta.
  const previousEdit = previousTools.find(tool => tool.name === 'blackice_edit_plan');
  const currentCreateDescription = 'At expectedRevision 0 use the sole create_contract operation with a complete canonical contract, or legacy create with goal and steps.';
  const previousCreateDescription = 'At expectedRevision 0 use the sole explicit create operation with goal and steps.';
  assert.ok(previousEdit.description.includes(currentCreateDescription));
  previousEdit.description = previousEdit.description.replace(currentCreateDescription, previousCreateDescription);
  const currentOperations = previousEdit.inputSchema.properties.operations.items.oneOf;
  assert.equal(currentOperations.filter(operation => operation.properties.type.const === 'create_contract').length, 1);
  previousEdit.inputSchema.properties.operations.items.oneOf = currentOperations.filter(operation => operation.properties.type.const !== 'create_contract');
  assert.equal(createHash('sha256').update(JSON.stringify(previousTools)).digest('hex'), 'e1445fa822126a6939a107c0f4a89fd68ad4e30337cf0e94c4209b7550503bc8');

  // DirectExecutionAPI always registers these two tools. This fixture does not install
  // the separately supplied native attachment extension or graph/cycle services.
  const contexts=catalog.tools().find(tool=>tool.name==='blackice_task_context');
  assert.deepEqual(contexts.inputSchema.oneOf.map(branch=>branch.properties.action.const),['issue','read','revoke']);
  assert.equal(catalog.tools().some(tool=>tool.name==='blackice_native_task_context'),false);
  const contracts=catalog.tools().find(tool=>tool.name==='blackice_task_contract');
  assert.ok(contracts.inputSchema.oneOf.some(branch=>branch.properties.action.const==='bind_plan'));
  const read=catalog.tools().find(tool=>tool.name==='blackice_browser_read');
  assert.equal(read.annotations.readOnlyHint,true);
  assert.ok(read.inputSchema.properties.action.enum.includes('diagnostics'));
  assert.equal(read.inputSchema.properties.after.minimum,0);
  assert.equal(read.inputSchema.properties.limit.maximum,256);
  assert.equal(read.inputSchema.properties.expectedUrl,undefined);
  assert.equal(read.inputSchema.properties.expectedDocumentId,undefined);
  const browserAction=catalog.tools().find(tool=>tool.name==='blackice_browser_action');
  assert.match(browserAction.description,/Keep personal\/pre-existing pages, user-owned or transferred tabs, the calling coordination chat/);
  assert.match(browserAction.description,/agent cleanup needs independent evidence that the page's work is finished/);
  assert.match(browserAction.description,/limited DOM inspection for deliberate per-page manual review/);
  const action=browserAction.inputSchema;
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
  const replacement=planning.properties.operations.items.oneOf.find(operation=>operation.properties.type.const==='replace_contract');
  assert.deepEqual(replacement.required,['type','contract']);
  assert.equal(replacement.additionalProperties,false);
  assert.equal(edits.replace_contract.contract.additionalProperties,false);
  assert.equal(edits.replace_contract.contract.properties.contractVersion.const,2);
  assert.equal(edits.replace_contract.contract.properties.workItems.minItems,1);
  const workItem=edits.replace_contract.contract.properties.workItems.items;
  assert.equal(workItem.required.includes('operationScopes'),false);
  assert.deepEqual(workItem.properties.operationScopes.items.required,['effect','resourceKeys']);
  assert.ok(workItem.properties.operationScopes.items.properties.confirmationCriterionId);
  assert.equal(edits.replace_contract.contract.properties.planEpoch,undefined);
  assert.equal(edits.replace_contract.contract.properties.runtime,undefined);
  assert.equal(edits.replace_contract.contract.properties.outcomes,undefined);
  const creation=planning.properties.operations.items.oneOf.find(operation=>operation.properties.type.const==='create_contract');
  assert.deepEqual(creation.required,['type','contract']);
  assert.equal(creation.additionalProperties,false);
  assert.deepEqual(edits.create_contract.contract,edits.replace_contract.contract);
  assert.ok(edits.create_contract.userAgency);
  assert.equal(edits.create_contract.contract.properties.planEpoch,undefined);
  assert.equal(edits.create_contract.contract.properties.runtime,undefined);
  assert.equal(edits.create_contract.contract.properties.outcomes,undefined);

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
    ['read'], ['read'], ['read'], ['read'],
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
