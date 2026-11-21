import {assertCompatibleDirectoryMode} from './conversation-execution-modes.mjs';
import { createHash } from 'node:crypto';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { normalizePlanningMode } from '../public/planning-mode.mjs';
import { normalizePlanningOntology } from '../public/planning-module-policy.mjs';
import { downloadChatGPTFile, validateChatGPTDownloadURL } from './chatgpt-file-import.mjs';

const planningModes = ['ontology', 'off'];
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const sha = text => createHash('sha256').update(text).digest('hex');
const fail = (message, code = 'CHATGPT_CHAT_START_INVALID', status = 400) =>
  Object.assign(new Error(message), { code, status });
const field = maxLength => ({ type: 'string', minLength: 1, maxLength });
const requestId = { ...field(120), pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$' };
const check = signal => {
  if (signal?.aborted) throw Object.assign(
    fail('The request was cancelled before creating a BLACKICE conversation.', 'ABORT_ERR', 409),
    { name: 'AbortError' }
  );
};

/**
 * Starts a new saved BLACKICE conversation; goal controls can continue an existing one.
 * It uses the existing mission workflow, admission and conversation archive.
 * The caller uses the already authenticated connector session.
 * There is no further task permission or per-action approval.
 *
 * The provider starts asynchronously after acceptance. A completed direct
 * job confirms admission, never that the model finished successfully.
 */
export function chatGPTStartChatTool({ engine, attachments = engine?.attachments,
  defaultCwd, isClosing = () => false, download = downloadChatGPTFile } = {}) {
  if (typeof engine?.startRun !== 'function' || typeof defaultCwd !== 'string' || !defaultCwd)
    throw fail('Start Chat requires the initialized BLACKICE execution engine and workspace.',
      'CHATGPT_CHAT_START_CONFIGURATION', 503);
  return {
    definition: {
      name: 'blackice_start_chat',
      scope: 'read',
      mutating: true,
      requiredScopes: ['read'],
      description: "Create a new saved BLACKICE Chat conversation and start its model on message. Requires requestId and message; omit model to use the saved default. The conversation starts in the configured working directory; absolute local attachmentPaths may be elsewhere on the computer. Add existing attachmentIds, local attachmentPaths or one attached file as needed. Returns a run ID after admission. Read blackice_get_run_result for progress and the completed answer. Starting a conversation uses provider tokens; reading its result does not start another run.",
      inputSchema: {
        type: 'object',
        required: ['requestId', 'message'],
        additionalProperties: false,
        properties: {
          requestId,
          message: { type:'string',minLength:1, description: "Task text for the new conversation. Only this supplied text is sent as its message." },
          model: { ...field(400), description: 'A model ID from BLACKICE. Omit to use its currently configured default.' },
          planningMode: { type: 'string', enum: planningModes },
          planningOntology: { type:'object', description:'Per-run On/Off modules: version 2 and Boolean module values.', additionalProperties:false, properties:{version:{type:'integer',enum:[2]},modules:{type:'object',additionalProperties:{type:'boolean'}}} },
          directoryMode:{type:'string',enum:['off'],description:"This entry point supports directoryMode:\"off\" only."},
          goal: { type: 'object', additionalProperties: false, description: 'Enable automatic follow-up turns in this conversation. maxTurns defaults to null for unlimited turns; a positive integer sets a total turn limit.', properties: { maxTurns: { type: ['integer', 'null'], minimum: 1 }, deadlineAt: {type:['string','null'],description:'Absolute ISO 8601 UTC/offset stop time, or null to clear.'}, deadlineTimeZone: {type:'string',description:'EST fixed UTC-05, Eastern observes DST, or IANA zone.'} } },
          effort: { type: 'string', enum: efforts },
          serviceTier: { type: 'string', enum: ['default', 'fast'] },
          attachmentIds: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^file_[a-f0-9]{32}$' }, description: 'Already saved BLACKICE attachment IDs to include in this new conversation.' },
          attachmentPaths: { type: 'array', maxItems: 10, items: { ...field(4096) }, description: 'Local files to import into the same saved BLACKICE attachment store, including paths returned by blackice_import_file.' },
          file: { type: 'object', required: ['download_url','file_id'], additionalProperties: false,
            description: 'One attached ChatGPT file transferred into BLACKICE and included in the new agent turn.',
            properties: { download_url: { ...field(16000) }, file_id: { ...field(200) },
              file_name: { ...field(240) }, mime_type: { ...field(200) } } },
        },
      },
      _meta: { 'openai/fileParams': ['file'] },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    // Do not retain the user's prompt twice in the connector job ledger.
    // The actual task is persisted once by BLACKICE's normal conversation store.
    durableArguments: args => ({
      requestId: args.requestId,
      messageCharacters: args.message.length,
      messageSha256: sha(args.message),
      ...(args.model ? { model: args.model } : {}),
      ...(args.planningMode ? { planningMode: args.planningMode } : {}),
      directoryMode:args.directoryMode||'off',
      ...(args.goal ? { goal: { maxTurns: args.goal.maxTurns ?? null, ...(Object.hasOwn(args.goal,'deadlineAt')?{deadlineAt:args.goal.deadlineAt}:{}), ...(args.goal.deadlineTimeZone?{deadlineTimeZone:args.goal.deadlineTimeZone}:{}) } } : {}),
      ...(args.planningOntology ? { planningOntology: normalizePlanningOntology(args.planningOntology) } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
      attachmentIds: args.attachmentIds || [],
      attachmentPathsDigest: sha(JSON.stringify(args.attachmentPaths || [])),
      attachmentPathsCount: (args.attachmentPaths || []).length,
      ...(args.file ? { file: { file_id: args.file.file_id,
        ...(args.file.file_name ? { file_name: args.file.file_name } : {}) } } : {}),
    }),
    async execute(args, { signal, client } = {}) {
      check(signal);
      if (isClosing()) throw fail('BLACKICE is shutting down. No conversation was started.',
        'CHATGPT_CHAT_START_UNAVAILABLE', 503);
      const message = args.message?.trim();
      if (!message) throw fail('Provide a nonempty task.');
      assertCompatibleDirectoryMode(message,args.directoryMode);
      if (args.directoryMode!=='on' && message.length > 50000) throw fail('Provide a task of at most 50,000 characters with Directory Off.');
      if (!client?.id || typeof args.requestId !== 'string')
        throw fail('A uniquely identified authorized request is required.');
      const externalIds = Array.isArray(args.attachmentIds) ? args.attachmentIds : [];
      const paths = Array.isArray(args.attachmentPaths) ? args.attachmentPaths : [];
      if (externalIds.length + paths.length + (args.file ? 1 : 0) > 10)
        throw fail('A conversation can include at most 10 attachments.');
      if ((externalIds.length || paths.length || args.file)
        && (!attachments || typeof attachments.importPath !== 'function' || typeof attachments.importBytes !== 'function'))
        throw fail('The shared BLACKICE attachment store is unavailable.', 'CHATGPT_CHAT_START_ATTACHMENTS_UNAVAILABLE', 503);
      const added = [];
      if (attachments && (externalIds.length || paths.length || args.file)) {
        await attachments.init();
        for (const originalPath of paths) {
          check(signal);
          const receipt = await attachments.importPath(originalPath, { signal });
          added.push(receipt.id);
        }
        if (args.file) {
          validateChatGPTDownloadURL(args.file.download_url);
          const bytes = await download(args.file.download_url, { signal });
          check(signal);
          const receipt = await attachments.importBytes({
            name: args.file.file_name || args.file.file_id,
            bytes, source: 'upload', signal,
          });
          added.push(receipt.id);
        }
      }
      const attachmentIds = attachments ? attachments.validateIds([...new Set([...externalIds, ...added])]) : [];
      check(signal);
      const key = sha(client.id + '\0' + args.requestId).slice(0, 36);
      const authoredPlanningMode = args.planningMode ?? 'ontology';
      const planningOntology = authoredPlanningMode === 'ontology' ? normalizePlanningOntology(args.planningOntology ?? engine.runtimeSettings?.get()?.planningOntology) : null;
      const planningMode = normalizePlanningMode(authoredPlanningMode);
      const selectedModel = args.model || 'default';
      const workflow = createMissionWorkflow({
        id: 'chatgpt_mission_' + key,
        task: message,
        model: selectedModel,
        cwd: defaultCwd,
        planningMode: authoredPlanningMode,
        ...(args.effort ? { effort: args.effort } : {}),
        ...(args.serviceTier ? { serviceTier: args.serviceTier } : {}),
      });
      check(signal);
      // Use the same idempotency and capacity/model admission path as Chat.
      // No separate untracked worker, browser click, or shell process.
      const run = engine.startRun({
        requestId: 'chatgpt_start_' + key,
        workflow,
        input: { task: message, cwd: defaultCwd, directoryMode:args.directoryMode||'off', planningMode: authoredPlanningMode, ...(planningOntology ? { planningOntology } : {}), ...(args.goal ? { goal: { objective: message, maxTurns: args.goal.maxTurns ?? null, ...(Object.hasOwn(args.goal,'deadlineAt')?{deadlineAt:args.goal.deadlineAt}:{}), ...(args.goal.deadlineTimeZone?{deadlineTimeZone:args.goal.deadlineTimeZone}:{}) } } : {}), attachmentIds },
      });
      return {
        success: true,
        contentItems: [{
          type: 'inputText',
          text: JSON.stringify({
            accepted: true,
            runId: run.id,
            taskId: run.taskId || run.id,
            status: run.status,
            selectedModel: selectedModel,
            goalMode: Boolean(args.goal),
            planningMode,
            planningEnforcement: run.planningEnforcement || null,
            ...(run.planningOntology ? { planningOntology: run.planningOntology } : {}),
            attachmentIds,
            attachmentCount: attachmentIds.length,
            completed: false,
            message: 'BLACKICE accepted a new saved conversation. Inspect its actual status and output separately.',
          }),
        }],
      };
    },
  };
}
