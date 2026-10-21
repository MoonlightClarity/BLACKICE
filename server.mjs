import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConversationArchive } from './lib/conversations.mjs';
import { OperationsStore } from './lib/operations.mjs';
import {ProjectStore} from './lib/projects.mjs';
import {MethodStore} from './lib/methods.mjs';
import {CapabilityStore} from './lib/capabilities.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HarnessEngine } from './lib/engine.mjs';
import { CodexRuntime } from './lib/codex.mjs';
import { DesktopController } from './lib/desktop.mjs';
import { KnowledgeStore } from './lib/knowledge.mjs';
import { PromptTemplateStore } from './lib/prompt-templates.mjs';
import { BrowserWorkspace } from './lib/browser.mjs';
import { ProviderRuntime } from './lib/providers.mjs';
import { CHAT_MODE_RETIRED_MESSAGE } from './lib/retired-models.mjs';
import { IdentityStore } from './lib/identity.mjs';
import { LearningStore } from './lib/learning.mjs';
import { ConnectionManager } from './lib/mcp.mjs';
import { AttachmentStore } from './lib/attachments.mjs';
import { TaskStateStore } from './lib/task-state.mjs';
import { TaskInbox } from './lib/inbox.mjs';
import { RuntimeSettingsStore } from './lib/runtime-settings.mjs';
import { createMissionWorkflow } from './public/mission-model.mjs';
import { parseConnectionImport } from './lib/connection-import.mjs';
import {LiveEditJournal} from './lib/live-edits.mjs';
import { createSignedBrowserIntegration } from './lib/signed-browser.mjs';
import { chromeBrowserStatus, registerChromeBrowser } from './lib/chrome-browser.mjs';
import { revealBrowserOS } from './lib/browser-window.mjs';
import { BrowserImportBridge } from './lib/browser-import.mjs';
import { BrowserCredentialVault, credentialCheck, credentialError } from './lib/browser-credentials.mjs';
import { BrowserCredentialMirror } from './lib/browser-credential-mirror.mjs';
import { BrowserCredentialDestination } from './lib/browser-credential-destination.mjs';
import { createDirectBrowserCredentialTools } from './lib/browser-credential-tools.mjs';
import { DiagnosticsStore } from './lib/diagnostics.mjs';
import { writeEventStream } from './lib/event-stream.mjs';
import {ApplicationWorkspace} from './lib/application-workspace.mjs';
import { AgentEmailStore } from './lib/agent-email.mjs';
import { EmailOAuthManager } from './lib/email-oauth.mjs';
import { discoverHimalayaExecutable } from './lib/email-setup.mjs';
import { EmailClientBridge } from './lib/email-client.mjs';
import { planningQuery, listPlanningWorkspace, editPlanningWorkspace, readPlanningAwareness, updatePlanningPresence, readPlanningOrganization, editPlanningOrganization, projectPlanningWorkspace, guardArchivedProjectExecution } from './lib/planning-workspace.mjs';
import { PlanningOrganizationStore } from './lib/planning-organization.mjs';
import { RemoteAccessManager } from './lib/remote-access.mjs';
import { RemoteAgentAPI, isRemoteAgentPath } from './lib/remote-agent-api.mjs';
import { ChatGPTOAuth } from './lib/chatgpt-oauth.mjs';
import { ChatGPTConnector } from './lib/chatgpt-connector.mjs';
import { ChatGPTSetup, CHATGPT_SETUP_URL } from './lib/chatgpt-setup.mjs';
import { ChatGPTPlanningAPI } from './lib/chatgpt-planning.mjs';
import { DirectExecutionAPI } from './lib/direct-execution-api.mjs';
import { desktopRestartTool } from './lib/desktop-restart-tool.mjs';
import { createDesktopRestartBarrier } from './lib/desktop-restart-barrier.mjs';
import { chatGPTFileImportTool } from './lib/chatgpt-file-import.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_VERSION = JSON.parse(await fs.readFile(path.join(APP_DIR, 'package.json'), 'utf8')).version;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf' };
const safeEqual = (a, b) => {
  if (typeof a !== 'string') return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
};

export async function createHarnessServer(options = {}) {
  const port = Number(options.port ?? process.env.RELAY_PORT ?? 4317);
  const defaultCwd = path.resolve(options.defaultCwd || process.env.RELAY_WORKSPACE || path.join(APP_DIR, 'workspace'));
  const dataDir = options.dataDir || path.join(APP_DIR, 'data');
  await fs.mkdir(defaultCwd, { recursive: true });
  const remoteAccess = options.remoteAccess === false ? null : options.remoteAccess || new RemoteAccessManager({ dataDir });
  await remoteAccess?.init();
  const diagnostics=options.diagnostics||await new DiagnosticsStore({dataDir:path.resolve(dataDir),version:APP_VERSION}).init();
  const runtimeSettings = options.runtimeSettings || await new RuntimeSettingsStore({ dataDir }).init();
  const showBrowserOS = options.showBrowserOS || revealBrowserOS;
  const runtime = options.runtime || new ProviderRuntime({ codex: new CodexRuntime(), dataDir, ...options.secretStorage });
  await runtime.init?.();
  const desktop = options.desktop || new DesktopController();
  const browser = options.browser || new BrowserWorkspace();
  const applicationWorkspace=options.applicationWorkspace||await new ApplicationWorkspace({dataDir,runtime:options.applicationRuntime,catalog:options.applicationCatalog}).init();
  const knowledge = options.knowledge || new KnowledgeStore({ dataDir });
  await knowledge.init();
  const prompts = options.prompts || new PromptTemplateStore({ dataDir }); await prompts.init();
  const identity = options.identity || new IdentityStore({ dataDir }); await identity.init();
  const connections = options.connections || new ConnectionManager({ dataDir, ...options.secretStorage }); await connections.init();
  const signedIntegration=options.signedBrowser===true?createSignedBrowserIntegration({...options.signedBrowserOptions,connections,startBrowser:options.startSignedBrowser}):null;
  let notifySignedBrowser=()=>{};
  const refreshSignedBrowser=async options=>{if(!signedIntegration)return undefined;const value=await signedIntegration.refresh(options);notifySignedBrowser();return value;};
  if(signedIntegration){connections.signedBrowser=signedIntegration.status();connections.refreshSignedBrowser=refreshSignedBrowser;void refreshSignedBrowser().catch(()=>{});}
  let browserImport, browserCredentials, browserCredentialMirror, browserCredentialDestinations;
  const browserStatus = req => {
    const info = browserImport?.snapshot(), localManagement = Boolean(req && req.headers?.['x-blackice-remote'] !== '1');
    return { ...browser.status(), ...(signedIntegration ? { signedBrowser:signedIntegration.status() } : {}), ...(options.signedBrowser === true ? { chromeBrowser: chromeBrowserStatus({ connections }), ...(info ? { neoImport: { ...info, localManagement, capabilities: { ...info.capabilities, open: localManagement && info.capabilities.open === true } } } : {}) } : {}) };
  };
  let chromeConnect;
  const attachments = options.attachments || new AttachmentStore({ dataDir }); await attachments.init();
  const tasks = options.tasks || new TaskStateStore({ dataDir: path.resolve(dataDir) }); await tasks.init();
  const planningOrganization = options.planningOrganization || new PlanningOrganizationStore({ dataDir: path.resolve(dataDir) }); await planningOrganization.init();
  const emailOAuth = options.emailOAuth || await new EmailOAuthManager({ dataDir: path.resolve(dataDir), ...options.secretStorage, openExternal: options.openExternal, tokenRuntimeExecutable: options.tokenRuntimeExecutable || process.execPath }).init();
  const email = options.email || await new AgentEmailStore({ dataDir: path.resolve(dataDir), oauth: emailOAuth }).init();
  const emailExecutableHint = options.emailExecutableHint ?? await discoverHimalayaExecutable();
  const emailSnapshot = req => ({ ...email.snapshot(), localManagement: req?.headers['x-blackice-remote'] !== '1', setupHints: { executable: emailExecutableHint } });
  const engine = options.engine || new HarnessEngine({ runtime, dataDir, defaultCwd, desktop, knowledge, browser, identity, connections, tasks, attachments, email, ...(options.maxConcurrentRuns !== undefined ? {maxConcurrentRuns:options.maxConcurrentRuns} : {}) });
  await engine.init();
  engine.runtimeSettings = runtimeSettings;
  engine.prompts = prompts;
  engine.email = email;
  engine.applicationWorkspace=applicationWorkspace;
  const conversations=await new ConversationArchive({dataDir,engine}).init();
  // Recent-run retention must not turn a repeated send into a new task.
  const recoverClientRequest = async value => {
    const id = engine.clientRequestRunId?.(value?.requestId);
    if (id && !engine.runs.has(id)) engine.restoreArchivedRun(await conversations.get(id));
  };
  const inbox = options.inbox || new TaskInbox({ dataDir, engine, createWorkflow: item => createMissionWorkflow({ id: `inbox-${item.id}`, task: item.input, cwd: item.cwd }) }); await inbox.init();
  const operations=options.operations||new OperationsStore({dataDir,inbox,engine});await operations.init({preservePausedState:options.desktopRestart?.isRestartStartup?.()===true});
  engine.operations=operations;
  const projects=await new ProjectStore({dataDir,engine,isPaused:()=>Boolean(engine.maintenanceRequested)}).init();
  guardArchivedProjectExecution(projects, planningOrganization);
  const capabilities=await new CapabilityStore({dataDir,projects}).init();
  const methods=await new MethodStore({dataDir,projects}).init();
  engine.projects=projects;engine.capabilities=capabilities;engine.methods=methods;
  const pauseProjects=reason=>Promise.all(projects.list().filter(project=>project.status==='running').map(project=>projects.pause(project.id,reason)));
  const observers=new Map();
  const releaseObserver=(runId,response,group=observers.get(runId))=>{
    if(!group)return;group.clients.delete(response);
    if(!group.clients.size&&observers.get(runId)===group){observers.delete(runId);group.controller.abort();liveEdits.forget(runId).catch(()=>{});}
  };
  const writeObserver=(runId,response,text)=>{
    const accepted=writeEventStream(response,text);
    if(!accepted)releaseObserver(runId,response);
    return accepted;
  };
  const liveEdits=options.liveEdits||new LiveEditJournal({dataDir,onEvent:(runId,event)=>{const text=`data: ${JSON.stringify({type:'run.edit',runId,data:event})}\n\n`;for(const response of observers.get(runId)?.clients||[])writeObserver(runId,response,text);}});engine.liveEdits=liveEdits;
  const stopObserving=async(runId,reason)=>{const group=observers.get(runId);if(!group)return;observers.delete(runId);group.controller.abort();await liveEdits.forget(runId);for(const response of group.clients){if(writeEventStream(response,`data: ${JSON.stringify({type:'observe.stopped',runId,data:{reason}})}\n\n`))response.end();}group.clients.clear();};
  const learning = options.learning || new LearningStore({ dataDir, runtime, knowledge, getRuntimeSettings: () => runtimeSettings.get(), getRun: id => engine.getRun(id), isForegroundBusy: () => engine.executions.size > 0 || engine.closed || engine.maintenanceRequested || inbox.hasPendingWork() || operations.hasPendingWork() || projects.hasPendingWork(), onProfileFact: fact => identity.recordFact(fact), onProfileFactUndo: fact => identity.removeFact(fact) });
  await learning.init(); engine.learning = learning;
  if (desktop.status().available && options.autoAttachDesktop !== false) await desktop.setEnabled(true);
  const session = randomBytes(32).toString('hex');
  const clients = new Set();
  const knowledgeMutations = new Set();
  const fileMutations = new Set();
  let connectorStartupEnabling = null;
  const mutateKnowledge = operation => { const pending = Promise.resolve().then(operation); knowledgeMutations.add(pending); pending.then(() => knowledgeMutations.delete(pending), () => knowledgeMutations.delete(pending)); return pending; };
  let boundPort = port, closePromise, maintenanceRequested=false, remoteAgentApi, chatGPTConnector, directExecution;
  const connectorPresence = () => ({ available: Boolean(remoteAccess && chatGPTConnector?.healthy), enabled: Boolean(chatGPTConnector?.enabled), localManagement: true });
  const beginMaintenance=async()=>{
    if(maintenanceRequested)throw Object.assign(new Error('Relay is already preparing profile maintenance.'),{status:409});
    if(engine.executionStatus().activeCount||learning.active)throw Object.assign(new Error('Finish or stop active work before backing up or restoring Relay.'),{status:409});
    if(applicationWorkspace.status().sessions.some(item=>['starting','running','needs_attention'].includes(item.state)))throw Object.assign(new Error('End private application sessions before profile maintenance; they may contain unsaved work.'),{status:409});
    maintenanceRequested=true;engine.maintenanceRequested=true;
    try{if((await directExecution?.status())?.jobs.active || chatGPTConnector?.inflight.size)throw Object.assign(new Error('Finish or cancel active ChatGPT connector actions before profile maintenance.'),{status:409});await emailOAuth.drain();await Promise.all([inbox.pause('Profile maintenance requested. Resume queued work when ready.'),operations.pause('Profile maintenance requested. Resume operations when ready.'),pauseProjects('Profile maintenance requested. Resume project work when ready.')]);
      // Finish admitted local writes before profile maintenance.
      await Promise.all([...knowledgeMutations,...fileMutations,prompts.writeChain,email.writeChain,emailOAuth.writeChain,connectorSetup.tail]);}
    catch(error){maintenanceRequested=false;engine.maintenanceRequested=false;throw error;}
  };
  const endMaintenance=()=>{maintenanceRequested=false;engine.maintenanceRequested=false;};
  const restartBarrier = createDesktopRestartBarrier({
    isClosing: () => Boolean(closePromise),
    isMaintenance: () => maintenanceRequested,
    getEngineStatus: () => engine.executionStatus(),
    getLearningActive: () => Boolean(learning.active),
    getApplicationSessions: () => applicationWorkspace.status().sessions,
    getBrowserStatus: () => browser.status(),
    getDirectJobs: async () => {
      if (!directExecution) return [];
      if (directExecution.storageError) throw new Error('Direct action storage needs recovery before restarting.');
      return directExecution.jobs.snapshot({ unfinishedOnly: true });
    },
    getPendingActions: () => Boolean(inbox.hasPendingWork() || operations.hasPendingWork() || projects.hasPendingWork() || emailOAuth.flow || emailOAuth.callbackOperations?.size || emailOAuth.requests?.size || connectorStartupEnabling),
    setMaintenance: value => { maintenanceRequested = value; engine.maintenanceRequested = value; },
    drain: async () => {
      // Finish admitted writes without cancelling work or changing persisted
      // queue settings. The shared gate prevents new mutations while draining.
      await Promise.all([
        ...(chatGPTConnector?.inflight || []), ...knowledgeMutations, ...fileMutations,
        prompts.writeChain, email.writeChain, emailOAuth.writeChain,
        connectorSetup.tail, inbox.tail, operations.tail, projects.tail, directExecution?.jobs.tail,
      ]);
      const browserState = browser.status();
      if (browserState.available === true || browserState.persistentSession === true || browserState.tabs?.length) {
        if (typeof browser.flushPersistence !== 'function') throw Object.assign(new Error('Browser persistence could not be verified before restarting BLACKICE.'), { code: 'DESKTOP_RESTART_STORAGE', status: 503 });
        await browser.flushPersistence();
      }
    },
  });
  const assertRestartReady = context => restartBarrier.assertReady(context);
  const assertRestartPrepared = () => restartBarrier.assertPrepared();
  const beginRestart = context => restartBarrier.begin(context);
  const endRestart = () => restartBarrier.end();
  const status = req => { const info = runtime.status(); return { ...info, chatGPTConnector: connectorPresence(), browserCredentials: { available: true, localManagement: req?.headers?.['x-blackice-remote'] !== '1' }, error: info.error || info.lastError || null, cwd: defaultCwd, app: 'relay-agent-harness', version: APP_VERSION, maintenance:options.maintenanceStatus?.()||null, diagnostics:diagnostics.status(), desktopApp: Boolean(options.installPath), ...(options.installPath ? { installPath: options.installPath } : {}), runtimeSettings: runtimeSettings.get(), execution: engine.executionStatus(), storage: engine.storageStatus(), knowledge: knowledge.status(), prompts: prompts.status(), email: email.status(), browser: browserStatus(req), applicationSessions:applicationWorkspace.status(), identity: identity.status(), learning: learning.status(), connections: connections.status(), attachments: attachments.status(), inbox: inbox.status(), conversations:conversations.status(),operations:operations.status(),projects:projects.status(),capabilities:capabilities.status(),methods:methods.status() }; };
  const diagnosticRunStates=new Map();
  const supportSnapshot=()=>{const value=status();return diagnostics.snapshot({version:APP_VERSION,counts:{savedRuns:engine.listRuns().length,activeRuns:value.execution.activeCount,conversations:value.conversations.conversations,providers:value.providers?.length||0,connections:value.connections?.connections?.length||value.connections?.count||0},health:{storageHealthy:value.storage.healthy,conversationStorageHealthy:value.conversations.healthy,identityHealthy:value.identity.healthy,attachmentsHealthy:value.attachments.healthy,knowledgeHealthy:value.knowledge.healthy,promptsHealthy:value.prompts.healthy,browserAvailable:value.browser.available,desktopAvailable:value.desktop?.available,inboxPaused:value.inbox.paused,operationsPaused:value.operations.paused}});};
  const sendEvent = event => {
    remoteAgentApi?.publish(event);
    if(event.type==='run.updated'&&event.runId&&event.data?.status&&diagnosticRunStates.get(event.runId)!==event.data.status){diagnosticRunStates.set(event.runId,event.data.status);if(diagnosticRunStates.size>1000)diagnosticRunStates.delete(diagnosticRunStates.keys().next().value);void diagnostics.record({component:'engine',event:['completed','failed','cancelled'].includes(event.data.status)?'run_finished':'run_started',state:event.data.status});}
    const text = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      if (!writeEventStream(res,text)) clients.delete(res);
    }
  };
  notifySignedBrowser=()=>sendEvent({type:'browser.updated',data:browserStatus(),at:new Date().toISOString()});
  const offPlanningAwareness = tasks.awareness?.subscribe(data => sendEvent({ type: 'planning.awareness', data, at: new Date().toISOString() }));
  remoteAccess?.on?.('updated', value => sendEvent({ type: 'remote-access.updated', data: value, at: new Date().toISOString() }));
  options.desktopLifecycle?.on?.('updated', value => sendEvent({ type: 'desktop.lifecycle', data: value, at: new Date().toISOString() }));
  engine.on('event', sendEvent);
  runtimeSettings.on('updated', value => sendEvent({type:'runtime.settings',data:value,at:new Date().toISOString()}));
  prompts.on?.('updated', value => sendEvent({ type: 'prompts.updated', data: value, at: new Date().toISOString() }));
  engine.on('event', event => { if (event.type === 'run.updated' || event.type === 'node.updated' || event.type === 'execution.settings') sendEvent({ type: 'execution.updated', data: engine.executionStatus(), at: new Date().toISOString() }); });
  engine.on('event',event=>{if(event.type==='run.updated'&&event.data?.settled&&observers.has(event.runId)){Promise.resolve(liveEdits.flush?.(event.runId)).finally(()=>stopObserving(event.runId,'Task finished.')).catch(()=>{});}});
  engine.on('storage.updated', value => sendEvent({ type: 'storage.updated', data: value, at: new Date().toISOString() }));
  desktop.on?.('status', value => {
    sendEvent({ type: 'desktop.updated', data: value, at: new Date().toISOString() });
    if (!value.enabled) for (const run of engine.listRuns()) if (['queued', 'running', 'waiting'].includes(run.status) && run.workflow?.nodes.some(n => n.desktop)) engine.cancelRun(run.id);
  });
  desktop.on?.('action', value => sendEvent({ type: 'desktop.action', data: value, at: new Date().toISOString() }));
  browser.on?.('status', value => sendEvent({ type: 'browser.updated', data: value, at: new Date().toISOString() }));
  learning.on?.('updated', value => sendEvent({ type: 'learning.updated', data: value, at: new Date().toISOString() }));
  connections.on?.('status', value => sendEvent({ type: 'connections.updated', data: value, at: new Date().toISOString() }));
  email.on?.('updated', value => sendEvent({type:'email.updated',data:email.status(),at:new Date().toISOString()}));
  operations.on?.('updated',value=>sendEvent({type:'operations.updated',data:value,at:new Date().toISOString()}));
  projects.on?.('updated',value=>sendEvent({type:'projects.updated',data:value,at:new Date().toISOString()}));
  capabilities.on?.('updated',value=>sendEvent({type:'capabilities.updated',data:value,at:new Date().toISOString()}));
  applicationWorkspace.on?.('updated',value=>sendEvent({type:'application-sessions.updated',data:value,at:new Date().toISOString()}));
  conversations.on?.('updated',value=>sendEvent({type:'conversations.updated',data:value,at:new Date().toISOString()}));
  conversations.on?.('metadata.updated',value=>sendEvent({type:'conversations.changed',data:value,at:new Date().toISOString()}));
  inbox.on?.('updated', value => sendEvent({ type: 'inbox.updated', data: value, at: new Date().toISOString() }));
  engine.on('learning.error', error => { void diagnostics.recordError('learning','request_failed',error);console.error('Learning review failed; see support diagnostics.'); sendEvent({ type: 'learning.error', data: { message: error.message }, at: new Date().toISOString() }); });
  engine.on('storage.error', error => {void diagnostics.recordError('storage','storage_failed',error);console.error('History save failed; see support diagnostics.');});
  const runtimeUpdate = () => sendEvent({ type: 'runtime.status', data: status(), at: new Date().toISOString() });
  runtime.on?.('status', runtimeUpdate);
  runtime.on?.('error', error => { void diagnostics.recordError('runtime','runtime_failed',error);console.error('Agent runtime failed; see support diagnostics.'); runtimeUpdate(); });
  function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
  async function body(req, maxBytes = 1024 * 1024) {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { const e = new Error('Send application/json.'); e.status = 415; throw e; }
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > maxBytes) { const e = new Error('Request is too large.'); e.status = 413; throw e; } chunks.push(chunk); }
    if (closePromise) { const error = new Error('Relay is shutting down. Try again after it reopens.'); error.status = 503; throw error; }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid JSON request.'); }
  }
  async function promptBody(req, keys) {
    const value = await body(req);
    if (maintenanceRequested) throw Object.assign(new Error('Relay is closing for maintenance. Try again after it reopens.'), { status: 503 });
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Object.assign(new Error('Choose prompt fields from the supported request format.'), { status: 400 });
    return value;
  }
  async function emailBody(req, keys) {
    const value = await body(req, 300000);
    if (maintenanceRequested || closePromise) throw Object.assign(new Error('BLACKICE is closing for maintenance.'), { status: 503 });
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key))) throw Object.assign(new Error('Use only the supported email fields.'), { status: 400 });
    return value;
  }
  async function emailOperation(operation) {
    if (maintenanceRequested || closePromise) throw Object.assign(new Error('BLACKICE is closing for maintenance.'), { status: 503 });
    const pending = Promise.resolve().then(operation); fileMutations.add(pending);
    try { const value = await pending; sendEvent({type:'email.updated',data:email.status(),at:new Date().toISOString()}); return value; }
    finally { fileMutations.delete(pending); }
  }
  remoteAgentApi = new RemoteAgentAPI({ engine, tasks, conversations, planningOrganization, runtime, defaultCwd, version: APP_VERSION, recoverClientRequest, onEvent: sendEvent, isClosing: () => Boolean(closePromise || maintenanceRequested) });
  const connectorChanged = () => sendEvent({ type: 'chatgpt-connector.updated', data: connectorPresence(), at: new Date().toISOString() });
  const chatGPTOAuth = options.chatGPTOAuth || await new ChatGPTOAuth({ dataDir: path.resolve(dataDir) }).init();
  const connectorClosing = () => Boolean(closePromise || maintenanceRequested);
  browserImport = options.browserImport || new BrowserImportBridge({ isClosing: connectorClosing });
  const credentialPresence = () => ({ available: true, localManagement: true });
  const credentialsChanged = () => {
    sendEvent({ type: 'browser-credentials.updated', data: credentialPresence(), at: new Date().toISOString() });
    if (browserCredentialMirror && !connectorClosing()) {
      const pending = Promise.resolve().then(() => browserCredentialMirror.reconcile());
      fileMutations.add(pending);
      pending.catch(() => {}).finally(() => fileMutations.delete(pending));
    }
  };
  browserCredentials = options.browserCredentials || await new BrowserCredentialVault({ dataDir: path.resolve(dataDir), ...options.credentialStorage, isClosing: connectorClosing, onChange: credentialsChanged }).init();
  browserCredentialDestinations = options.browserCredentialDestinations || new BrowserCredentialDestination({ isClosing: connectorClosing });
  browserCredentialMirror = options.browserCredentialMirror || await new BrowserCredentialMirror({ dataDir: path.resolve(dataDir), vault: browserCredentials, ...options.credentialStorage, isClosing: connectorClosing,
    protectTemporaryDirectory: options.protectCredentialTemporaryDirectory,
    beginImport: async ({ destination, filePath, signal }) => {
      const receipt = await browserCredentialDestinations.open(destination, { source: 'user', signal });
      credentialCheck(signal);
      if (connectorClosing()) throw credentialError('The browser import handoff is closing.', 'CREDENTIAL_CLOSED', 503);
      await options.revealCredentialImportFile?.(filePath);
      return receipt;
    },
    onChange: () => sendEvent({ type: 'browser-credentials.updated', data: credentialPresence(), at: new Date().toISOString() }),
  }).init();
  engine.credentials = browserCredentials;
  const emailClient = options.emailClient || new EmailClientBridge({ isClosing: connectorClosing });
  directExecution = options.directExecution || await new DirectExecutionAPI({
    dataDir: path.resolve(dataDir), allowedRoot: defaultCwd, browser, patchStore: engine.filePatches,
    isClosing: connectorClosing, onChange: connectorChanged,
    ...(options.desktopRestart ? { restartStatus: context => options.desktopRestart.status({ ownerId: context.canRestart ? context.ownerId : undefined }) } : {}),
    additionalTools: [chatGPTFileImportTool({ directory: path.join(defaultCwd, 'blackice-imports') }), ...(options.desktopRestart ? [desktopRestartTool({ restart: options.desktopRestart, getJob: id => directExecution.jobs.get(id) })] : []), ...((await browserCredentials.status()).available ? createDirectBrowserCredentialTools({ vault: browserCredentials, browser, reauthorize: (client, { scopes }) => directExecution.require(client, scopes) }) : [])],
    authorizeClient: async (client, { requiredScopes }) => {
      const current = await chatGPTOAuth.getClient(client.id);
      return Boolean(chatGPTConnector?.enabled && current && requiredScopes.every(scope => current.scopes.includes(scope)));
    },
  }).init();
  const chatGPTPlanning = new ChatGPTPlanningAPI({ tasks, conversations, engine, planningOrganization, projects, onUpdated: sendEvent, isClosing: connectorClosing });
  chatGPTConnector = await new ChatGPTConnector({ dataDir: path.resolve(dataDir), execution: directExecution, planning: chatGPTPlanning, oauth: chatGPTOAuth, version: APP_VERSION, isClosing: connectorClosing, onChange: connectorChanged }).init();
  const connectorRevocations = new Map();
  chatGPTOAuth.on?.('updated', connectorChanged);
  chatGPTOAuth.on?.('revoked', ids => {
    for (const id of (Array.isArray(ids) ? ids : [ids])) {
      const pending = connectorRevocations.get(id) || directExecution.revokeClient(id);
      connectorRevocations.set(id, pending); fileMutations.add(pending);
      pending.catch(error => diagnostics.recordError('chatgpt-connector', 'revocation_cleanup_failed', error)).finally(() => { fileMutations.delete(pending); if (connectorRevocations.get(id) === pending) connectorRevocations.delete(id); });
    }
  });
  remoteAccess?.attachConnector?.(chatGPTConnector);
  const connectorSetup = options.chatGPTSetup || await new ChatGPTSetup({ dataDir: path.resolve(dataDir), connector: chatGPTConnector, remoteAccess, isClosing: connectorClosing }).init();
  chatGPTConnector.onAuthenticatedToolCall = receipt => Promise.resolve().then(() => connectorSetup.record?.(receipt)).catch(error => diagnostics.recordError('chatgpt-connector', 'setup_receipt_failed', error));
  let connectorOpening = null, connectorPreparing = null;
  const connectorStartupSnapshot = async () => {
    const unavailable = { available: false, ready: false, canEnable: false, busy: Boolean(connectorStartupEnabling), checks: [{ key: 'startup', label: 'Automatic startup', ok: false, detail: 'Open BLACKICE desktop on Windows to check automatic startup.' }] };
    if (typeof options.connectionStartup?.snapshot !== 'function') return unavailable;
    try {
      const value = await options.connectionStartup.snapshot();
      return { ...value, busy: Boolean(connectorStartupEnabling || value.busy), canEnable: value.canEnable === true && typeof options.connectionStartup.enable === 'function' };
    } catch { return { ...unavailable, checks: [{ key: 'startup', label: 'Automatic startup', ok: false, detail: 'Startup settings could not be verified. Check status again in BLACKICE on this computer.' }] }; }
  };
  const connectorSnapshot = async () => ({ ...await chatGPTConnector.status(), localManagement: true, canOpenChatGPT: typeof options.openExternal === 'function',
    remoteAccess: { enabled: Boolean(remoteAccess?.status().enabled), state: remoteAccess?.status().state || 'unavailable', mode: remoteAccess?.status().mode || null },
    pending: await directExecution.pendingInteractions(), setup: await connectorSetup.snapshot(), startup: await connectorStartupSnapshot(), discoveryRequests: remoteAccess?.connectorDiscovery?.() || [] });
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
    const host = req.headers.host || '';
    const hosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
    if (!hosts.includes(host)) return json(res, 403, { error: 'Invalid local host.' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return json(res, 403, { error: 'Cross-origin access is not allowed.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site access is not allowed.' });
    let pathname;
    try { pathname = new URL(req.url, `http://${host}`).pathname; }
    catch { return json(res, 400, { error: 'Invalid request URL.' }); }
    if (isRemoteAgentPath(pathname)) {
      const client = remoteAccess?.authorizeForward?.(req);
      if (!client) { res.setHeader('WWW-Authenticate', 'Bearer realm="BLACKICE"'); return json(res, 401, { error: 'Connect through the configured remote endpoint with a valid agent credential or paired browser.', code: 'REMOTE_AUTH_REQUIRED' }); }
      const pending = Promise.resolve().then(() => remoteAgentApi.handle(req, res, client));
      if (req.method === 'POST') fileMutations.add(pending);
      try { return await pending; }
      catch (error) { if (!res.headersSent) return json(res, error.status || 500, { error: error.message || 'The remote request could not be completed.' }); res.destroy(); }
      finally { fileMutations.delete(pending); }
    }
    if (req.method === 'GET' && pathname === '/health') return json(res, 200, { app: 'relay-agent-harness', ok: true });
    const cookieName = `relay_session_${boundPort}`;
    const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (pathname.startsWith('/api/') && !safeEqual(cookie, session)) return json(res, 401, { error: 'Open Relay in this browser before using its API.' });
    if ((closePromise||maintenanceRequested) && pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) return json(res, 503, { error: 'Relay is closing for maintenance. Try again after it reopens.' });
    try {
      const observeMatch=pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/observe$/);
      if(observeMatch&&req.method==='GET'){
        const run=engine.getRun(observeMatch[1]);
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.write(': observe\n\n');
        if(!['queued','running','waiting'].includes(run.status)){res.write(`data: ${JSON.stringify({type:'observe.stopped',runId:run.id,data:{reason:'This task is finished. Choose a running task to watch live.'}})}\n\n`);return res.end();}
        let group=observers.get(run.id);
        if(!group){group={clients:new Set(),controller:new AbortController(),starting:null};observers.set(run.id,group);group.starting=liveEdits.start(run.id,{cwd:run.cwd,signal:group.controller.signal});}
        group.clients.add(res);
        const heartbeat=setInterval(()=>writeObserver(run.id,res,': observe heartbeat\n\n'),15000);heartbeat.unref();
        res.once('close',()=>{clearInterval(heartbeat);releaseObserver(run.id,res,group);});
        try{const snapshot=await group.starting;if(!res.destroyed&&!group.controller.signal.aborted)writeObserver(run.id,res,`data: ${JSON.stringify({type:'observe.ready',runId:run.id,data:{runId:run.id,sequence:snapshot.sequence,cwd:snapshot.cwd,coverage:snapshot.coverage,presentation:engine.getRun(run.id).observePresentation}})}\n\n`);}catch(error){if(!res.destroyed){if(writeObserver(run.id,res,`data: ${JSON.stringify({type:'observe.error',runId:run.id,data:{error:error.message}})}\n\n`))res.end();}}return;
      }
      const hookMatch=pathname.match(/^\/hooks\/([a-zA-Z0-9_-]+)$/);
      if(hookMatch&&req.method==='POST'){
        if(closePromise||maintenanceRequested)return json(res,503,{error:'Relay is closing for maintenance.'});
        const token=String(req.headers.authorization||'').replace(/^Bearer /i,'');
        if(!operations.verifyWebhook(hookMatch[1],token))return json(res,403,{error:'Webhook unavailable or token invalid.'});
        const payload=await body(req,65536),key=req.headers['idempotency-key'];
        return json(res,202,await operations.trigger(hookMatch[1],{source:'webhook',idempotencyKey:key,payload}));
      }
      if(pathname==='/api/conversations/search'&&req.method==='GET'){
        const params=new URL(req.url,'http://'+host).searchParams,options={};
        if([...params.keys()].some(key=>!['q','state','limit','offset'].includes(key)||params.getAll(key).length!==1))throw Object.assign(Error('Use the supported conversation search fields once each.'),{status:400});
        for(const key of ['q','state'])if(params.has(key))options[key]=params.get(key);
        for(const key of ['limit','offset'])if(params.has(key))options[key]=/^\d+$/.test(params.get(key))?Number(params.get(key)):NaN;
        return json(res,200,conversations.search(options));
      }
      if(pathname==='/api/conversations'&&req.method==='GET')return json(res,200,{conversations:conversations.list(new URL(req.url,'http://'+host).searchParams.get('state')||'active')});
      if (pathname === '/api/planning' && req.method === 'GET') {
        return json(res, 200, await listPlanningWorkspace({ tasks, conversations, engine, planningOrganization }, planningQuery(new URL(req.url, 'http://' + host).searchParams)));
      }
      if (pathname === '/api/planning/organization' && req.method === 'GET') {
        const value = await readPlanningOrganization({ planningOrganization });
        return json(res, value.healthy ? 200 : 503, value);
      }
      if (pathname === '/api/planning/organization' && req.method === 'POST') {
        const value = await body(req, 128 * 1024);
        if (closePromise || maintenanceRequested) return json(res, 503, { error: 'Relay is closing for maintenance. Try again after it reopens.' });
        const client = remoteAccess?.authorizeForward?.(req);
        const actor = client?.kind === 'browser' ? { type: 'human-client', id: client.id, name: client.label } : undefined;
        const pending = editPlanningOrganization({ planningOrganization, tasks, conversations, engine, projects, onUpdated: sendEvent, actor }, value);
        fileMutations.add(pending);
        try { return json(res, 200, await pending); }
        catch (error) { return json(res, error.status || 400, { error: error.message, ...(typeof error.code === 'string' ? { code: error.code } : {}), ...(Number.isSafeInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {}) }); }
        finally { fileMutations.delete(pending); }
      }
      const planningAwareness = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/plan\/(awareness|presence)$/);
      if (planningAwareness && req.method === 'GET' && planningAwareness[2] === 'awareness') {
        return json(res, 200, await readPlanningAwareness({ tasks, conversations, engine }, planningAwareness[1]));
      }
      if (planningAwareness && ['POST', 'DELETE'].includes(req.method) && planningAwareness[2] === 'presence') {
        const value = await body(req, 4096);
        const client = remoteAccess?.authorizeForward?.(req);
        const actor = client?.kind === 'browser' ? { type: 'human-client', id: client.id, name: client.label } : undefined;
        const pending = updatePlanningPresence({ tasks, conversations, engine }, planningAwareness[1], value, { actor, release: req.method === 'DELETE' });
        fileMutations.add(pending);
        try { return json(res, 200, await pending); }
        finally { fileMutations.delete(pending); }
      }
      const planningEdit = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/plan\/edit$/);
      if (planningEdit && req.method === 'POST') {
        const value = await body(req, 128 * 1024);
        const client = remoteAccess?.authorizeForward?.(req);
        const actor = client?.kind === 'browser' ? { type: 'human-client', id: client.id, name: client.label } : undefined;
        const pending = editPlanningWorkspace({ tasks, conversations, engine, onUpdated: sendEvent, actor }, planningEdit[1], value);
        fileMutations.add(pending);
        try { return json(res, 200, await pending); }
        catch (error) { return json(res, error.status || 400, { error: error.message, ...(typeof error.code === 'string' ? { code: error.code } : {}), ...(Number.isSafeInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {}) }); }
        finally { fileMutations.delete(pending); }
      }
      const renameMatch=pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/rename$/);
      if(renameMatch&&req.method==='POST'){const value=await body(req);return json(res,200,await conversations.rename(renameMatch[1],value.title));}
      const conversationAction=pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/(archive|restore|delete)$/);
      if(conversationAction&&req.method==='POST'){await body(req);const state=conversationAction[2]==='archive'?'archived':conversationAction[2]==='delete'?'deleted':'active';return json(res,200,{...await conversations.setState(conversationAction[1],state),conversations:conversations.list(state)});}
      const conversationMatch=pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)$/);
      if(conversationMatch&&req.method==='GET')return json(res,200,await conversations.family(conversationMatch[1]));
      if(pathname==='/api/methods'&&req.method==='GET'){
        const params=new URL(req.url,'http://'+host).searchParams;
        if(params.get('compact')!=='true')return json(res,200,methods.snapshot());
        const options={};for(const key of ['query','domain','phase','output','effort','evidence','catalogRevision'])if(params.has(key))options[key]=params.get(key);
        for(const key of ['limit','offset'])if(params.has(key))options[key]=/^\d+$/.test(params.get(key))?Number(params.get(key)):NaN;
        return json(res,200,{...methods.search(options),ontology:methods.ontology()});
      }
      if(pathname==='/api/methods'&&req.method==='POST')return json(res,201,await methods.create(await body(req)));
      const methodMatch=pathname.match(/^\/api\/methods\/([a-zA-Z0-9_-]+)(?:\/(preview|use))?$/);
      if(methodMatch){const id=methodMatch[1],action=methodMatch[2];
        if(req.method==='GET'&&!action)return json(res,200,methods.get(id));
        if(req.method==='PUT'&&!action)return json(res,200,await methods.update(id,await body(req)));
        if(req.method==='POST'&&action){const value=await body(req);return json(res,action==='use'?201:200,action==='use'?await methods.use(id,value):methods.preview(id,value));}
      }
      if(pathname==='/api/method-types'&&req.method==='POST')return json(res,201,await methods.createType(await body(req)));
      const methodTypeMatch=pathname.match(/^\/api\/method-types\/([a-zA-Z0-9_-]+)$/);
      if(methodTypeMatch&&req.method==='PUT')return json(res,200,await methods.updateType(methodTypeMatch[1],await body(req)));
      if(pathname==='/api/codex/models/check'&&req.method==='POST'){
        const value=await body(req);
        if(!value||Array.isArray(value)||Object.keys(value).length!==1||typeof value.model!=='string')return json(res,400,{error:'Supply one exact model ID as {model}.'});
        if(typeof runtime.checkCodexModel!=='function')return json(res,503,{error:'Native Codex model checks are unavailable in this runtime.',code:'CODEX_MODEL_CHECK_UNAVAILABLE'});
        // A caller can detach without replaying or cancelling another caller's
        // coalesced check. The owned native operation has its own 45s deadline.
        const result=await runtime.checkCodexModel(value.model);runtimeUpdate();return json(res,200,result);
      }
      if(pathname==='/api/codex/models'&&['GET','POST','DELETE'].includes(req.method)){
        if(typeof runtime.codexModelCatalog!=='function')return json(res,503,{error:'The native Codex model catalog is unavailable in this runtime.'});
        if(req.method==='GET')return json(res,200,runtime.codexModelCatalog());
        const value=await body(req);
        if(!value||Array.isArray(value)||Object.keys(value).length!==1||typeof value.model!=='string')return json(res,400,{error:'Supply one exact model ID as {model}.'});
        const result=req.method==='POST'?await runtime.addCodexModel(value.model):await runtime.removeCodexModel(value.model);
        runtimeUpdate();return json(res,200,result);
      }
      if(pathname==='/api/projects'&&req.method==='GET')return json(res,200,await projectPlanningWorkspace({projects,planningOrganization}));
      if(pathname==='/api/projects'&&req.method==='POST')return json(res,201,await projectPlanningWorkspace({projects,planningOrganization},await projects.create(await body(req))));
      const projectMatch=pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)(?:\/(start|pause|retry-task|review-task))?$/);
      if(projectMatch){const id=projectMatch[1],action=projectMatch[2];
        if(req.method==='GET'&&!action)return json(res,200,await projectPlanningWorkspace({projects,planningOrganization},projects.get(id)));
        if(req.method==='PUT'&&!action)return json(res,200,await projectPlanningWorkspace({projects,planningOrganization},await projects.update(id,await body(req))));
        if(req.method==='POST'&&action){const value=await body(req);return json(res,200,await projectPlanningWorkspace({projects,planningOrganization},action==='start'?await projects.start(id):action==='pause'?await projects.pause(id,value.reason):action==='review-task'?await projects.reviewTask(id,value.taskId):await projects.retryTask(id,value.taskId)));}
      }
      if(pathname==='/api/capabilities'&&req.method==='GET')return json(res,200,{status:capabilities.status(),capabilities:capabilities.list()});
      if(pathname==='/api/capabilities'&&req.method==='POST')return json(res,201,await capabilities.save(await body(req)));
      const capabilityMatch=pathname.match(/^\/api\/capabilities\/([a-zA-Z0-9_-]+)\/use$/);
      if(capabilityMatch&&req.method==='POST')return json(res,201,await capabilities.use(capabilityMatch[1],await body(req)));
      if(pathname==='/api/operations'&&req.method==='GET')return json(res,200,operations.snapshot());
      if(pathname==='/api/operations/schedule-preview'&&req.method==='POST')return json(res,200,operations.previewSchedule(await body(req)));
      if(pathname==='/api/operations/pause'&&req.method==='POST'){const value=await body(req);return json(res,200,await operations.pause(value.reason||'Paused by you.'));}
      if(pathname==='/api/operations/resume'&&req.method==='POST')return json(res,200,await operations.resume(await body(req)));
      if(pathname==='/api/operations/deployments'&&req.method==='POST'){const value=await body(req);attachments.validateIds(value.attachmentIds||[]);if(typeof value.cwd!=='string'||!(await fs.stat(value.cwd)).isDirectory())throw new Error('Choose an existing working folder.');return json(res,201,await operations.create(value));}
      const deploymentMatch=pathname.match(/^\/api\/operations\/deployments\/([a-zA-Z0-9_-]+)(?:\/(trigger|webhook|rotate))?$/);
      if(deploymentMatch){const id=deploymentMatch[1],action=deploymentMatch[2];
        if(req.method==='GET'&&action==='webhook')return json(res,200,{...operations.getWebhook(id),url:'http://127.0.0.1:'+boundPort+'/hooks/'+id});
        if(req.method==='POST'&&action==='trigger'){const value=await body(req);return json(res,202,await operations.trigger(id,{source:'manual',payload:value.payload,idempotencyKey:value.idempotencyKey}));}
        if(req.method==='POST'&&action==='rotate'){await body(req);return json(res,200,await operations.rotateWebhook(id));}
        if(req.method==='PUT'&&!action){const value=await body(req);if(value.attachmentIds)attachments.validateIds(value.attachmentIds);if(value.cwd!==undefined&&(typeof value.cwd!=='string'||!(await fs.stat(value.cwd)).isDirectory()))throw new Error('Choose an existing working folder.');return json(res,200,await operations.update(id,value));}
        if(req.method==='DELETE'&&!action){await body(req);return json(res,200,await operations.remove(id));}
      }
      const jobMatch=pathname.match(/^\/api\/operations\/jobs\/([a-zA-Z0-9_-]+)(?:\/(retry))?$/);
      if(jobMatch&&req.method==='GET')return json(res,200,operations.getJob(jobMatch[1]));
      if(jobMatch&&req.method==='POST'&&jobMatch[2]){await body(req);return json(res,201,await operations.retryJob(jobMatch[1]));}
      if (pathname === '/api/status' && req.method === 'GET') {
        if (options.signedBrowser === true) await browserImport.status();
        const remote = req.headers['x-blackice-remote'] === '1';
        return json(res, 200, { ...status(req), remoteAccess: { ...(remoteAccess?.status() || { available: false, enabled: false }), client: remote ? 'remote' : 'local', localManagement: !remote }, desktopLifecycle: { ...(options.desktopLifecycle?.status?.() || { available: false }), localManagement: !remote } });
      }
      if (pathname === '/api/chat-mode' || pathname.startsWith('/api/chat-mode/')) return json(res, 410, { error: CHAT_MODE_RETIRED_MESSAGE, code: 'CHAT_MODE_RETIRED' });
      if (pathname === '/api/chatgpt-connector' || pathname.startsWith('/api/chatgpt-connector/')) {
        if (req.headers['x-blackice-remote'] === '1') return json(res, 403, { error: 'Review ChatGPT connector access and actions in BLACKICE on this computer.' });
        if (pathname === '/api/chatgpt-connector' && req.method === 'GET') return json(res, 200, await connectorSnapshot());
        const action = pathname.slice('/api/chatgpt-connector/'.length);
        if (req.method !== 'POST' || !['enable', 'disable', 'approve-access', 'reject-access', 'revoke', 'reject-action', 'resolve-action', 'cancel-action', 'open-chatgpt', 'prepare', 'check-connection', 'confirm-connection', 'enable-startup'].includes(action)) return json(res, 404, { error: 'Unknown connector management action.' });
        if (['open-chatgpt', 'prepare', 'check-connection', 'confirm-connection', 'enable-startup'].includes(action) && req.url.includes('?')) return json(res, 400, { error: 'Connection setup does not accept URL parameters.' });
        const value = await body(req, 8192);
        if (maintenanceRequested || closePromise) return json(res, 503, { error: 'BLACKICE is closing for maintenance.' });
        const keys = action === 'prepare' ? ['confirmPublic'] : action === 'confirm-connection' ? ['nonce'] : action === 'approve-access' ? ['id', 'scopes'] : ['reject-access', 'revoke', 'cancel-action'].includes(action) ? ['id'] : ['reject-action', 'resolve-action'].includes(action) ? ['id', 'interactionId'] : [];
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.includes('id') && (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.id)) || keys.includes('interactionId') && (typeof value.interactionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value.interactionId)) || action === 'approve-access' && (!Array.isArray(value.scopes) || value.scopes.some(scope => typeof scope !== 'string'))) return json(res, 400, { error: 'Use the exact pending request and permissions shown in BLACKICE.' });
        if (action === 'prepare' && typeof value.confirmPublic !== 'boolean' || action === 'confirm-connection' && (typeof value.nonce !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value.nonce))) return json(res, 400, { error: 'Use the confirmation fields shown in connection setup.' });
        if (action === 'enable-startup') {
          if (typeof options.connectionStartup?.enable !== 'function') return json(res, 409, { error: 'Automatic startup setup is available in BLACKICE desktop on Windows.' });
          if (!connectorStartupEnabling) {
            const pending = Promise.resolve().then(async () => {
              if (connectorClosing()) throw Object.assign(new Error('BLACKICE is closing for maintenance.'), { status: 503 });
              await options.connectionStartup.enable();
            });
            connectorStartupEnabling = pending; fileMutations.add(pending);
            const settled = () => { if (connectorStartupEnabling === pending) connectorStartupEnabling = null; fileMutations.delete(pending); };
            pending.then(settled, settled);
          }
          await connectorStartupEnabling;
          return json(res, 200, await connectorSnapshot());
        }
        if (action === 'prepare') {
          if (!remoteAccess) return json(res, 503, { error: 'Public HTTPS is unavailable in this runtime.' });
          if (connectorPreparing && connectorPreparing.confirmPublic !== value.confirmPublic) return json(res, 409, { error: 'Connection preparation is already in progress. Wait for its result before changing the publication choice.' });
          if (!connectorPreparing) {
            const confirmPublic = value.confirmPublic;
            const pending = Promise.resolve().then(async () => {
              const requireOpen = () => { if (connectorClosing()) throw Object.assign(new Error('BLACKICE is closing for maintenance.'), { status: 503 }); };
              requireOpen();
              await remoteAccess.refresh(); requireOpen();
              let remote = remoteAccess.status();
              if (!remote.enabled || remote.mode !== 'public' || remote.state !== 'ready') {
                if (!confirmPublic) throw Object.assign(new Error('Confirm public HTTPS publication before preparing this connection.'), { status: 409 });
                await remoteAccess.enable({ mode: 'public', confirmPublic: true });
                requireOpen(); remote = remoteAccess.status();
              }
              let owned = false;
              try { const origin = new URL(remote.url); owned = origin.protocol === 'https:' && origin.origin === remote.url && !origin.username && !origin.password && chatGPTConnector.origin === remote.url; } catch {}
              if (!remote.enabled || remote.mode !== 'public' || remote.state !== 'ready' || !owned) throw Object.assign(new Error('The owned public HTTPS route is not ready. Check Remote access, then prepare again.'), { status: 409 });
              requireOpen();
              if (!chatGPTConnector.enabled) await chatGPTConnector.setEnabled(true);
              requireOpen(); return connectorSnapshot();
            });
            connectorPreparing = { confirmPublic, pending }; fileMutations.add(pending);
            const settled = () => { if (connectorPreparing?.pending === pending) connectorPreparing = null; fileMutations.delete(pending); };
            pending.then(settled, settled);
          }
          return json(res, 200, await connectorPreparing.pending);
        }
        if (action === 'check-connection' || action === 'confirm-connection') {
          const pending = Promise.resolve().then(async () => {
            if (connectorClosing()) throw Object.assign(new Error('BLACKICE is closing for maintenance.'), { status: 503 });
            if (action === 'check-connection') await connectorSetup.check(); else await connectorSetup.confirm(value.nonce);
            return connectorSnapshot();
          });
          fileMutations.add(pending);
          try { return json(res, 200, await pending); } finally { fileMutations.delete(pending); }
        }
        if (action === 'open-chatgpt') {
          if (typeof options.openExternal !== 'function') return json(res, 409, { error: 'Open the BLACKICE plugin in your normal browser; this host cannot launch it.' });
          if (!connectorOpening) {
            const pending = Promise.resolve().then(async () => {
              if (maintenanceRequested || closePromise) throw Object.assign(new Error('BLACKICE is closing for maintenance.'), { status: 503 });
              const setup = await connectorSetup.snapshot();
              if (setup.ready !== true) throw Object.assign(new Error('Prepare the BLACKICE connection before opening setup in ChatGPT.'), { status: 409 });
              if (connectorClosing()) throw Object.assign(new Error('BLACKICE is closing for maintenance.'), { status: 503 });
              try { await options.openExternal(CHATGPT_SETUP_URL); }
              catch { throw Object.assign(new Error('The normal browser could not be opened. Try again from BLACKICE.'), { status: 503 }); }
              return { requested: true, connectionVerified: false };
            });
            connectorOpening = pending; fileMutations.add(pending);
            const settled = () => { if (connectorOpening === pending) connectorOpening = null; fileMutations.delete(pending); };
            pending.then(settled, settled);
          }
          return json(res, 200, await connectorOpening);
        }
        if (action === 'enable' && (!remoteAccess?.status().enabled || remoteAccess?.status().mode !== 'public' || !chatGPTConnector.origin)) return json(res, 409, { error: 'Enable the authenticated public HTTPS route under Remote access before connecting ChatGPT. Private tailnet addresses cannot be reached by the ChatGPT service.' });
        const pending = Promise.resolve().then(async () => {
          if (maintenanceRequested || closePromise) throw Object.assign(new Error('BLACKICE is closing for maintenance.'), { status: 503 });
          if (action === 'enable' || action === 'disable') await chatGPTConnector.setEnabled(action === 'enable');
          else if (action === 'approve-access') await chatGPTOAuth.approve(value.id, { scopes: value.scopes });
          else if (action === 'reject-access') await chatGPTOAuth.reject(value.id);
          else if (action === 'revoke') { await chatGPTOAuth.revoke(value.id); await connectorRevocations.get(value.id); }
          else if (action === 'cancel-action') await directExecution.cancel(value.id);
          else await directExecution[action === 'reject-action' ? 'reject' : 'resolveInteraction'](value.id, value.interactionId);
          return connectorSnapshot();
        });
        fileMutations.add(pending);
        try { return json(res, 200, await pending); } finally { fileMutations.delete(pending); }
      }
      if (pathname === '/api/remote-access' && req.method === 'GET') return json(res, 200, { ...(remoteAccess?.status() || { available: false, enabled: false }), client: 'local', localManagement: req.headers['x-blackice-remote'] !== '1' });
      const remoteAction = pathname.match(/^\/api\/remote-access\/(refresh|enable|disable|pair|revoke|create-agent)$/);
      if (remoteAction && req.method === 'POST') {
        if (req.headers['x-blackice-remote'] === '1') return json(res, 403, { error: 'Manage remote access from BLACKICE on this computer.' });
        if (!remoteAccess) return json(res, 503, { error: 'Remote access is unavailable in this runtime.' });
        const value = await body(req, 4096), action = remoteAction[1];
        const keys = action === 'enable' ? ['mode', 'confirmPublic'] : action === 'create-agent' ? ['label', 'scopes'] : action === 'pair' ? ['kind', 'scopes'] : action === 'revoke' ? ['id'] : [];
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || action === 'revoke' && (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id))) return json(res, 400, { error: 'Use the fields shown in the remote-access action.' });
        const method = action === 'create-agent' ? 'createAgent' : action;
        const pending = Promise.resolve().then(() => remoteAccess[method](...(action === 'revoke' ? [value.id] : ['enable', 'create-agent', 'pair'].includes(action) ? [value] : [])));
        fileMutations.add(pending);
        try { return json(res, 200, await pending); }
        finally { fileMutations.delete(pending); }
      }
      const desktopAction = pathname.match(/^\/api\/desktop\/(background|show)$/);
      if (desktopAction && req.method === 'POST') {
        if (req.headers['x-blackice-remote'] === '1') return json(res, 403, { error: 'Change the desktop window from this computer.' });
        const value = await body(req, 4096);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) return json(res, 400, { error: 'Send an empty desktop action.' });
        if (typeof options.desktopLifecycle?.[desktopAction[1]] !== 'function') return json(res, 503, { error: 'This runtime has no BLACKICE desktop window.' });
        const result = await options.desktopLifecycle[desktopAction[1]]();
        sendEvent({ type: 'desktop.lifecycle', data: options.desktopLifecycle.status(), at: new Date().toISOString() });
        return json(res, 200, result);
      }
      if (pathname.startsWith('/api/browser-credentials')) {
        if (req.headers['x-blackice-remote'] === '1') return json(res, 403, { error: 'Manage saved passwords from BLACKICE on this computer.' });
        if (new URL(req.url, `http://${host}`).search) return json(res, 400, { error: 'Password-manager actions do not accept URL parameters.' });
        if (pathname === '/api/browser-credentials' && req.method === 'GET') {
          return json(res, 200, { vault: await browserCredentials.status(), mirror: await browserCredentialMirror.status(), destinations: await browserCredentialDestinations.status(), localManagement: true });
        }
        const credentialActions = {
          '/api/browser-credentials/save': [browserCredentials, 'save', ['origin', 'username', 'password', 'label', 'credentialId', 'revision', 'requestId']],
          '/api/browser-credentials/delete': [browserCredentials, 'delete', ['credentialId', 'revision', 'requestId']],
          '/api/browser-credentials/import': [browserCredentials, 'importCSV', ['csv', 'requestId']],
          '/api/browser-credentials/mirror/configure': [browserCredentialMirror, 'configure', ['enabled', 'destination']],
          '/api/browser-credentials/mirror/queue': [browserCredentialMirror, 'queue', ['credentials', 'destination', 'requestId']],
          '/api/browser-credentials/mirror/begin': [browserCredentialMirror, 'beginImport', ['ids', 'requestId']],
          '/api/browser-credentials/mirror/confirm': [browserCredentialMirror, 'confirm', ['batchId']],
          '/api/browser-credentials/mirror/cancel': [browserCredentialMirror, 'cancel', ['batchId']],
        };
        const operation = credentialActions[pathname];
        if (!operation || req.method !== 'POST') return json(res, 404, { error: 'Choose a supported password-manager action.' });
        const value = await body(req, pathname.endsWith('/import') ? 512000 : 32768);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => ![...operation[2], 'expectedRevision'].includes(key))) return json(res, 400, { error: 'Use only the fields shown in the password manager.' });
        const { expectedRevision, ...args } = value;
        const pending = Promise.resolve().then(() => {
          if (connectorClosing()) throw Object.assign(new Error('BLACKICE is closing.'), { status: 503 });
          return operation[0][operation[1]](args, { source: 'user', expectedRevision, signal: AbortSignal.timeout(20000) });
        });
        fileMutations.add(pending);
        try { return json(res, 200, await pending); } finally { fileMutations.delete(pending); }
      }
      if (pathname === '/api/email' && req.method === 'GET') return json(res,200,emailSnapshot(req));
      if (pathname === '/api/email/client' && req.method === 'GET') return json(res, 200, { ...await emailClient.status(), localManagement: req.headers['x-blackice-remote'] !== '1' });
      if (pathname === '/api/email/client/open' && req.method === 'POST') {
        if (req.headers['x-blackice-remote'] === '1') return json(res, 403, { error: 'Open Thunderbird from BLACKICE on this computer.' });
        const value = await emailBody(req, ['action']);
        if (!['open', 'compose'].includes(value.action)) return json(res, 400, { error: 'Choose Open Thunderbird or New message.' });
        return json(res, 200, await emailOperation(() => {
          if (connectorClosing()) throw Object.assign(new Error('BLACKICE is closing for maintenance.'), { status: 503 });
          return emailClient.open(value, { signal: AbortSignal.timeout(10000) });
        }));
      }
      if (pathname === '/api/email/oauth/status' && req.method === 'GET') return json(res, 200, { ...emailOAuth.status(), localManagement: req.headers['x-blackice-remote'] !== '1' });
      if (pathname === '/api/email/oauth/config' && req.method === 'PUT') {
        if (req.headers['x-blackice-remote'] === '1') return json(res, 403, { error: 'Manage email sign-in from BLACKICE on this computer.' });
        const value = await emailBody(req, ['config', 'expectedRevision']);
        if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) return json(res, 400, { error: 'Read the current email registration before saving.', code: 'EMAIL_REVISION_REQUIRED' });
        return json(res, 200, await emailOperation(() => emailOAuth.configure(value.config, { expectedRevision: value.expectedRevision })));
      }
      const emailOAuthAction = pathname.match(/^\/api\/email\/oauth\/(begin|cancel|disconnect)$/);
      if (emailOAuthAction && req.method === 'POST') {
        if (req.headers['x-blackice-remote'] === '1') return json(res, 403, { error: 'Manage email sign-in from BLACKICE on this computer.' });
        const action = emailOAuthAction[1], value = await emailBody(req, action === 'begin' ? ['expectedRevision'] : []);
        if (action === 'begin' && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0)) return json(res, 400, { error: 'Read the current email registration before signing in.', code: 'EMAIL_REVISION_REQUIRED' });
        return json(res, 200, await emailOperation(() => emailOAuth[action](value)));
      }
      if (pathname === '/api/email/config' && req.method === 'PUT') {
        if (req.headers['x-blackice-remote'] === '1') return json(res, 403, { error: 'Manage email setup from BLACKICE on this computer.' });
        const value = await emailBody(req,['config','expectedRevision']);
        if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) return json(res,400,{error:'Read the current email revision before saving setup.',code:'EMAIL_REVISION_REQUIRED'});
        await emailOperation(() => email.configure(value.config,{expectedRevision:value.expectedRevision}));
        return json(res,200,emailSnapshot(req));
      }
      if (pathname === '/api/email/check' && req.method === 'POST') {
        await emailBody(req,[]); await emailOperation(() => email.check({signal:AbortSignal.timeout(40000)}));
        return json(res,200,emailSnapshot(req));
      }
      if (pathname === '/api/email/action' && req.method === 'POST') {
        const value = await emailBody(req,['action','folder','query','limit','page','id']);
        if (!['mailboxes','list','read'].includes(value.action)) return json(res,400,{error:'Email supports folder discovery, message listing, search and preview. Sending is not available.',code:'EMAIL_ACTION_UNAVAILABLE'});
        const {action,...args}=value;
        return json(res,200,await emailOperation(() => email[action](args,{signal:AbortSignal.timeout(40000)})));
      }
      if (pathname === '/api/email/drafts' && req.method === 'GET') return json(res,200,{drafts:email.listDrafts()});
      if (pathname === '/api/email/drafts' && req.method === 'POST') {
        const value = await emailBody(req,['requestId','to','subject','body']);
        return json(res,201,{draft:await emailOperation(() => email.draft(value))});
      }
      const emailDraftMatch=pathname.match(/^\/api\/email\/drafts\/([a-zA-Z0-9_-]+)$/);
      if (emailDraftMatch && req.method === 'GET') return json(res,200,{draft:await email.getDraft(emailDraftMatch[1])});
      if (pathname === '/api/chatgpt-bridge' || pathname.startsWith('/api/chatgpt-bridge/')) return json(res,410,{error:'The ChatGPT Bridge is not offered because end-to-end operation has not been verified.',code:'FEATURE_NOT_OFFERED'});
      if (pathname === '/api/browseros/show' && req.method === 'POST') {
        const value=await body(req);
        if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length)throw Object.assign(new Error('This action takes no arguments; it only opens the existing browser window.'),{status:400});
        return json(res,200,await showBrowserOS());
      }
      if (pathname === '/api/diagnostics/export' && req.method === 'GET') {await diagnostics.record({component:'server',event:'support_exported'});return json(res,200,await supportSnapshot());}
      if (pathname === '/api/execution/settings' && req.method === 'GET') return json(res, 200, engine.executionSettings());
      if (pathname === '/api/execution/settings' && req.method === 'POST') return json(res, 200, await engine.updateExecutionSettings(await body(req)));
      if (pathname === '/api/attachments' && req.method === 'GET') return json(res, 200, await attachments.list());
      if (['/api/attachments/import','/api/attachments/upload'].includes(pathname) && req.method === 'POST') {
        const value = await body(req, pathname.endsWith('/upload') ? 15 * 1024 * 1024 : 1024 * 1024);
        const pending = pathname.endsWith('/import') ? attachments.importPath(value.path) : attachments.importBytes({ name: value.name, dataBase64: value.dataBase64 });
        fileMutations.add(pending); try { const result = await pending; sendEvent({ type: 'attachments.updated', data: attachments.status(), at: new Date().toISOString() }); return json(res, 201, result); } finally { fileMutations.delete(pending); }
      }
      const attachmentMatch = pathname.match(/^\/api\/attachments\/(file_[a-zA-Z0-9_-]+)$/);
      if (attachmentMatch && req.method === 'GET') return json(res, 200, await attachments.get(attachmentMatch[1]));
      if (pathname === '/api/inbox' && req.method === 'GET') return json(res, 200, inbox.snapshot({ cwd: new URL(req.url, `http://${host}`).searchParams.get('cwd') || undefined }));
      if (pathname === '/api/inbox' && req.method === 'POST') { const value = await body(req); attachments.validateIds(value.attachmentIds || []); return json(res, 201, await inbox.add(value)); }
      if (pathname === '/api/inbox/queue' && req.method === 'POST') { const value = await body(req); attachments.validateIds(value.attachmentIds || []); return json(res, 201, await inbox.queue(value)); }
      if (pathname === '/api/inbox/settings' && req.method === 'POST') return json(res, 200, await inbox.configure(await body(req)));
      if (pathname === '/api/inbox/pause' && req.method === 'POST') { const value = await body(req); return json(res, 200, await inbox.pause(value.reason || 'Paused by you.')); }
      if (pathname === '/api/inbox/resume' && req.method === 'POST') { await body(req); return json(res, 200, await inbox.resume()); }
      if (pathname === '/api/inbox/reorder' && req.method === 'POST') { const value = await body(req); return json(res, 200, await inbox.reorder(value.ids)); }
      const inboxMatch = pathname.match(/^\/api\/inbox\/([a-zA-Z0-9_-]+)(?:\/(run|retry|restore))?$/);
      if (inboxMatch && ['PUT','PATCH'].includes(req.method) && !inboxMatch[2]) { const value = await body(req); if (value.attachmentIds) attachments.validateIds(value.attachmentIds); return json(res, 200, await inbox.update(inboxMatch[1], value)); }
      if (inboxMatch && req.method === 'DELETE' && !inboxMatch[2]) { await body(req); return json(res, 200, await inbox.remove(inboxMatch[1])); }
      if (inboxMatch?.[2] && req.method === 'POST') { await body(req); return json(res, 200, inboxMatch[2] === 'run' ? await inbox.runNow(inboxMatch[1]) : inboxMatch[2] === 'retry' ? await inbox.retry(inboxMatch[1]) : await inbox.restore(inboxMatch[1])); }
      const taskMethodMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/(method-draft|method)$/);
      if (taskMethodMatch && req.method === 'POST') {
        const value = await body(req), taskId = taskMethodMatch[1], saving = taskMethodMatch[2] === 'method';
        const allowed = ['expectedRevision','name','description','catalog','methodSteps'];
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) return json(res,400,{error:'Supply the saved task expectedRevision and optional method name, description, catalog and action definitions.',code:'TASK_METHOD_INVALID'});
        const options = Object.fromEntries(['name','description','catalog','methodSteps'].filter(key => Object.hasOwn(value,key)).map(key => [key,value[key]]));
        if (saving) {
          const existing = await methods.findSavedTaskMethod(taskId,value.expectedRevision,options);
          if (existing) return json(res,200,{taskId,taskRevision:value.expectedRevision,method:existing.method,reused:true});
        }
        const taskState = await tasks.get(taskId);
        if (taskState.revision !== value.expectedRevision) return json(res,409,{error:'The task outline changed. Reopen Save as method to review its current steps.',code:'TASK_STATE_CONFLICT',revision:taskState.revision});
        if (!saving) return json(res,200,{taskId,taskRevision:taskState.revision,method:methods.draftTaskMethod(taskState,options)});
        const saved = await methods.saveTaskMethod(taskState,options);
        return json(res,saved.created?201:200,{taskId,taskRevision:taskState.revision,method:saved.method,reused:saved.created===false});
      }
      const taskMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)(?:\/(history))?$/);
      if (taskMatch && req.method === 'GET') return json(res, 200, taskMatch[2] ? await tasks.history(taskMatch[1]) : await tasks.get(taskMatch[1]));
      const artifactMatch = pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/artifacts\/(artifact_[a-f0-9-]{36})\/(preview|content)$/);
      if (artifactMatch && req.method === 'GET') {
        if (artifactMatch[3] === 'preview') { const value = await tasks.previewArtifact(artifactMatch[1], artifactMatch[2]); if (value.previewKind === 'image') return json(res, 200, { artifact: value.artifact, previewKind: 'image', imageUrl: `data:${value.contentType};base64,${value.buffer.toString('base64')}` }); return json(res, 200, value); }
        const value = await tasks.readArtifact(artifactMatch[1], artifactMatch[2], { maxBytes: 128 * 1024 * 1024 }); res.writeHead(200, { 'Content-Type': value.contentType || 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(value.fileName)}`, 'Cache-Control': 'no-store', 'Content-Length': value.buffer.length }); return res.end(value.buffer);
      }
      if (pathname === '/api/identity' && req.method === 'GET') return json(res, 200, await identity.readAll());
      const identityMatch = pathname.match(/^\/api\/identity\/(soul|user)(?:\/(versions|restore))?$/);
      if (identityMatch && req.method === 'GET' && identityMatch[2] !== 'restore') return json(res, 200, identityMatch[2] === 'versions' ? await identity.versions(identityMatch[1]) : await identity.read(identityMatch[1]));
      if (identityMatch && (req.method === 'PUT' && !identityMatch[2] || req.method === 'POST' && identityMatch[2] === 'restore')) { const value = await body(req); const result = identityMatch[2] === 'restore' ? await identity.restore({ ...value, kind: identityMatch[1], provenance: { source: 'user' } }) : await identity.update({ ...value, kind: identityMatch[1], provenance: { source: 'user' } }); sendEvent({ type: 'identity.updated', data: identity.status(), at: new Date().toISOString() }); return json(res, 200, result); }
      if (pathname === '/api/learning' && req.method === 'GET') return json(res, 200, learning.snapshot({ cwd: new URL(req.url, `http://${host}`).searchParams.get('cwd') || undefined }));
      if (pathname === '/api/learning/settings' && req.method === 'POST') return json(res, 200, await learning.updateSettings(await body(req)));
      if (pathname === '/api/learning/review' && req.method === 'POST') { const value = await body(req); return json(res, 202, await learning.learnNow(value.runId)); }
      if (pathname === '/api/learning/feedback' && req.method === 'POST') { const value = await body(req); return json(res, 200, await learning.feedback(value.runId, value.value, value.comment)); }
      const learningMatch = pathname.match(/^\/api\/learning\/(reviews|lessons)\/([a-zA-Z0-9_-]+)(?:\/(retry|restore))?$/);
      if (learningMatch && req.method === 'POST' && (learningMatch[1] === 'reviews' && learningMatch[3] === 'retry' || learningMatch[1] === 'lessons' && learningMatch[3] === 'restore')) { const value = await body(req); return json(res, 200, learningMatch[1] === 'reviews' ? await learning.retryReview(learningMatch[2]) : await learning.restoreLesson(learningMatch[2], value.revision)); }
      if (learningMatch?.[1] === 'lessons' && !learningMatch[3] && req.method === 'DELETE') { await body(req); return json(res, 200, await learning.removeLesson(learningMatch[2])); }
      if (pathname === '/api/connections' && req.method === 'GET') return json(res, 200, connections.list());
      if (pathname === '/api/connections/import' && req.method === 'POST') {
        const value = await body(req), parsed = parseConnectionImport(value.configuration, { existingIds: connections.list().map(item => item.id), maxConnections: 40 });
        if (value.apply !== true) return json(res, 200, { preview: parsed.preview, warnings: parsed.warnings });
        const imported = [];
        for (const config of parsed.candidates) {
          try { imported.push(await connections.save(config)); }
          catch (error) { return json(res, 409, { error: `${imported.length} of ${parsed.candidates.length} servers were saved. Import stopped at ${config.name}: ${connections.redact(error.message)}. Reload the server list before importing the remaining servers.`, imported }); }
        }
        return json(res, 201, { imported, warnings: parsed.warnings });
      }
      if (pathname === '/api/connections' && req.method === 'POST') return json(res, 200, await connections.save(await body(req)));
      const connectionMatch = pathname.match(/^\/api\/connections\/([a-z][a-z0-9_-]{0,39})(?:\/(connect|disconnect|tools))?$/);
      if (connectionMatch && !connectionMatch[2] && req.method === 'DELETE') { await body(req); return json(res, 200, await connections.remove(connectionMatch[1])); }
      if (connectionMatch?.[2] === 'tools' && req.method === 'GET') return json(res, 200, await connections.tools(connectionMatch[1], { query: new URL(req.url, `http://${host}`).searchParams.get('query') || '' }));
      if (['connect','disconnect'].includes(connectionMatch?.[2]) && req.method === 'POST') { const value = await body(req); if (connectionMatch[2] === 'disconnect') return json(res, 200, await connections.disconnect(connectionMatch[1])); await connections.connect(connectionMatch[1], { reconnect: value.reconnect === true }); return json(res, 200, connections.list().find(item => item.id === connectionMatch[1])); }
      if (pathname === '/api/providers' && req.method === 'GET') return json(res, 200, runtime.listProviders?.() || []);
      if (pathname === '/api/providers' && req.method === 'POST') { if (!runtime.saveProvider) throw new Error('Provider connections are unavailable.'); const value = await runtime.saveProvider(await body(req)); runtimeUpdate(); return json(res, 200, value); }
      if (pathname === '/api/models/default' && req.method === 'POST') { if (!runtime.setDefaultModel) throw new Error('Default model settings are unavailable.'); const value = await body(req); await runtime.setDefaultModel(value.model); runtimeUpdate(); return json(res, 200, status(req)); }
      const providerMatch = pathname.match(/^\/api\/providers\/([a-zA-Z0-9_-]+)(\/(?:test|models))?$/);
      if (providerMatch && req.method === 'DELETE' && !providerMatch[2]) { await body(req); const value = await runtime.removeProvider(providerMatch[1]); runtimeUpdate(); return json(res, 200, value); }
      if (providerMatch?.[2] && req.method === 'POST') { const value = await body(req); const result = providerMatch[2] === '/test' ? await runtime.testProvider(providerMatch[1]) : await runtime.discoverModels(providerMatch[1], value); runtimeUpdate(); return json(res, 200, result); }
      if (pathname === '/api/browser/status' && req.method === 'GET') {
        if (options.signedBrowser === true) await browserImport.status();
        return json(res, 200, browserStatus(req));
      }
      if (pathname === '/api/browser/neo/import' && req.method === 'POST') {
        if (req.headers['x-blackice-remote'] === '1') return json(res, 403, { error: 'Open Neo import settings from BLACKICE on this computer.' });
        const value = await body(req, 1024);
        if (connectorClosing()) return json(res, 503, { error: 'BLACKICE is closing for maintenance.' });
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length || new URL(req.url, `http://${host}`).search) return json(res, 400, { error: 'Neo import accepts an empty request only. Choose the source and data in Neo.' });
        if (options.signedBrowser !== true) return json(res, 409, { error: 'Open Neo import settings from the BLACKICE desktop app.' });
        const pending = Promise.resolve().then(() => {
          if (connectorClosing()) throw Object.assign(new Error('BLACKICE is closing for maintenance.'), { status: 503 });
          return browserImport.open(value, { source: 'user' });
        });
        fileMutations.add(pending);
        try { return json(res, 200, await pending); }
        finally { fileMutations.delete(pending); }
      }
      if (pathname === '/api/browser/protection' && req.method === 'GET') return json(res, 200, browser.protectionStatus?.() || { available: false, enabled: false, ready: false, tabs: [] });
      if (pathname === '/api/browser/protection' && req.method === 'POST') {
        const value = await body(req, 8192);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return json(res, 400, { error: 'Choose a browser protection action.' });
        const fields = value.action === 'global' ? ['action', 'enabled'] : value.action === 'site' ? ['action', 'tabId', 'origin', 'enabled'] : value.action === 'refresh' ? ['action'] : null;
        if (!fields || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key)) || value.action !== 'refresh' && typeof value.enabled !== 'boolean') return json(res, 400, { error: 'Use only the supported browser protection fields.' });
        if (typeof browser.configureProtection !== 'function') return json(res, 409, { error: 'Browser protection is available in the contained BLACKICE browser.' });
        const pending = browser.configureProtection(value, { source: 'user' }); fileMutations.add(pending);
        try { const result = await pending; sendEvent({ type: 'browser.updated', data: browserStatus(), at: new Date().toISOString() }); return json(res, 200, result); }
        finally { fileMutations.delete(pending); }
      }
      if(pathname==='/api/application-sessions/status'&&req.method==='GET')return json(res,200,applicationWorkspace.status());
      if(pathname==='/api/application-sessions/action'&&req.method==='POST'){
        if(maintenanceRequested)throw Object.assign(new Error('Profile maintenance is in progress.'),{status:409});
        const value=await body(req);
        if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('Choose an application session action.'),{status:400});
        if(value.action==='read_document'){const {action,...args}=value;return json(res,200,await applicationWorkspace.readDocument(args));}
        if(value.action==='create'){const {action,...args}=value;return json(res,200,await applicationWorkspace.create(args));}
        if(value.action==='close'){
          if(Object.keys(value).some(key=>!['action','sessionId'].includes(key)))throw Object.assign(new Error('End a session by its sessionId only.'),{status:400});
          return json(res,200,await applicationWorkspace.end(value.sessionId));
        }
        return json(res,200,await applicationWorkspace.perform(value));
      }
      if (pathname === '/api/browser/firefox/disconnect' && req.method === 'POST') { await body(req); await browser.disconnectFirefox(); return json(res, 200, browserStatus(req)); }
      if (pathname === '/api/browser/chrome/connect' && req.method === 'POST') {
        await body(req);
        if (options.signedBrowser !== true) return json(res, 400, { error: 'Connect Chrome from the Relay desktop app.' });
        chromeConnect ||= (options.connectChromeBrowser || registerChromeBrowser)({ connections, signal: AbortSignal.timeout(65000) }).finally(() => { chromeConnect = null; });
        await chromeConnect;
        sendEvent({ type: 'browser.updated', data: browserStatus(), at: new Date().toISOString() });
        return json(res, 200, browserStatus(req));
      }
      if (pathname === '/api/browser/reconnect' && req.method === 'POST') {
        await body(req);
        if (options.signedBrowser !== true) return json(res, 400, { error: 'Existing-browser discovery is available in the desktop app.' });
        await refreshSignedBrowser();
        return json(res, 200, browserStatus(req));
      }
      if (pathname === '/api/browser/start' && req.method === 'POST') {
        await body(req);
        if (!signedIntegration || typeof options.startSignedBrowser !== 'function') return json(res, 400, { error: 'Manual external-browser startup is available in the desktop app.' });
        const connected=await refreshSignedBrowser({startIfNeeded:true});
        if(!connected.available)return json(res,503,{error:connected.reason||'BrowserOS Neo is not ready. Task agents use the contained browser.'});
        return json(res, 200, browserStatus(req));
      }
      if (pathname === '/api/browser/action' && req.method === 'POST') return json(res, 200, await browser.perform(await body(req), { source: 'user' }));
      if (pathname === '/api/browser/show' && req.method === 'POST') { const value = await body(req); return json(res, 200, await browser.show(value.tabId)); }
      if (pathname === '/api/prompts' && req.method === 'GET') {
        const query = new URL(req.url, `http://${host}`).searchParams;
        if (query.has('includeDeleted') && !['true', 'false'].includes(query.get('includeDeleted'))) throw Object.assign(new Error('includeDeleted must be true or false.'), { status: 400 });
        return json(res, 200, { templates: prompts.list({ query: query.get('query') || '', includeDeleted: query.get('includeDeleted') === 'true' }), status: prompts.status() });
      }
      if (pathname === '/api/prompts/save' && req.method === 'POST') { const value = await promptBody(req, ['template', 'expectedRevision']); return json(res, 200, { template: await prompts.save(value.template, { expectedRevision: value.expectedRevision }) }); }
      if (pathname === '/api/prompts/render' && req.method === 'POST') return json(res, 200, prompts.render(await promptBody(req, ['template', 'id', 'values'])));
      if (pathname === '/api/prompts/import' && req.method === 'POST') { const value = await promptBody(req, ['document']); return json(res, 201, { template: await prompts.import(value.document) }); }
      const promptAction = pathname.match(/^\/api\/prompts\/([A-Za-z0-9_-]+)\/(history|delete|restore|export)$/);
      if (promptAction && req.method === 'GET' && promptAction[2] === 'history') return json(res, 200, prompts.history(promptAction[1]));
      if (promptAction && req.method === 'GET' && promptAction[2] === 'export') return json(res, 200, { document: prompts.export(promptAction[1]) });
      if (promptAction && req.method === 'POST' && ['delete', 'restore'].includes(promptAction[2])) { const value = await promptBody(req, promptAction[2] === 'delete' ? ['expectedRevision'] : ['expectedRevision', 'revision']); return json(res, 200, { template: await (promptAction[2] === 'delete' ? prompts.remove(promptAction[1], { expectedRevision: value.expectedRevision }) : prompts.restore(promptAction[1], { expectedRevision: value.expectedRevision, revision: value.revision })) }); }
      const promptMatch = pathname.match(/^\/api\/prompts\/([A-Za-z0-9_-]+)$/);
      if (promptMatch && req.method === 'GET') return json(res, 200, { template: prompts.get(promptMatch[1]) });
      if (pathname === '/api/knowledge' && req.method === 'GET') {
        const query = new URL(req.url, `http://${host}`).searchParams;
        return json(res, 200, knowledge.list({ ...(query.has('kind') ? { kind: query.get('kind') } : {}), ...(query.has('memoryType') ? { memoryType: query.get('memoryType') } : {}), ...(query.has('query') ? { query: query.get('query') } : {}), ...(query.has('cwd') ? { cwd: query.get('cwd') } : {}), ...(query.has('limit') ? { limit: Number(query.get('limit')) } : {}), ...(query.has('includeDeleted') ? {includeDeleted:query.get('includeDeleted')==='true'} : {}), ...(query.has('deletedOnly') ? {deletedOnly:query.get('deletedOnly')==='true'} : {}) }));
      }
      if (pathname === '/api/knowledge' && req.method === 'POST') { const value = await body(req); const entry = await mutateKnowledge(async () => { await learning.cancelBackground('A user is editing saved knowledge.'); const saved = await knowledge.upsert(value, { source: 'user' }); await learning.recordKnowledgeChange(saved); return saved; }); sendEvent({ type: 'knowledge.updated', data: knowledge.status(), at: new Date().toISOString() }); return json(res, 200, entry); }
      const knowledgeHistory = pathname.match(/^\/api\/knowledge\/([a-zA-Z0-9_-]+)\/(history|restore|patch)$/);
      if (knowledgeHistory && req.method === 'GET' && knowledgeHistory[2] === 'history') return json(res,200,knowledge.history(knowledgeHistory[1]));
      if (knowledgeHistory && req.method === 'POST' && ['restore','patch'].includes(knowledgeHistory[2])) {
        const value=await body(req),id=knowledgeHistory[1];
        const saved=await mutateKnowledge(async()=>{
          await learning.cancelBackground('You are changing a saved memory or skill.');
          const previous=knowledge.history(id).history[0];
          const entry=knowledgeHistory[2]==='patch'?await knowledge.patch(id,value,{source:'user'}):await knowledge.restore(id,value.revision,{source:'user'},{expectedRevision:value.expectedRevision});
          if(entry.deleted)await learning.recordKnowledgeDeletion(id,previous);else await learning.recordKnowledgeChange(entry);
          return entry;
        });
        sendEvent({type:'knowledge.updated',data:knowledge.status(),at:new Date().toISOString()});return json(res,200,saved);
      }
      const knowledgeMatch = pathname.match(/^\/api\/knowledge\/([a-zA-Z0-9_-]+)$/);
      if (knowledgeMatch && req.method === 'GET') return json(res, 200, knowledge.get(knowledgeMatch[1]));
      if (knowledgeMatch && req.method === 'DELETE') { const deletion = await body(req); const value = await mutateKnowledge(async () => { await learning.cancelBackground('A user is deleting saved knowledge.'); const previous = knowledge.get(knowledgeMatch[1]); const saved = await knowledge.remove(knowledgeMatch[1],{expectedRevision:deletion.expectedRevision,provenance:{source:'user'}}); await learning.recordKnowledgeDeletion(knowledgeMatch[1], previous); return saved; }); sendEvent({ type: 'knowledge.updated', data: knowledge.status(), at: new Date().toISOString() }); return json(res, 200, value); }
      if(pathname==='/api/file-patches'&&req.method==='GET'){const query=new URL(req.url,`http://${host}`).searchParams;return json(res,200,await engine.filePatches.list({...(query.get('cwd')?{cwd:query.get('cwd')}:{}),...(query.get('runId')?{runId:query.get('runId')}:{}),...(query.has('offset')?{offset:Number(query.get('offset'))}:{}),...(query.has('limit')?{limit:Number(query.get('limit'))}:{})}));}
      const filePatchMatch=pathname.match(/^\/api\/file-patches\/([a-zA-Z0-9_-]+)(?:\/(undo))?$/);
      if(filePatchMatch&&req.method==='GET'&&!filePatchMatch[2])return json(res,200,await engine.filePatches.get(filePatchMatch[1]));
      if(filePatchMatch&&req.method==='POST'&&filePatchMatch[2]){await body(req);const pending=engine.filePatches.undo(filePatchMatch[1],{source:'user'});fileMutations.add(pending);try{const value=await pending;sendEvent({type:'workspace.patch',data:value,at:new Date().toISOString()});return json(res,200,value);}finally{fileMutations.delete(pending);}}
      if (pathname === '/api/desktop/status' && req.method === 'GET') return json(res, 200, desktop.status());
      if (pathname === '/api/desktop/attach' && req.method === 'POST') { await body(req); await desktop.setEnabled(true); return json(res, 200, desktop.status()); }
      if (pathname === '/api/desktop/detach' && req.method === 'POST') { await body(req); await desktop.setEnabled(false); return json(res, 200, desktop.status()); }
      if (pathname === '/api/desktop/frame' && req.method === 'GET') return json(res, 200, await desktop.perform({ action: 'screenshot', source: 'preview' }));
      if (pathname === '/api/desktop/windows' && req.method === 'GET') return json(res, 200, await desktop.perform({ action: 'windows', source: 'preview' }));
      if (pathname === '/api/shutdown' && req.method === 'POST' && server.listenerCount('relay.shutdown')) {
        await body(req); json(res, 200, { ok: true }); setImmediate(() => server.emit('relay.shutdown')); return;
      }
      if (pathname === '/api/runtime/settings' && req.method === 'GET') return json(res, 200, runtimeSettings.get());
      if (pathname === '/api/runtime/settings' && req.method === 'POST') return json(res, 200, await runtimeSettings.update(await body(req)));
      if (pathname === '/api/runtime/reconnect' && req.method === 'POST') {
        await body(req);
        await runtime.start({connectCodex:true});
        runtimeUpdate();
        // A saved explicit queue can be waiting after the initial connection
        // failed. Its existing pause, capacity and intent rules own admission.
        inbox.kick();
        return json(res, 200, status(req));
      }
      const exportMatch = pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/export$/);
      if (exportMatch && req.method === 'GET') {
        const file = await conversations.export(exportMatch[1], {format:new URL(req.url,`http://${host}`).searchParams.get('format') || 'json',attachments});
        res.writeHead(200, {'Content-Type':file.contentType,'Content-Disposition':`attachment; filename="${file.filename.replace(/[^a-zA-Z0-9._-]/g,'_')}"`,'Cache-Control':'no-store'});
        return res.end(file.body);
      }
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`data: ${JSON.stringify({ type: 'runtime.status', data: status(req), at: new Date().toISOString() })}\n\n`);
        clients.add(res); res.on('close', () => clients.delete(res)); return;
      }
      if (pathname === '/api/workflows' && req.method === 'GET') return json(res, 200, engine.listWorkflows());
      if (pathname === '/api/workflows' && req.method === 'POST') return json(res, 200, await engine.saveWorkflow(await body(req)));
      const workflowMatch = pathname.match(/^\/api\/workflows\/([a-zA-Z0-9_-]+)$/);
      if (workflowMatch && req.method === 'GET') { const w = engine.listWorkflows().find(w => w.id === workflowMatch[1]); return json(res, w ? 200 : 404, w || { error: 'Workflow not found.' }); }
      if (workflowMatch && req.method === 'DELETE') { await body(req); await engine.deleteWorkflow(workflowMatch[1]); return json(res, 200, { ok: true }); }
      if (pathname === '/api/runs' && req.method === 'GET') return json(res, 200, engine.listRuns());
      if (pathname === '/api/runs' && req.method === 'POST') { const value=await body(req);await recoverClientRequest(value);return json(res,201,engine.startRun(value)); }
      if(pathname==='/api/runs/stop-all'&&req.method==='POST'){
        await body(req);
        // Invoke every stop independently, even if one adapter throws synchronously.
        const pending=[],attempt=action=>{try{pending.push(Promise.resolve(action()));}catch(error){pending.push(Promise.reject(error));}};
        attempt(()=>inbox.pause('All chats stopped. Resume queued starts when ready.'));
        attempt(()=>operations.pause('All chats stopped.'));
        attempt(()=>pauseProjects('All work stopped. Resume the project when ready.'));
        let cancelled=0;
        for(const run of engine.listRuns())if(['queued','running','waiting'].includes(run.status)){attempt(()=>engine.cancelRun(run.id));cancelled++;}
        attempt(()=>{cancelled+=engine.cancelCompactions?.()||0;});
        attempt(()=>browser.cancel());
        attempt(()=>learning.cancelBackground('All chats stopped.'));
        const results=await Promise.allSettled(pending),failures=results.filter(result=>result.status==='rejected').map(result=>String(result.reason?.message||result.reason));
        return json(res,failures.length?500:200,{cancelled,...(failures.length?{error:'Some stop actions need attention.',details:failures}:{})});
      }
      const runMatch = pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)(\/(?:cancel|retry|continue|steer|compact))?$/);
      if (runMatch && req.method === 'GET' && !runMatch[2]) return json(res, 200, await conversations.get(runMatch[1]));
      if (runMatch?.[2] && req.method === 'POST') {
        const value = await body(req);
        if(runMatch[2]==='/continue')await recoverClientRequest(value);
        if (runMatch[2] === '/compact') return json(res, 200, await engine.compactRun(runMatch[1], value));
        if(['/continue','/retry'].includes(runMatch[2])&&!engine.runs.has(runMatch[1]))engine.restoreArchivedRun(await conversations.get(runMatch[1]));
        if(runMatch[2]==='/retry'&&(await conversations.family(runMatch[1])).state!=='active')throw Error('Restore this conversation before retrying.');
        if (runMatch[2] === '/continue') {const family=await conversations.family(runMatch[1]);if(family.state!=='active')throw Error('Restore this conversation before replying.');const prior=engine.getRun(runMatch[1]).nodes[value.nodeId],threadModel=await runtime.savedThreadModel?.(prior?.threadId);return json(res, 201, engine.continueRun(runMatch[1], value,{historyRuns:family.runs,threadModel}));}
        if (runMatch[2] === '/steer') return json(res, 200, await engine.steerRun(runMatch[1], value));
        if (runMatch[2] === '/cancel') return json(res, 200, engine.cancelRun(runMatch[1]));
        return json(res, 201, engine.retryRun(runMatch[1], {historyRuns:(await conversations.family(runMatch[1])).runs,...(value.planningMode !== undefined ? {planningMode:value.planningMode} : {})}));
      }
      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Endpoint not found.' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
      const files = Object.fromEntries(['gui-resilience.js','gui-resilience.css','browser-credentials-ui.mjs','browser-credentials.css','chatgpt-connector-ui.mjs','chatgpt-connector.css','model-routes.mjs','clipboard.mjs','email-oauth-ui.mjs','planning-awareness.mjs','planning-workspace-ui.mjs','planning-workspace-model.mjs','planning-workspace.css','remote-access-ui.mjs','remote-access.css','icon-symbols.mjs','task-plan-map.mjs','planning-mode.mjs','assets/blackice-field.svg','assets/blackice-wordmark.svg','workspace-integrations.mjs','email-ui.mjs', 'email-reader.mjs','email.css','task-plan-model.mjs','task-plan-ui.mjs','task-plan.css','task-method-ui.mjs','task-method.css','blackice-material.css','conversation-layout.css','blackice-experience.css','process-model.mjs','process-ui.mjs','assets/blackice-sheet.svg','assets/blackice-slab.svg','application-session-ui.mjs','application-session-model.mjs','application-session.css','project-view-model.mjs','operations-view-model.mjs','workflow-map.mjs','workflow-map.css','projects-ui.mjs','projects.css','tool-outcomes-model.mjs','response-defaults.mjs','repeat-task-model.mjs','task-title.mjs','prompt-template-model.mjs','prompts-ui.mjs','prompts.css','reasoning-model.mjs','provider-catalog.mjs','connection-models.mjs','connections.css','draft-store.mjs','svg-preview.mjs','api-client.mjs','artifact-ui.mjs','conversation-attention.mjs','conversation-search.mjs','index.html','app.js','editor-model.mjs','knowledge-ui.mjs','mission-ui.mjs','mission-model.mjs','connections-ui.mjs','browser-ui.mjs','browser-tree-model.mjs','browser-tree.css','identity-ui.mjs','identity.css','learning-ui.mjs','learning.css','context-ui.mjs','context.css','tool-connections-ui.mjs','tool-connections.css','agent-workspace.css','styles.css','brand.css','ux.css','relay-surface.css','agentdesk-noir.css','blackice-components.css','blackice-type.css','knowledge.css','file-patches.css','file-patches-ui.mjs','sidebar.css','sidebar-model.mjs','model-picker.css','model-picker.mjs','workspace.css','attachments-ui.mjs','attachments.css','inbox-ui.mjs','inbox.css','task-state-ui.mjs','task-state.css','conversation-model.mjs','composer-helpers.mjs','run-state-model.mjs','conversation.css','observe-stream.mjs','observe-ui.mjs','observe-model.mjs','observe.css','swarm-model.mjs','schedule-model.mjs','conversation-menu.mjs','advanced-ui.mjs','advanced.css','modes.css','configure-ui.mjs','configure.css','assets/fonts/Oxanium-Variable.ttf','assets/fonts/IBMPlexMono-Regular.ttf','assets/fonts/IBMPlexMono-Medium.ttf','assets/fonts/ShareTechMono-Regular.ttf','assets/blackice-panel-ice.svg','assets/blackice-control-ice.svg','assets/relay-mark.svg','assets/agentdesk-noir-city.svg','assets/relay-field.svg','assets/identity.svg','assets/learning.svg','assets/context.svg','assets/connections.svg'].map(file => [`/${file}`, file])); files['/'] = 'index.html';
      if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (!files[pathname]) return json(res, 404, { error: 'Page not found.' });
      const content = await fs.readFile(path.join(APP_DIR, 'public', files[pathname]));
      if (files[pathname] === 'index.html') res.setHeader('Set-Cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(files[pathname])], 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (pathname.startsWith('/api/browser-credentials')) {
        void diagnostics.recordError('credentials', 'request_failed', new Error('A password-manager operation could not complete.'));
        const code = typeof error.code === 'string' && /^CREDENTIAL_[A-Z_]+$/.test(error.code) ? error.code : 'CREDENTIAL_OPERATION_FAILED';
        if (!res.headersSent) return json(res, error.status || 400, { error: 'The password-manager operation could not complete. Refresh its status before retrying.', code });
        return res.end();
      }
      void diagnostics.recordError('server','request_failed',error);
      // The registration form needs an explicit conflict receipt to offer a
      // deliberate reload. Do not expose arbitrary internal/provider codes.
      const emailRegistrationConflict = error.status === 409 && error.code === 'EMAIL_OAUTH_REVISION_CONFLICT' && ['/api/email/oauth/config', '/api/email/oauth/begin'].includes(pathname);
      if (!res.headersSent) json(res, error.status || (/not found/i.test(error.message) ? 404 : 400), { error: error.message, ...(emailRegistrationConflict ? { code: 'EMAIL_OAUTH_REVISION_CONFLICT' } : {}) });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  const heartbeat = setInterval(() => { for (const res of clients) if(!writeEventStream(res,': heartbeat\n\n'))clients.delete(res); }, 15000);
  heartbeat.unref();
  return {
    server, engine, runtime, runtimeSettings, desktop, knowledge, prompts, browser,browserCredentials,browserCredentialMirror,browserCredentialDestinations,applicationWorkspace, identity, learning, connections, tasks, planningOrganization, attachments, email, emailOAuth, emailClient, inbox, conversations, operations,projects,capabilities,liveEdits,diagnostics,supportSnapshot,beginMaintenance,endMaintenance,assertRestartReady,assertRestartPrepared,beginRestart,endRestart,remoteAccess,remoteAgentApi,chatGPTConnector,chatGPTOAuth,directExecution,chatGPTPlanning,connectorSetup,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      boundPort = server.address().port;
      await remoteAccess?.attach({ origin: `http://127.0.0.1:${boundPort}`, sessionCookie: `relay_session_${boundPort}=${session}` });
      await diagnostics.record({component:'server',event:'ready'});
      // Listening is independent of provider startup so connection errors are visible in the UI.
      Promise.resolve().then(() => runtime.start()).then(() => { runtimeUpdate(); inbox.kick(); }).catch(error => { void diagnostics.recordError('runtime','runtime_failed',error);console.error('Agent connection failed; see support diagnostics.'); runtimeUpdate(); });
      return `http://127.0.0.1:${boundPort}`;
    },
    async close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        clearInterval(heartbeat);
        offPlanningAwareness?.();
        let firstError;
        const cleanup = async operation => { try { await operation(); } catch (error) { firstError ||= error; } };
        await cleanup(() => connectorSetup.close());
        await cleanup(() => remoteAccess?.close());
        remoteAgentApi.close();
        await cleanup(() => chatGPTConnector.close());
        await cleanup(()=>Promise.all([...observers.keys()].map(id=>stopObserving(id,'Relay is closing.'))));
        await cleanup(()=>liveEdits.close());
        await cleanup(() => methods.close());
        await cleanup(() => projects.close());
        await cleanup(() => capabilities.close());
        await cleanup(() => operations.close());
        await cleanup(() => inbox.close());
        await cleanup(() => desktop.setEnabled(false));
        await cleanup(() => browser.cancel());
        await cleanup(() => signedIntegration?.close());
        await cleanup(() => engine.close());
        await cleanup(() => applicationWorkspace.close());
        await cleanup(() => conversations.close());
        await cleanup(() => Promise.all([...knowledgeMutations]));
        await cleanup(() => Promise.all([...fileMutations]));
        await cleanup(() => planningOrganization.close());
        await cleanup(() => learning.close());
        await cleanup(() => runtimeSettings.close());
        await cleanup(() => prompts.close());
        await cleanup(() => email.close());
        await cleanup(() => emailOAuth.close());
        await cleanup(() => emailClient.close());
        await cleanup(() => browserCredentialMirror.close());
        await cleanup(() => browserCredentialDestinations.close());
        await cleanup(() => browserCredentials.close());
        await cleanup(() => browserImport.close());
        await cleanup(() => connections.close());
        await cleanup(() => identity.close());
        await cleanup(() => tasks.close());
        await cleanup(() => attachments.close());
        await cleanup(() => browser.close());
        await cleanup(async () => {
          // Cancellation and rejected edits do not represent an unsaved committed snapshot.
          await knowledge.writeChain.catch(() => {});
          const saved = knowledge.status();
          if (!saved.healthy) throw new Error(saved.error || 'Local knowledge could not be saved.');
        });
        await cleanup(() => runtime.close?.());
        for (const res of clients) await cleanup(() => res.end());
        clients.clear();
        await cleanup(() => server.closeAllConnections());
        if (server.listening) await cleanup(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
        await diagnostics.record({component:'server',event:firstError?'stop_failed':'stopped',...(firstError?{level:'error',code:firstError.code}:{})});
        if(!options.diagnostics)await diagnostics.close();
        if (firstError) throw firstError;
      })();
      return closePromise;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let app;
  try {
    app = await createHarnessServer();
    const url = await app.listen();
    await fs.writeFile(path.join(APP_DIR, 'data', 'server.pid'), String(process.pid));
    console.log(`Relay is running at ${url}\nWorkspace: ${(app.runtime.status()).cwd || process.env.RELAY_WORKSPACE || path.join(APP_DIR, 'workspace')}\nPress Ctrl+C to stop.`);
    const shutdown = async () => { await app.close(); await fs.rm(path.join(APP_DIR, 'data', 'server.pid'), { force: true }); process.exit(0); };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
    app.server.on('relay.shutdown', shutdown);
  } catch (error) { console.error("Relay could not start. Inspect local profile recovery and support diagnostics."); await app?.diagnostics.recordError("server","start_failed",error);await app?.close(); process.exitCode = 1; }
}
