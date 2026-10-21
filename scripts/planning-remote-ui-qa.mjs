#!/usr/bin/env node
/** Isolated UI acceptance: real server and headless browser, deterministic local model only. */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appFingerprint } from './release-check.mjs';
import { knowledgeUIJourney } from './knowledge-ui-journey.mjs';
import { emailReaderUIJourney } from './email-reader-ui-journey.mjs';
import { chatModeRetirementUIJourney } from './chat-mode-retirement-ui-journey.mjs';
import { planningOrganizationUIJourney } from './planning-organization-ui-journey.mjs';
import { chatGPTConnectorUIJourney } from './chatgpt-connector-ui-journey.mjs';
import { browserCredentialsUIJourney, createPasswordManagerUIFixture, PASSWORD_MANAGER_UI_FEATURES } from './browser-credentials-ui-journey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREPLAN = 'QA_EARLY_RESPONSE_MUST_WAIT_FOR_PLAN';
const FINAL = 'QA_FINAL_RESULT_CHECKED';
const UNPLANNED = 'QA_UNPLANNED_FINAL_MUST_BE_WITHHELD';
const OFF_FINAL = 'QA_OFF_FINAL_WITHOUT_AUTOMATIC_PLAN';
const EMPTY_UNPLANNED = 'QA_EMPTY_UNPLANNED_ANSWER_MUST_BE_WITHHELD';
const UNAVAILABLE_FINAL = 'QA_CONVERSATION_WITHOUT_PLANNING_TOOLS';
const DIRECTION_ERROR = 'The owned fixture rejected this direction; its original draft is kept.';
const SOURCE = 'Isolated BLACKICE source note: check the plan before displaying the answer.\n';
const readText = value => String(value).split('\n').map(line => line.replace(/^\d+: /, '')).join('\n');
const NOTE = 'Working note: the owned source was read; no provider or mailbox was contacted.';
const EXPECTED_RESULT = 'A checked qa-result.txt containing the saved outcome and working note.';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export const VALIDATION_TESTS = ['tests/browser-credentials-ui.test.mjs', 'tests/browser-credentials-http.test.mjs', 'tests/browser-credentials.test.mjs', 'tests/browser-credential-mirror.test.mjs', 'tests/model-routes.test.mjs', 'tests/model-picker.test.mjs', 'tests/mission-ui.test.mjs', 'tests/observe-surfaces.test.mjs', 'tests/clipboard.test.mjs', 'tests/engine-task-plan.test.mjs', 'tests/task-plan.test.mjs', 'tests/swarm.test.mjs', 'tests/project-tools.test.mjs', 'tests/projects.test.mjs', 'tests/projects-http.test.mjs', 'tests/cron.test.mjs', 'tests/operations.test.mjs', 'tests/operations-capacity.test.mjs', 'tests/operations-http.test.mjs', 'tests/planning-editor.test.mjs', 'tests/planning-awareness-ui.test.mjs', 'tests/planning-awareness.test.mjs', 'tests/planning-awareness-engine.test.mjs', 'tests/email-oauth-ui.test.mjs', 'tests/email-ui.test.mjs', 'tests/email-oauth.test.mjs', 'tests/email-http.test.mjs', 'tests/observe-tabs.test.mjs', 'tests/remote-access-auth.test.mjs', 'tests/remote-access-gateway.test.mjs', 'tests/remote-agent-api.test.mjs', 'tests/desktop-lifecycle.test.mjs'];
export const SOURCES = ['scripts/browser-credentials-ui-journey.mjs', 'lib/browser-credentials.mjs', 'lib/browser-credential-mirror.mjs', 'lib/browser-credential-destination.mjs', 'lib/credential-temp-protection.mjs', 'public/browser-credentials-ui.mjs', 'public/browser-credentials.css', 'lib/email-client.mjs', 'scripts/chatgpt-connector-ui-journey.mjs', 'lib/chatgpt-connector.mjs', 'lib/chatgpt-oauth.mjs', 'lib/chatgpt-planning.mjs', 'lib/direct-execution-api.mjs', 'lib/direct-execution-jobs.mjs', 'lib/chatgpt-file-import.mjs', 'public/chatgpt-connector-ui.mjs', 'public/chatgpt-connector.css', 'public/model-routes.mjs', 'public/mission-model.mjs', 'public/reasoning-model.mjs', 'public/conversation-model.mjs', 'lib/providers.mjs', 'lib/retired-models.mjs', 'lib/provider-store.mjs', 'public/clipboard.mjs', 'public/model-picker.mjs', 'public/model-picker.css', 'public/connections-ui.mjs', 'public/connections.css', 'public/conversation-menu.mjs', 'public/conversation-search.mjs', 'public/sidebar-model.mjs', 'lib/conversation-search.mjs', 'lib/conversations.mjs', 'public/conversation-layout.css','public/icon-symbols.mjs','lib/harness-identity.mjs', 'public/run-state-model.mjs', 'public/conversation.css', 'public/blackice-experience.css', 'public/planning-mode.mjs', 'public/task-plan-map.mjs', 'public/task-plan.css', 'public/blackice-material.css', 'public/assets/blackice-field.svg', 'public/assets/blackice-wordmark.svg', 'server.mjs', 'lib/engine.mjs', 'lib/task-state.mjs', 'lib/task-plan.mjs', 'lib/cron.mjs', 'lib/projects.mjs', 'lib/subagents.mjs', 'lib/agent-email.mjs', 'public/app.js', 'public/index.html', 'public/workspace-integrations.mjs', 'public/mission-ui.mjs', 'public/task-plan-ui.mjs', 'public/advanced-ui.mjs', 'public/email-ui.mjs', 'public/email-oauth-ui.mjs', 'public/email.css', 'lib/email-oauth.mjs', 'scripts/email-oauth-token.mjs', 'scripts/planning-remote-ui-qa.mjs', 'scripts/knowledge-ui-journey.mjs', 'scripts/email-reader-ui-journey.mjs', 'scripts/chat-mode-retirement-ui-journey.mjs', 'scripts/planning-organization-ui-journey.mjs', 'lib/planning-organization.mjs', 'public/project-view-model.mjs', 'public/projects.css', 'lib/email-message.mjs', 'public/email-reader.mjs', 'public/knowledge-ui.mjs', 'public/knowledge.css', 'lib/knowledge.mjs', 'public/planning-awareness.mjs', 'lib/planning-awareness.mjs', 'public/planning-workspace-model.mjs', 'public/planning-workspace-ui.mjs', 'public/planning-workspace.css', 'public/task-plan-model.mjs', 'public/swarm-model.mjs', 'public/advanced.css', 'public/configure-ui.mjs', 'public/projects-ui.mjs', 'public/observe-ui.mjs', 'public/observe-model.mjs', 'public/observe.css', 'public/remote-access-ui.mjs', 'public/remote-access.css', 'lib/planning-workspace.mjs', 'lib/remote-access.mjs', 'lib/remote-access-auth.mjs', 'lib/remote-access-gateway.mjs', 'lib/remote-access-tailscale.mjs', 'lib/browser-protection.mjs', 'desktop/lifecycle.mjs', 'tests/fixtures/remote-transport.mjs'];
export const REQUIRED_FEATURES = [...PASSWORD_MANAGER_UI_FEATURES, 'chatModeRetirement', 'clipboardRecovery', 'planningSharedEditor', 'planningRevisionConflict', 'planningPresenceGesture', 'planningMobile', 'planningEditingPresence', 'planningWorkerReview', 'planningAwarenessMobile', 'swarmSharedReadiness', 'browserTabs', 'browserProtection', 'remoteSettings', 'emailOAuthSignIn', 'emailOAuthDraftSafety', 'emailOAuthMobile', 'typedKnowledge', 'emailReadableReply', 'planningOrganization', 'swarmOutline', 'chatGPTDirectConnector', 'emailClientHandoff'];
export function remoteDisableSettled(status) {
  return status?.state === 'disabled' && status.configuredEnabled === false && status.enabled === false && status.gateway?.listening === false && status.gateway?.accepting === false && Array.isArray(status.devices) && status.devices.length === 0 && !status.error;
}
export function parseArguments(argv) {
  const value = { candidate: ROOT, out: path.join(ROOT, '..', 'qa-planning-remote'), timeoutMs: 180000 };
  const names = new Map([['candidate','candidate'], ['out','out'], ['edge','edge'], ['timeout-ms','timeoutMs']]);
  for (let i = 0; i < argv.length; i++) {
    if (['--help','-h'].includes(argv[i])) return { help: true };
    const key = names.get(argv[i].replace(/^--/, '')); if (!key || !argv[i].startsWith('--') || !argv[i+1]) throw Error('Use --candidate, --out, --edge or --timeout-ms with a value.');
    value[key] = key === 'timeoutMs' ? Number(argv[++i]) : argv[++i];
  }
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 30000 || value.timeoutMs > 180000) throw Error('Use a bounded --timeout-ms from 30000 to 180000.');
  return value;
}
async function findBrowser(explicit) {
  const names = explicit ? [explicit] : [process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'), process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  for (const name of names) { try { if ((await fs.stat(name)).isFile()) return path.resolve(name); } catch {} }
  throw Error('No installed headless Edge/Chromium executable was found. Supply --edge.');
}
function disabledControllers() {
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false, busy: false }); desktop.setEnabled = async () => desktop.status();
  const browser = new EventEmitter(); browser.status = () => ({ available: false, contained: true, acceptingActions: false, tabs: [], activeTabId: null, browsers: { relay: { available: false, tabs: [] } } }); browser.cancel = async () => {}; browser.close = async () => {};
  const applicationWorkspace = new EventEmitter(); applicationWorkspace.status = () => ({ available: false, sessions: [], documents: [], supportedApps: [], documentStorage: { healthy: true } }); applicationWorkspace.close = async () => {};
  return { desktop, browser, applicationWorkspace };
}
export class WorkspaceFixtureRuntime extends EventEmitter {
  constructor(cwd) {
    super(); this.cwd = cwd; this.calls = []; this.stage = 'idle'; this.directionRequests = 0; this.directionSettlements = []; this.cancelObservations = 0;
    for (const name of ['planGate', 'mapUpdateGate', 'mapRestoreGate', 'finalGate', 'navigationErrorGate', 'navigationSuccessGate', 'directionGate', 'cancelGate']) this[name] = deferred();
  }
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', defaultModelAvailable: true, defaultModelSelection: 'default', activeTurns: ['before-plan', 'planned', 'map-updated', 'planned-restored', 'cancel-running', 'direction-pending', 'cancel-pending'].includes(this.stage) ? 1 : 0, models: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Isolated fixture model', supportsTools: true, available: true, provider: 'codex', providerId: 'codex' }, { id: 'fixture-no-tools', model: 'fixture-no-tools', displayName: 'Isolated conversation-only fixture', supportsTools: false, available: true, provider: 'codex', providerId: 'codex' }], providers: [], qaFixture: true }; }
  releaseControls() { for (const name of ['planGate', 'mapUpdateGate', 'mapRestoreGate', 'finalGate', 'navigationErrorGate', 'navigationSuccessGate', 'directionGate', 'cancelGate']) this[name].resolve(); }
  async init() {} async start() { return this.status(); } async close() { this.releaseControls(); }
  async steerAgent(threadId, message) {
    assert.equal(threadId, 'revised-ui-fixture-3'); assert.ok(typeof message === 'string' && message.startsWith('QA direction:'));
    const index = ++this.directionRequests; assert.ok(index <= 3, 'Only the three explicit local direction requests may execute.'); this.stage = 'direction-pending';
    await [this.navigationErrorGate, this.navigationSuccessGate, this.directionGate][index - 1].promise;
    this.directionSettlements.push({ index, accepted: index === 2 });
    if (index === 2) { this.stage = 'cancel-running'; return { accepted: true, delivery: 'delivered', threadId, turnId: 'revised-ui-turn-3', fixture: true }; }
    if (index === 1) this.stage = 'cancel-running';
    throw Object.assign(Error(index === 1 ? DIRECTION_ERROR : 'The task stopped before this direction was accepted.'), { code: 'CHAT_BUSY', status: 409 });
  }
  async gate(value, signal) { if (signal.aborted) throw signal.reason; await Promise.race([value.promise, new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]); if (signal.aborted) throw signal.reason; }
  async runAgent(options) {
    assert.equal(path.resolve(options.cwd), path.resolve(this.cwd));
    assert.ok(this.calls.length < 6, 'Only the six explicitly submitted local fixtures may execute.');
    const index = this.calls.length + 1, model = index === 6 ? 'fixture-no-tools' : 'fixture-model'; assert.ok(options.model === model || !options.model && model === 'fixture-model');
    const call = { index, model, externalRequests: 0, toolCalls: 0, harnessIdentified: String(options.developerInstructions || '').startsWith('BLACKICE AGENT HARNESS') }; this.calls.push(call);
    const threadId = `revised-ui-fixture-${index}`; options.onEvent({ type: 'thread', threadId, turnId: `revised-ui-turn-${index}`, model, codexHistory: 'relay' });
    if (index === 5 || index === 6) {
      const output = index === 5 ? EMPTY_UNPLANNED : UNAVAILABLE_FINAL; this.stage = index === 5 ? 'empty-unplanned' : 'unavailable-completed';
      options.onEvent({ type: 'delta', itemId: 'empty-plan-final', delta: output }); options.onEvent({ type: 'message', itemId: 'empty-plan-final', text: output, phase: 'final_answer' });
      return { output, threadId, usage: { totalTokens: 7 } };
    }
    if (index === 4) {
      this.stage = 'off-completed';
      options.onEvent({ type: 'delta', itemId: 'off-final', delta: OFF_FINAL });
      options.onEvent({ type: 'message', itemId: 'off-final', text: OFF_FINAL, phase: 'final_answer' });
      return { output: OFF_FINAL, threadId, usage: { totalTokens: 7 } };
    }
    if (index === 2) { this.stage = 'unplanned'; options.onEvent({ type: 'delta', itemId: 'unplanned', delta: UNPLANNED }); options.onEvent({ type: 'message', itemId: 'unplanned', text: UNPLANNED, phase: 'final_answer' }); return { output: UNPLANNED, threadId, usage: { totalTokens: 7 } }; }
    const tool = async (name, args) => { call.toolCalls++; const result = await options.onToolCall({ name, arguments: args }); assert.equal(result.success, true, JSON.stringify(result)); return JSON.parse(result.contentItems[0].text); };
    let state;
    const task = async args => { state = await tool('relay_task', { ...args, ...(args.action === 'read' ? {} : { expectedRevision: state.revision }) }); return state; };
    if (index === 3) {
      await task({ action: 'read' });
      await task({ action: 'plan', plan: { layout: 'sequence', taskType: 'general', detail: 'balanced' }, steps: [{ id: 'controlled-stop', title: 'Wait for the requested stop', status: 'active', doneWhen: 'The owned fixture receives cancellation and acknowledges it.' }] });
      this.stage = 'cancel-running';
      await new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }); });
      this.cancelObservations++; this.stage = 'cancel-pending';
      await this.cancelGate.promise; this.stage = 'cancelled';
      throw options.signal.reason || Error('The owned fixture was cancelled.');
    }
    this.stage = 'before-plan'; options.onEvent({ type: 'delta', itemId: 'early', delta: PREPLAN }); options.onEvent({ type: 'message', itemId: 'early', text: PREPLAN, phase: 'commentary' });
    await this.gate(this.planGate, options.signal);
    await task({ action: 'read' });
    await task({ action: 'plan', plan: { layout: 'sequence', taskType: 'general', detail: 'balanced' }, steps: [
      { id: 'inspect', title: 'Inspect the local source note', status: 'active', doneWhen: 'The complete owned source note is read through the workspace tool.' },
      { id: 'save', title: 'Save and check the local result', status: 'pending', dependsOn: ['inspect'], note: NOTE, result: EXPECTED_RESULT, doneWhen: 'The result file is written and read back with exact expected text.' }
    ] });
    const read = await tool('relay_workspace', { action: 'read', path: 'qa-source.txt' }); assert.equal(readText(read.content), SOURCE);
    await task({ action: 'step', stepId: 'inspect', status: 'done', evidence: 'Read qa-source.txt through relay_workspace and compared every character with the owned fixture source.' });
    await task({ action: 'step', stepId: 'save', status: 'active' });
    await task({ action: 'checkpoint', decisions: ['Use only the disposable local source and tools.'], completed: ['Read and checked the source note.'], nextSteps: ['Write and read the result file.'], nextAction: 'Write qa-result.txt, read it back, and record the observed result.' });
    this.stage = 'planned'; await this.gate(this.mapUpdateGate, options.signal);
    await task({ action: 'step', stepId: 'save', status: 'blocked', blockedReason: 'The owned fixture is waiting for its map focus check before writing the result.' });
    this.stage = 'map-updated'; await this.gate(this.mapRestoreGate, options.signal);
    await task({ action: 'step', stepId: 'save', status: 'active' });
    this.stage = 'planned-restored'; await this.gate(this.finalGate, options.signal);
    const text = FINAL + '\n' + NOTE + '\n';
    await tool('relay_workspace', { action: 'write', path: 'qa-result.txt', text });
    assert.equal(readText((await tool('relay_workspace', { action: 'read', path: 'qa-result.txt' })).content), text);
    await task({ action: 'artifact', path: 'qa-result.txt', title: 'QA checked result' });
    const artifact = state.artifacts.find(item => item.fileName === 'qa-result.txt');
    assert.ok(artifact?.id && artifact.verification === 'filesystem-sha256' && artifact.sha256 === createHash('sha256').update(text).digest('hex'), 'The fixture result must be a registered, byte-verified deliverable before file search.');
    await task({ action: 'step', stepId: 'save', status: 'done', evidence: 'Wrote qa-result.txt, read it back through relay_workspace, and compared all text. This validates only the disposable fixture.' });
    this.stage = 'completed'; const output = FINAL + '\n\nThe owned result file and working note were saved and checked.';
    options.onEvent({ type: 'delta', itemId: 'final', delta: output }); options.onEvent({ type: 'message', itemId: 'final', text: output, phase: 'final_answer' });
    return { output, threadId, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
  }
}

class CDP {
  constructor(socket, signal) {
    this.socket = socket; this.signal = signal; this.counter = 0; this.pending = new Map(); this.events = []; this.methodNetwork = []; this.directionNetwork = []; this.conversationNetwork = []; this.networkUrls = []; this.interceptionError = null;
    socket.addEventListener('message', event => {
      let value; try { value = JSON.parse(event.data); } catch { return; }
      if (value.method === 'Network.requestWillBeSent') this.networkUrls.push(value.params.request.url);
      const planning = this.planningSaveDiagnostics;
      if (planning && value.sessionId === planning.sessionId) {
        const params = value.params || {};
        const requests = params.request?.url === planning.url ? planning.requests : params.request?.url === planning.presenceUrl ? planning.presenceRequests : null;
        if (value.method === 'Network.requestWillBeSent' && requests && params.request.method === 'POST' && requests.length < 8) {
          requests.push({ requestId: params.requestId, method: params.request.method, path: new URL(params.request.url).pathname, at: params.timestamp, wallTime: params.wallTime, postData: params.request.postData?.slice(0, 24000) ?? null, hasPostData: params.request.hasPostData === true, status: null, finished: false });
        } else {
          const request = [...planning.requests, ...(planning.presenceRequests || [])].find(item => item.requestId === params.requestId);
          if (request && value.method === 'Network.responseReceived') Object.assign(request, { status: params.response.status, mimeType: params.response.mimeType, responseAt: params.timestamp });
          else if (request && value.method === 'Network.loadingFinished') Object.assign(request, { finished: true, finishedAt: params.timestamp, encodedDataLength: params.encodedDataLength });
          else if (request && value.method === 'Network.loadingFailed') Object.assign(request, { failed: true, failedAt: params.timestamp, canceled: params.canceled === true, error: String(params.errorText || '').slice(0, 600) });
        }
      }
      if (value.id) {
        const pending = this.pending.get(value.id); if (!pending) return;
        this.pending.delete(value.id); clearTimeout(pending.timer);
        if (value.error) pending.reject(new Error(`${pending.method}: ${value.error.message}`)); else pending.resolve(value.result || {});
      } else if (['Runtime.exceptionThrown', 'Log.entryAdded'].includes(value.method)) this.events.push(value);
      else if (value.method === 'Fetch.requestPaused') {
        const handler = this.interceptRequest;
        if (handler) Promise.resolve().then(() => handler(value.params, value.sessionId)).catch(error => { this.interceptionError = error.message; });
        else void this.call('Fetch.continueRequest', { requestId: value.params.requestId }, value.sessionId).catch(() => {});
      } else if (value.method === 'Network.requestWillBeSent' && /\/api\/conversations(?:[/?]|$)/.test(value.params.request.url)) {
        this.conversationNetwork.push({ requestId: value.params.requestId, method: value.params.request.method, url: value.params.request.url, status: null, finished: false });
      } else if (value.method === 'Network.responseReceived' && /\/api\/conversations(?:[/?]|$)/.test(value.params.response.url)) {
        const request = this.conversationNetwork.find(item => item.requestId === value.params.requestId); if (request) request.status = value.params.response.status;
      } else if (value.method === 'Network.requestWillBeSent' && /\/api\/methods(?:[/?]|$)/.test(value.params.request.url)) {
        this.methodNetwork.push({event: 'request', requestId: value.params.requestId, method: value.params.request.method, url: value.params.request.url, sessionId: value.sessionId});
      } else if (value.method === 'Network.responseReceived' && /\/api\/methods(?:[/?]|$)/.test(value.params.response.url)) {
        this.methodNetwork.push({event: 'response', requestId: value.params.requestId, url: value.params.response.url, status: value.params.response.status, sessionId: value.sessionId});
      } else if (value.method === 'Network.requestWillBeSent' && /\/api\/runs\/[^/]+\/steer$/.test(value.params.request.url)) {
        this.directionNetwork.push({ requestId: value.params.requestId, method: value.params.request.method, status: null, finished: false });
      } else if (value.method === 'Network.responseReceived' && /\/api\/runs\/[^/]+\/steer$/.test(value.params.response.url)) {
        const request = this.directionNetwork.find(item => item.requestId === value.params.requestId); if (request) request.status = value.params.response.status;
      } else if (value.method === 'Network.loadingFinished') {
        const request = this.directionNetwork.find(item => item.requestId === value.params.requestId); if (request) request.finished = true;
        const conversation = this.conversationNetwork.find(item => item.requestId === value.params.requestId); if (conversation) conversation.finished = true;
      }
    });
    socket.addEventListener('close', () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Owned browser closed.')); } this.pending.clear(); });
  }
  static async connect(url, signal) {
    const socket = new WebSocket(url), cdp = new CDP(socket, signal);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Timed out connecting to the owned browser’s CDP endpoint.')); }, 12000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot connect to the owned browser’s CDP endpoint.')); }, { once: true });
    });
    return cdp;
  }
  call(method, params = {}, sessionId, { cleanup = false } = {}) {
    if (!cleanup && this.signal.aborted) return Promise.reject(this.signal.reason);
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Owned browser CDP connection is not open.'));
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out.`)); }, cleanup ? 3000 : 15000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.socket.close(); }
}

export async function run(options) {
  if (options.help) { process.stdout.write('node scripts/planning-remote-ui-qa.mjs [--candidate PATH] [--out PATH] [--edge PATH] [--timeout-ms 180000]\nRuns only an owned, disposable fake-model server and headless browser. No account, provider, existing browser, desktop window or persistent service is used.\n'); return; }
  const candidate = path.resolve(options.candidate), out = path.resolve(options.out), browserPath = await findBrowser(options.edge);
  await fs.mkdir(out, { recursive: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-planning-remote-ui-')), cwd = path.join(root, 'workspace'), dataDir = path.join(root, 'data'), profile = path.join(root, 'browser-profile');
  await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, 'qa-source.txt'), SOURCE);
  const report = { suite: 'BLACKICE Planning, remote access and contained browser UI', startedAt: new Date().toISOString(), platform: process.platform, candidate, appFingerprintBefore: null, appFingerprintAfter: null, unchangedDuringChecks: false, checks: [], screenshots: [], measurements: [], recovery: {}, browser: browserPath, fixture: 'Real application, saved task store, remote manager and desktop lifecycle with deterministic local model, contained browser and Tailscale fixtures', features: Object.fromEntries(REQUIRED_FEATURES.map(name => [name, false])), limitations: ['Password manager UI uses the real local routes, vault and mirror with an injected AES-256-GCM test store and synthetic logins. Its protected-backend and temporary-folder adapters are test doubles, not DPAPI or Windows ACL evidence. The native browser-open and file-reveal callbacks only inspect the owned synthetic CSV; no actual browser import or account is used.', 'Chat Mode catalog/setup and saved-history rendering use controlled fixtures. The production transcript reader also runs against an owned Chromium DOM fixture with exact observed IDs. These checks make no ChatGPT request and do not prove a signed-in production completion.', 'Clipboard receipts use the production web UI and shared writer with browser-local denied, pending and selection-copy fixtures; no OS clipboard is read or written and no clipboard permission is changed.', 'Contained pages and blocker decisions are deterministic UI fixtures; native request interception has separate backend acceptance.', 'Shared ownership rendering uses a validated saved runtime fixture without starting extra agents.', 'This exercises the web UI in owned headless Edge/Chromium, not Electron window chrome.', 'Email consent uses the production OAuth manager with an owned loopback callback, ephemeral encrypted storage, a captured browser opener and deterministic token/profile responses. Six explicit CLI interface checks and three read-only mailbox calls return fixture output; no real email process or mailbox is opened.', 'No real provider, mailbox, browser login or external delivery is exercised.'], supplementaryRegressionFiles: VALIDATION_TESTS };
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(Error('Bounded UI acceptance deadline reached.')), options.timeoutMs);
  const ensure = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  const check = (name, value = true) => { assert.ok(value, name); report.checks.push(name); process.stdout.write(`PASS ${name}\n`); };
  const hashes = async () => Object.fromEntries(await Promise.all(SOURCES.map(async name => [name, createHash('sha256').update(await fs.readFile(path.join(candidate, name))).digest('hex')])));
  let app, browser, browserLog, cdp, session, origin, cookie, runtime, contained, remoteFixture, desktopLifecycle;
  const api = async (route, method = 'GET', body) => {
    ensure(); const response = await fetch(origin + route, { method, headers: { Cookie: cookie, ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    const data = await response.json(); if (!response.ok) throw Error(`${method} ${route}: ${JSON.stringify(data)}`); return data;
  };
  const evaluate = async (fn, ...args) => {
    ensure(); const value = await cdp.call('Runtime.evaluate', { expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true, userGesture: true }, session);
    if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result?.value;
  };
  const until = async (name, fn, limit = 9000) => { const end = Date.now() + limit; while (Date.now() < end) { ensure(); const value = await fn(); if (value) return value; await delay(75); } throw Error(`Timed out waiting for ${name}.`); };
  const visible = async selector => evaluate(selector => { const node = document.querySelector(selector); return Boolean(node && node.getClientRects().length && !node.closest('[hidden],[inert]')); }, selector);
  const waitVisible = selector => until(selector, () => visible(selector));
  const click = async selector => {
    const point = await evaluate(selector => { const node = document.querySelector(selector); if (!node || node.disabled) throw Error(`Missing or disabled target ${selector}`); node.scrollIntoView({ block: 'center', inline: 'nearest' }); const box = node.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2, front = document.elementFromPoint(x, y); if (selector === '#planning-save') globalThis.__qaPlanningObjectiveSave?.capture('click-geometry', { x, y, selector }); if (!box.width || !box.height || node.closest('[hidden],[inert]') || !node.contains(front)) throw Error(`Covered or hidden target ${selector}`); return { x, y }; }, selector);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.call('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point }, session);
  };
  const fill = async (selector, text) => {
    await evaluate(selector => { const node = document.querySelector(selector); if (!node || node.disabled) throw Error(`Missing field ${selector}`); node.scrollIntoView({ block: 'center' }); node.focus(); node.select(); }, selector);
    await cdp.call('Input.insertText', { text }, session);
    assert.equal(await evaluate(selector => document.querySelector(selector).value, selector), text);
  };
  const select = async (selector, value) => evaluate((selector, value) => { const node = document.querySelector(selector); if (!node || node.disabled) throw Error(`Missing selection ${selector}`); node.value = value; if (node.value !== value) throw Error(`Missing option ${value}`); node.dispatchEvent(new Event('change', { bubbles: true })); }, selector, value);
  const frames = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const key = async (value, code, virtualCode, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: value, code, windowsVirtualKeyCode: virtualCode, modifiers }, session); };
  const openChat = async id => {
    const selector = `#conversation-sidebar [data-mission-action="open-run"][data-id="${id}"]`;
    if (!await visible(selector) && await visible('#conversation-sidebar-toggle')) await click('#conversation-sidebar-toggle');
    await waitVisible(selector); await click(selector);
    await until('the selected conversation turn and completed history navigation', () => evaluate(id => Boolean(document.querySelector(`#conversation-dialogue .conversation-turn[data-run-id="${id}"]`)) && !/Loading conversation/.test(document.querySelector('#conversation-composer-status')?.textContent || ''), id));
  };
  const composer = () => evaluate(() => { const input = document.querySelector('#mission-task'), button = document.querySelector('#mission-start-button'); return { draft: input.value, readOnly: input.readOnly, mode: button.dataset.mode, disabled: button.disabled, error: document.querySelector('#mission-error').textContent.trim(), scrollTop: input.scrollTop, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd, focused: document.activeElement === input, runIds: [...document.querySelectorAll('#conversation-dialogue .conversation-turn')].map(turn => turn.dataset.runId) }; });
  const composerControlGeometry = async () => {
    await frames();
    return evaluate(() => {
      const selectors = { options: '#mission-options > summary', attach: '#conversation-attach', model: '.conversation-model-choice .model-picker-button', reasoning: '#mission-context > summary', planning: '.conversation-planning-choice', send: '#mission-start-button' };
      if (document.querySelector('#conversation-stop') && !document.querySelector('#conversation-stop').hidden) selectors.stop = '#conversation-stop';
      const bounds = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const inspect = (name, selector) => {
        const node = document.querySelector(selector); if (!node) return { name, missing: true, visible: false, hit: false };
        const rect = bounds(node), style = getComputedStyle(node), visible = node.getClientRects().length > 0 && !node.closest('[hidden],[inert]') && style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0 && rect.width >= 28 && rect.height >= 32 && rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1;
        const front = visible && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { name, rect, visible, hit: Boolean(front && node.contains(front)) };
      };
      const controls = Object.entries(selectors).map(([name, selector]) => inspect(name, selector)), intersections = [];
      for (let a = 0; a < controls.length; a++) for (let b = a + 1; b < controls.length; b++) {
        const first = controls[a], second = controls[b]; if (!first.rect || !second.rect) continue;
        const width = Math.max(0, Math.min(first.rect.right, second.rect.right) - Math.max(first.rect.left, second.rect.left)), height = Math.max(0, Math.min(first.rect.bottom, second.rect.bottom) - Math.max(first.rect.top, second.rect.top));
        if (width > .5 && height > .5) intersections.push({ first: first.name, second: second.name, width, height });
      }
      const planning = document.querySelector('#mission-planning-mode'), label = document.querySelector('.conversation-planning-choice > span'), summary = document.querySelector('#mission-context > summary');
      const labelRect = label && bounds(label), selectRect = planning && bounds(planning), planningRect = controls.find(item => item.name === 'planning')?.rect;
      const labelsVisible = Boolean(labelRect && selectRect && planningRect && label.textContent.trim() === 'Planning' && summary?.querySelector('.conversation-setting-label')?.textContent.trim() === 'Reasoning' && parseFloat(getComputedStyle(label).fontSize) >= 10 && selectRect.height >= 20 && labelRect.left >= planningRect.left && labelRect.right <= planningRect.right && labelRect.top >= planningRect.top && selectRect.bottom <= planningRect.bottom + 1);
      const selectFront = selectRect && document.elementFromPoint(selectRect.left + selectRect.width / 2, selectRect.top + selectRect.height / 2), planningHit = Boolean(selectFront && planning.contains(selectFront));
      return { width: innerWidth, planningMode: planning?.value, controls, intersections, labelsVisible, planningHit, controlsSeparated: controls.every(control => control.visible && control.hit) && intersections.length === 0 && labelsVisible && planningHit };
    });
  };
  const closeModal = async () => {
    if (await visible('#modal-root .modal')) await click('#modal-root [data-action="close-modal"]');
    await until('the current dialog to close', () => evaluate(() => !document.querySelector('#modal-root .modal')));
  };
  const menu = async action => {
    await closeModal();
    if (!await evaluate(() => document.querySelector('.workspace-menu').open)) await click('.workspace-menu > summary');
    const selector = `.workspace-menu [data-action="${action}"]`;
    await until(`the open workspace menu to expose ${action}`, () => evaluate(selector => {
      const node = document.querySelector(selector);
      if (document.querySelector('#modal-root .modal') || !document.querySelector('.workspace-menu').open || !node || node.disabled || node.closest('[hidden],[inert]')) return false;
      node.scrollIntoView({ block: 'center', inline: 'nearest' });
      const box = node.getBoundingClientRect(), front = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility === 'visible' && node.contains(front);
    }, selector));
    await click(selector);
  };
  const cards = async () => { await menu('agent-workspace'); await waitVisible('.priority-workspace-grid'); };
  const resize = async (width, height = 900) => { await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, session); await delay(100); };
  const screenshot = async name => {
    await evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const value = await cdp.call('Page.captureScreenshot', { format: 'jpeg', quality: 85, fromSurface: true, captureBeyondViewport: false }, session), file = path.join(out, name);
    await fs.writeFile(file, Buffer.from(value.data, 'base64')); report.screenshots.push(file);
  };
  const geometry = async label => {
    const value = await evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, modal: (() => { const node = document.querySelector('#modal-root .modal'); if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; })() }));
    report.measurements.push({ label, ...value }); return value.document <= value.width + 2 && value.body <= value.width + 2 && (!value.modal || value.modal.left >= -1 && value.modal.right <= value.width + 1);
  };
  try {
    report.before = await hashes(); report.appFingerprintBefore = await appFingerprint(candidate);
    const { createHarnessServer } = await import(pathToFileURL(path.join(candidate, 'server.mjs')).href);
    runtime = new WorkspaceFixtureRuntime(cwd);
    const { AgentEmailStore } = await import(pathToFileURL(path.join(candidate, 'lib/agent-email.mjs')).href), cliCalls = [];
    const emailFixture = await createEmailOAuthFixture({ candidate, dataDir, cliCalls });
    const email = await new AgentEmailStore({ dataDir, oauth: emailFixture.manager, runner: emailFixture.runner }).init();
    report.emailCliCalls = cliCalls;
    const { RemoteAccessManager } = await import(pathToFileURL(path.join(candidate, 'lib/remote-access.mjs')).href), { createRemoteTransportFixture } = await import(pathToFileURL(path.join(candidate, 'tests/fixtures/remote-transport.mjs')).href), { DesktopLifecycle } = await import(pathToFileURL(path.join(candidate, 'desktop/lifecycle.mjs')).href);
    remoteFixture = createRemoteTransportFixture(); const remoteAccess = new RemoteAccessManager({ dataDir, transport: remoteFixture.transport, defaultHttpsPort: 8443 });
    const fixtureWindow = { visible: true, isDestroyed: () => false, isVisible() { return this.visible; }, isMinimized: () => false, show() { this.visible = true; }, hide() { this.visible = false; }, focus() {} };
    desktopLifecycle = new DesktopLifecycle({ getWindow: () => fixtureWindow, createWindow: async () => fixtureWindow, quit() { throw Error('The UI fixture must not quit its server.'); } }); await desktopLifecycle.start();
    contained = new ContainedBrowserFixture();
    const emailClientHandoffs = [];
    const emailClient = { status: async () => ({ id: 'thunderbird', name: 'Thunderbird', available: true, supported: true, capabilities: { open: true, compose: true }, handoff: 'native-app', accountReuse: false }), open: async ({ action }) => { assert.ok(['open', 'compose'].includes(action)); emailClientHandoffs.push(action); return { requested: true, action, application: 'Thunderbird', nativeWindow: true, windowVerified: false, sent: false }; }, close() {} };
    const passwordFixture = createPasswordManagerUIFixture({ dataDir });
    app = await createHarnessServer({ port: 0, dataDir, defaultCwd: cwd, runtime, email, emailClient, emailOAuth: emailFixture.manager, emailExecutableHint: process.execPath, autoAttachDesktop: false, ...disabledControllers(), browser: contained, remoteAccess, desktopLifecycle, ...passwordFixture.options });
    await app.learning.updateSettings({ mode: 'manual' });
    origin = await app.listen(); const home = await fetch(origin); cookie = home.headers.get('set-cookie').split(';', 1)[0]; await home.arrayBuffer();
    const status = await api('/api/status'); report.version = status.version;
    check('The server owns disposable task storage and uses only the explicit local fixture model', status.qaFixture === true && status.cwd === cwd && !status.providers.length && app.engine.listRuns().length === 0);
    browserLog = await fs.open(path.join(out, 'headless-browser.log'), 'w');
    browser = spawn(browserPath, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--disable-extensions', '--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE 127.0.0.1', '--window-size=1440,900', ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', browserLog.fd] });
    report.ownedBrowserPid = browser.pid; let spawnError; browser.on('error', error => { spawnError = error; });
    const endpoint = await until('the owned browser endpoint', async () => { if (spawnError) throw spawnError; if (browser.exitCode !== null) throw Error(`Browser exited: ${browser.exitCode}`); try { const [port, url] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/); return /^\d+$/.test(port) && url?.startsWith('/devtools/browser/') && `ws://127.0.0.1:${port}${url}`; } catch { return false; } }, 25000);
    cdp = await CDP.connect(endpoint, controller.signal);
    const target = await cdp.call('Target.createTarget', { url: 'about:blank' }); session = (await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await Promise.all([cdp.call('Page.enable', {}, session), cdp.call('Runtime.enable', {}, session), cdp.call('Log.enable', {}, session), cdp.call('Network.enable', {}, session)]);
    await resize(1440); await cdp.call('Page.navigate', { url: origin + '/' }, session); await waitVisible('#mission-task');
    await cards();
    const vectorAssets = await evaluate(async () => {
      const names = ['blackice-field.svg', 'blackice-wordmark.svg'];
      return Promise.all(names.map(async name => { const response = await fetch('/assets/' + name); const source = await response.text(); return { name, served: response.ok && /image\/svg\+xml/.test(response.headers.get('content-type') || ''), vectorOnly: /<svg\b/.test(source) && !/<(?:image|script|foreignObject)\b|data:image/i.test(source) }; }));
    });
    const surfaces = await evaluate(() => ({ scene: getComputedStyle(document.body).backgroundImage, readings: [...document.querySelectorAll('.agent-workspace-modal,.priority-workspace-card')].map(node => getComputedStyle(node).backgroundImage) }));
    check('The active scene and geometric wordmark are served as editable vector SVG without embedded raster content', vectorAssets.every(asset => asset.served && asset.vectorOnly) && /blackice-field\.svg/.test(surfaces.scene) && !/\.(?:png|jpe?g|webp)/i.test(surfaces.scene));
    check('Workspace cards and dialogs use gradient reading surfaces without repeating the scene', surfaces.readings.length === 6 && surfaces.readings.every(image => /gradient\(/.test(image) && !/blackice-field\.svg/.test(image)));
    report.visual = { vectorAssets, sceneUsesSvg: true, gradientSurfaceCount: surfaces.readings.length, repeatedSceneInReadingPanels: false };
    const titles = await evaluate(() => [...document.querySelectorAll('.priority-workspace-card strong')].map(node => node.textContent.trim()));
    check('Five workspace cards expose browser, email, Planning, swarm projects, and schedules', JSON.stringify(titles) === JSON.stringify(['Background browser', 'Email', 'Planning', 'Swarm projects', 'Schedules & jobs']));
    check('The workspace describes actual availability without offering a Bridge or arbitrary Windows applications', await evaluate(() => { const text = document.querySelector('.agent-workspace-modal').textContent; return /unavailable/i.test(text) && /Setup required/.test(text) && !/ChatGPT Bridge|Windows apps|arbitrary Windows|any Windows/i.test(text); }));
    check('The workspace menu omits retired Bridge and desktop launch entries', await evaluate(() => ![...document.querySelectorAll('.workspace-menu button')].some(node => /bridge|launch.*Windows|Windows apps/i.test(node.textContent) || ['chatgpt-bridge', 'desktop', 'attach-desktop'].includes(node.dataset.action))));
    check('Desktop workspace cards fit their viewport', await geometry('1440px workspace')); await screenshot('01-workspace-desktop.jpg');
    await resize(390, 844); check('The five workspace cards remain usable without horizontal overflow at 390px', await geometry('390px workspace')); await screenshot('02-workspace-mobile.jpg'); await resize(1440);
    const workspaceStates = () => evaluate(() => Object.fromEntries(['projects', 'operations'].map(action => { const node = document.querySelector(`.priority-workspace-card[data-action="${action}"] em`); return [action, { text: node.textContent.trim(), ready: node.classList.contains('available') }]; })));
    await api('/api/inbox/pause', 'POST', { reason: 'Owned UI fixture: verify a paused dispatcher is described honestly.' }); runtime.emit('status');
    await until('the paused dispatcher card', async () => { await cards(); return !(await workspaceStates()).operations.ready; });
    const pausedDispatch = await api('/api/status'), pausedCards = await workspaceStates();
    check('A healthy scheduler with a paused dispatcher is shown as paused, not ready', pausedDispatch.operations.healthy === true && pausedDispatch.operations.paused === false && Boolean(pausedDispatch.operations.blockedReason) && !pausedCards.operations.ready && /Paused/.test(pausedCards.operations.text));
    await app.beginMaintenance();
    let maintenanceStatus, maintenanceCards;
    try {
      runtime.emit('status'); await until('the paused project card', async () => { await cards(); return !(await workspaceStates()).projects.ready; });
      maintenanceStatus = await api('/api/status'); maintenanceCards = await workspaceStates();
      check('Healthy swarm projects expose the application execution hold while keeping plans and history available', maintenanceStatus.projects.healthy === true && Boolean(maintenanceStatus.projects.blockedReason) && !maintenanceCards.projects.ready && /Execution paused.*plans and history available/.test(maintenanceCards.projects.text) && runtime.calls.length === 0);
      await screenshot('11-workspace-paused-desktop.jpg');
    } finally { app.endMaintenance(); await api('/api/operations/resume', 'POST', { resumeInbox: true }); runtime.emit('status'); }
    await until('workspace execution to be available again', async () => { await cards(); const value = await workspaceStates(); return value.projects.ready && value.operations.ready; });
    const resumedCards = await workspaceStates();
    check('Clearing the owned execution holds restores workspace availability without dispatching work', resumedCards.projects.ready && resumedCards.operations.ready && runtime.calls.length === 0 && app.engine.executionStatus().activeCount === 0);
    report.recovery.workspace = { pausedDispatcher: { healthy: pausedDispatch.operations.healthy, paused: pausedDispatch.operations.paused, blockedReason: pausedDispatch.operations.blockedReason, card: pausedCards.operations }, maintenance: { healthy: maintenanceStatus.projects.healthy, blockedReason: maintenanceStatus.projects.blockedReason, card: maintenanceCards.projects }, resumedCards, blockedCardsAccurate: !pausedCards.operations.ready && !maintenanceCards.projects.ready && resumedCards.projects.ready && resumedCards.operations.ready };
    await click('.priority-workspace-card[data-action="contained-browser"]'); await waitVisible('#observe-workspace');
    check('Background browser navigation opens Activity without launching or foregrounding a browser session', runtime.calls.length === 0 && app.browser.status().tabs.length === 0 && await evaluate(() => !document.querySelector('#observe-workspace').hidden));
    await cards(); await click('.priority-workspace-card[data-action="planning"]'); await waitVisible('#planning-empty');
    await until('the loaded empty Planning catalog', () => evaluate(() => document.querySelector('#planning-catalog-status')?.textContent === '0 active plans'));
    const initialPlanning = report.recovery.initialPlanning = await evaluate(() => ({ workspaceVisible: !document.querySelector('#planning-workspace').hidden, heading: document.querySelector('.planning-heading-copy').textContent, emptyText: document.querySelector('#planning-empty').textContent, emptyVisible: !document.querySelector('#planning-empty').hidden, catalogStatus: document.querySelector('#planning-catalog-status').textContent, listedPlans: document.querySelectorAll('[data-planning-task]').length, taskEditor: Boolean(document.querySelector('#planning-editor-form')), loadError: document.querySelector('#planning-load-status').textContent }));
    check('Planning opens its dedicated saved workspace before a conversation exists without inventing a plan', initialPlanning.workspaceVisible && initialPlanning.emptyVisible && /Organize your plans/.test(initialPlanning.heading) && /Open a saved chat plan/.test(initialPlanning.emptyText) && initialPlanning.listedPlans === 0 && !initialPlanning.taskEditor && !initialPlanning.loadError && (await api('/api/planning')).total === 0 && runtime.calls.length === 0);
    await cards(); await click('.priority-workspace-card[data-action="projects"]'); await waitVisible('#projects-workspace');
    check('Swarm projects opens the saved project workspace with an explicit Planning entry and no Methods workflow', await evaluate(() => /Swarm projects/.test(document.querySelector('#projects-workspace').textContent) && Boolean(document.querySelector('#projects-workspace [data-project="planning"]')) && !document.querySelector('#projects-workspace [data-project="new-method"],#projects-workspace [data-project="browse-methods"]')));
    check('Inspecting projects and Planning starts no agent work', runtime.calls.length === 0 && app.projects.list().length === 0);
    await cards(); await click('.priority-workspace-card[data-action="operations"]'); await waitVisible('#operations-view [data-op="schedule"]');
    check('Schedules and jobs exposes the actual controls and open-app/restart limitations', await evaluate(() => /BLACKICE must stay open/.test(document.querySelector('#operations-view').textContent) && /Missed times are skipped/.test(document.querySelector('#operations-view').textContent) && Boolean(document.querySelector('[data-op="schedule"]'))));
    await click('[data-op="schedule"]'); await waitVisible('#deployment-form'); await fill('#deployment-form [name="input"]', 'QA disabled schedule: inspect the owned local fixture.'); await select('#deployment-form [name="trigger"]', 'cron'); await fill('#deployment-form [name="expression"]', '0 9 * * MON-FRI'); await fill('#deployment-form [name="timezone"]', 'America/New_York');
    await evaluate(() => { const box = document.querySelector('#deployment-form [name="enabled"]'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); });
    await until('cron preview', () => evaluate(() => /Next|9:00|9 AM/i.test(document.querySelector('#deployment-preview')?.textContent || '') && !document.querySelector('#deployment-error')?.textContent.trim()));
    check('Calendar cron previews a named timezone before saving a disabled schedule', (await api('/api/operations/schedule-preview', 'POST', { trigger: { type: 'cron', expression: '0 9 * * MON-FRI', timezone: 'America/New_York' } })).occurrences?.length > 0);
    await click('#deployment-form [type="submit"]'); await waitVisible('#operations-view');
    const scheduled = (await api('/api/operations')).deployments.find(item => item.input.startsWith('QA disabled schedule:'));
    check('Saving a disabled cron retains its expression and timezone without dispatching a job', scheduled && scheduled.enabled === false && scheduled.trigger.type === 'cron' && scheduled.trigger.timezone === 'America/New_York' && runtime.calls.length === 0);
    await menu('swarm'); await waitVisible('#swarm-form'); await fill('#swarm-form [name="name"]', 'QA three-specialist team'); await fill('#swarm-form [name="members"]', '3'); await select('#swarm-form [name="model"]', 'fixture-model'); await click('#swarm-form [type="submit"]');
    // Saving completes before the async adoption opens its task prompt. Wait
    // for that promised UI destination before closing it to navigate elsewhere.
    await until('the saved specialist team task prompt', () => evaluate(() => {
      const form = document.querySelector('#run-form');
      return form?.dataset.destination === 'mission' && form.getClientRects().length > 0 && !document.querySelector('#swarm-form') && /QA three-specialist team/.test(form.querySelector('.footer-note')?.textContent || '');
    }));
    const workflowData = await api('/api/workflows'), swarm = (Array.isArray(workflowData) ? workflowData : workflowData.workflows).find(item => item.name === 'QA three-specialist team');
    check('Swarm generation saves three independent specialists followed by one coordinator without starting work', swarm && swarm.nodes.filter(node => node.type === 'agent').length === 4 && swarm.edges.filter(edge => edge.target === 'coordinator').length === 3 && swarm.planning?.shared === true && swarm.nodes.filter(node => node.type === 'agent' && node.id !== 'coordinator').every(node => node.assignment?.canWrite === false && node.sandbox === 'read-only') && runtime.calls.length === 0);

    await emailJourney({ api, app, runtime, report, emailClientHandoffs, evaluate, waitVisible, until, click, fill, menu, cards, check, screenshot, geometry, resize, cliCalls, cwd });
    await emailOAuthJourney({ api, report, emailFixture, cliCalls, evaluate, waitVisible, until, click, fill, select, menu, check, screenshot, geometry, resize, frames, key });
    await emailReaderUIJourney({ api, report, emailFixture, cliCalls, evaluate, waitVisible, until, click, fill, select, menu, check, screenshot, geometry, resize });
    await knowledgeUIJourney({ api, report, cwd, evaluate, waitVisible, until, click, fill, select, menu, check, screenshot, geometry, resize });

    await closeModal(); await click('#workspace-modes [data-mode="view"]'); await waitVisible('#mission-task');
    // A newly generated swarm is only a saved draft. Start a fresh plain chat so
    // the six runtime fixtures exercise one coordinator each, not the swarm.
    const newChat = await evaluate(() => [...document.querySelectorAll('[data-mission-action="new-task"]')].find(node => node.getClientRects().length)?.outerHTML || null);
    if (newChat) await click('[data-mission-action="new-task"]');
    const modeChoices = await evaluate(() => [...document.querySelector('#mission-planning-mode').options].map(option => option.value));
    check('Planning exposes Maximal, On, Auto and Off with a current description', JSON.stringify(modeChoices) === JSON.stringify(['maximal','on','auto','off']));
    const modeNotes = {};
    for (const mode of modeChoices) { await select('#mission-planning-mode', mode); modeNotes[mode] = await evaluate(() => document.querySelector('#mission-planning-note').textContent.trim()); }
    check('Every planning choice explains its actual behavior before dispatch', Object.values(modeNotes).every(note => note.length > 20) && new Set(Object.values(modeNotes)).size === 4 && runtime.calls.length === 0);
    check('A configured new chat has a single invitation and no repeated ready card or process rail', await evaluate(() => document.querySelector('#conversation-welcome-status').hidden && !document.querySelector('.blackice-welcome-rail') && document.querySelectorAll('.blackice-welcome-copy h1').length === 1));
    check('The welcome invitation aligns with its composer', await evaluate(() => Math.abs(document.querySelector('.blackice-welcome-copy').getBoundingClientRect().left - document.querySelector('.conversation-composer').getBoundingClientRect().left) < 20));
    await screenshot('15-new-chat-desktop.jpg');
    await resize(390, 844);
    check('New chat remains readable and its composer stays within the narrow viewport', await evaluate(() => {
      const welcome = document.querySelector('.blackice-workbench-welcome').getBoundingClientRect(), compose = document.querySelector('.conversation-composer').getBoundingClientRect();
      return welcome.left >= 0 && welcome.right <= innerWidth && compose.left >= 0 && compose.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth + 1;
    }));
    await screenshot('18-new-chat-mobile.jpg'); await resize(1440, 900);
    await select('#mission-planning-mode', 'on');
    await fill('#mission-task', 'QA planned task: read qa-source.txt and save a checked local result.'); await click('#mission-start-button');
    await until('the deliberately early answer', () => runtime.stage === 'before-plan'); await waitVisible('#mission-plan');
    check('The task pane appears before the answer, with no invented actions or leaked early text', await evaluate(preplan => /Preparing the plan|A clear approach comes first/.test(document.querySelector('#mission-plan').textContent) && !document.querySelector('#conversation-dialogue').textContent.includes(preplan), PREPLAN));
    runtime.planGate.resolve(); await until('the durable plan and note', () => runtime.stage === 'planned');
    await until('live action rows', () => evaluate(() => document.querySelectorAll('#mission-plan [data-plan-node]').length === 2 && /1\s*\/\s*2/.test(document.querySelector('.task-plan-progress-copy').textContent)));
    check('The agent-authored plan displays manageable dependent steps and actual checked progress before its final result', await evaluate(final => !document.querySelector('#conversation-dialogue').textContent.includes(final) && /Save and check the local result/.test(document.querySelector('#mission-plan').textContent), FINAL));
    await click('#mission-plan [data-plan-node="save"]');
    const disclosure = await evaluate(() => document.querySelector('#mission-plan [data-plan-action="details"]')?.getAttribute('aria-expanded'));
    if (disclosure === 'false') await click('#mission-plan [data-plan-action="details"]');
    check('The plan inspector retains the working note and next action with its task', await evaluate(note => document.querySelector('#mission-plan').textContent.includes(note), NOTE) && app.engine.listRuns()[0].taskState.checkpoint.nextAction.includes('qa-result.txt'));
    check('An unfinished step distinguishes its expected result from observed evidence', await evaluate(expected => { const inspector = document.querySelector('#mission-plan .task-plan-inspector'), labels = [...inspector.querySelectorAll('dt')].map(node => node.textContent.trim()); return inspector.textContent.includes(expected) && labels.includes('Expected result') && !labels.includes('Result') && !labels.includes('Evidence'); }, EXPECTED_RESULT));
    check('The plan and conversation fit side by side at 1440px', await geometry('1440px planned task')); await screenshot('04-task-plan-desktop.jpg');
    const layoutBefore = await evaluate(() => ({ conversation: document.querySelector('#conversation-dialogue').getBoundingClientRect().width, plan: document.querySelector('#mission-plan').getBoundingClientRect().width }));
    check('The desktop conversation receives more width than the supporting plan', layoutBefore.conversation >= layoutBefore.plan * 1.4);
    await fill('#mission-task', 'QA layout draft: preserve this while changing panes.');
    await click('#conversation-plan-toggle'); await frames();
    const collapsedLayout = await evaluate(() => ({ planHidden: document.querySelector('#mission-plan').hidden, planInert: document.querySelector('#mission-plan').inert, width: document.querySelector('#conversation-dialogue').getBoundingClientRect().width, draft: document.querySelector('#mission-task').value, expanded: document.querySelector('#conversation-plan-toggle').getAttribute('aria-expanded'), focus: document.activeElement.id, saved: localStorage.getItem('relay.ui.plan.collapsed') }));
    check('Hide Plan frees the full reading area while preserving the draft and keyboard focus', collapsedLayout.planHidden && collapsedLayout.planInert && collapsedLayout.width > layoutBefore.conversation + 250 && collapsedLayout.draft === 'QA layout draft: preserve this while changing panes.' && collapsedLayout.expanded === 'false' && collapsedLayout.focus === 'conversation-plan-toggle' && collapsedLayout.saved === 'true');
    await screenshot('16-focused-conversation-desktop.jpg');
    await click('#conversation-plan-toggle'); await frames();
    check('Show Plan restores the saved steps and leaves the message untouched', await evaluate(() => !document.querySelector('#mission-plan').hidden && document.querySelectorAll('#mission-plan [data-plan-node]').length === 2 && document.querySelector('#mission-task').value === 'QA layout draft: preserve this while changing panes.'));
    const chatLayouts = [];
    for (const width of [320, 390, 768, 1180, 1440, 1920]) {
      await resize(width, width <= 390 ? 844 : 900);
      if (width < 1180) await click('#conversation-dialogue-tab');
      const controls = await composerControlGeometry(); chatLayouts.push(controls);
      check(`Message, Planning, Reasoning and Stop controls are separate and reachable at ${width}px`, controls.controlsSeparated && await geometry(`${width}px working chat`));
      if (width === 390) await screenshot('17-working-chat-mobile.jpg');
      if (width < 1180) await click('#conversation-plan-tab');
    }
    await resize(390, 844); await click('#conversation-dialogue-tab');
    await click('#mission-context > summary'); await waitVisible('#mission-effort');
    check('Reasoning opens above the composer inside the narrow viewport', await evaluate(() => { const box = document.querySelector('.conversation-context-panel').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }));
    await key('Escape', 'Escape', 27);
    check('Closing Reasoning restores keyboard focus to its own trigger', await evaluate(() => !document.querySelector('#mission-context').open && document.activeElement === document.querySelector('#mission-context > summary')));
    await click('#mission-options > summary'); await waitVisible('#mission-cwd');
    check('Options retains one working-folder field and the current planning explanation', await evaluate(() => { const box = document.querySelector('.conversation-options-panel').getBoundingClientRect(); return document.querySelectorAll('#mission-cwd').length === 1 && !document.querySelector('#conversation-folder-chip') && document.querySelector('#mission-planning-note').textContent.trim().length > 20 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }));
    await key('Escape', 'Escape', 27); await click('#conversation-plan-tab'); await resize(1440);
    await fill('#mission-task', '');
    report.chatLayout = { before: layoutBefore, collapsed: collapsedLayout, breakpoints: chatLayouts, draftPreserved: true, keyboardRestored: true };
    await click('#mission-plan [data-plan-action="view-map"]'); await waitVisible('#mission-plan .task-plan-map-viewport');
    const mapIds = await evaluate(() => [...document.querySelectorAll('#mission-plan [data-plan-map-node]')].map(node => node.dataset.planMapNode).sort());
    check('The mind map renders the saved goal, exact action IDs and dependency relationship', JSON.stringify(mapIds) === JSON.stringify(['inspect','save']) && await evaluate(() => Boolean(document.querySelector('#mission-plan .task-plan-map-node.is-goal')) && Boolean(document.querySelector('#mission-plan .task-plan-map-edge[data-relation="dependency"][data-source-id="inspect"][data-target-id="save"]'))));
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }, session);
    const mapBounds = await evaluate(() => { const node = document.querySelector('#mission-plan [data-plan-map-node="save"]'); node.scrollIntoView({block: 'center', inline: 'nearest'}); const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mapBounds.x + mapBounds.width / 2, y: mapBounds.y + mapBounds.height / 2 }, session);
    await delay(250);
    check('Hover keeps translated SVG nodes in their saved map positions', await evaluate(before => { const r = document.querySelector('#mission-plan [data-plan-map-node="save"]').getBoundingClientRect(); return ['x','y','width','height'].every(key => Math.abs(r[key] - before[key]) < 1); }, mapBounds));
    await click('#mission-plan [data-plan-map-node="save"]');
    check('Selecting a map node opens the same saved working note and evidence inspector', await evaluate(note => document.querySelector('#mission-plan .task-plan-inspector').textContent.includes(note), NOTE));
    const mapWidth = await evaluate(() => document.querySelector('#mission-plan svg.task-plan-map').getAttribute('width'));
    await click('#mission-plan [data-plan-action="map-zoom-in"]');
    check('Map zoom changes the vector viewport while preserving saved node identities', Number(await evaluate(() => document.querySelector('#mission-plan svg.task-plan-map').getAttribute('width'))) > Number(mapWidth) && app.engine.listRuns()[0].taskState.steps.length === 2);
    await click('#mission-plan [data-plan-action="map-focus"]');
    check('Focusing a step narrows the map and keeps the saved whole plan intact', await evaluate(() => document.querySelectorAll('#mission-plan [data-plan-map-node]').length === 1 && document.querySelector('#mission-plan [data-plan-map-node="save"]') !== null) && app.engine.listRuns()[0].taskState.steps.length === 2);
    await click('#mission-plan [data-plan-action="map-reset"]'); await click('#mission-plan [data-plan-action="map-fit"]');
    const mapReadability = await evaluate(() => { const title = document.querySelector('#mission-plan .task-plan-map-title'), matrix = title.getScreenCTM(), canvas = document.querySelector('#mission-plan .task-plan-map-canvas'), style = getComputedStyle(canvas); return { titlePx: parseFloat(getComputedStyle(title).fontSize) * Math.hypot(matrix.a, matrix.b), internallyScrollable: ['auto','scroll'].includes(style.overflowX) && ['auto','scroll'].includes(style.overflowY) }; });
    check('Fit width preserves readable map labels and internal scrolling', mapReadability.titlePx >= 11 && mapReadability.internallyScrollable);
    check('Returning to the whole map restores both saved actions with keyboard-accessible controls', await evaluate(() => document.querySelectorAll('#mission-plan [data-plan-map-node]').length === 2 && Boolean(document.querySelector('#mission-plan [data-plan-map-node][role="button"][tabindex="0"]')) && document.querySelector('#mission-plan [data-plan-action="export-svg"]') !== null && document.querySelector('#mission-plan [data-plan-action="export-mm"]') !== null));
    await evaluate(() => document.querySelector('#mission-plan [data-plan-map-node="inspect"]').focus());
    for (const type of ['keyDown','keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, session);
    check('Keyboard activation selects the saved map step and its shared inspector', await evaluate(() => document.querySelector('#mission-plan [data-plan-map-node="inspect"]').classList.contains('is-selected') && /Inspect the local source note/.test(document.querySelector('#mission-plan .task-plan-inspector').textContent)));
    await click('#mission-plan [data-plan-map-node="save"]');
    await click('#mission-plan [data-plan-action="details"][aria-expanded="true"]');
    await click('#mission-plan [data-plan-action="map-fit"]');
    check('Hiding step details gives the map a clear reading area without losing selection', await evaluate(() => document.querySelector('#mission-plan [data-plan-action="details"]').getAttribute('aria-expanded') === 'false' && document.querySelector('#mission-plan [data-plan-map-node="save"]').classList.contains('is-selected')));
    const zoomState = () => evaluate(() => { const maximum = document.querySelector('#mission-plan [data-plan-action="map-zoom-in"]'), minimum = document.querySelector('#mission-plan [data-plan-action="map-zoom-out"]'), fit = document.querySelector('#mission-plan [data-plan-action="map-fit"]'), active = document.activeElement; return { maximumDisabled: maximum.disabled, minimumDisabled: minimum.disabled, label: fit.textContent.trim(), focusAction: active?.dataset.planAction || null, focusEnabled: Boolean(active && !active.disabled && active.getClientRects().length && !active.closest('[hidden],[inert]')) }; });
    for (let index = 0; index < 14 && !(await zoomState()).maximumDisabled; index++) await click('#mission-plan [data-plan-action="map-zoom-in"]');
    const zoomMaximum = await zoomState();
    check('Reaching maximum map zoom transfers focus to the enabled Fit width control', zoomMaximum.maximumDisabled && zoomMaximum.focusEnabled && zoomMaximum.focusAction === 'map-fit');
    await evaluate(() => { const canvas = document.querySelector('#mission-plan .task-plan-map-canvas'); globalThis.__blackiceQAOldMapCanvas = canvas; canvas.scrollTo({ left: 0, top: 0, behavior: 'instant' }); canvas.focus({ preventScroll: true }); });
    await key('ArrowRight', 'ArrowRight', 39); await key('ArrowDown', 'ArrowDown', 40);
    const mapPan = () => evaluate(() => { const canvas = document.querySelector('#mission-plan .task-plan-map-canvas'); return { focused: document.activeElement === canvas, x: canvas.scrollLeft, y: canvas.scrollTop, width: canvas.clientWidth, height: canvas.clientHeight, scrollWidth: canvas.scrollWidth, scrollHeight: canvas.scrollHeight, previousCanvasDetached: !globalThis.__blackiceQAOldMapCanvas?.isConnected, saveStatus: document.querySelector('#mission-plan [data-plan-map-node="save"]').dataset.status }; });
    await until('native keyboard panning inside the map canvas', async () => { const value = await mapPan(); return value.focused && value.x > 0 && value.y > 0; });
    await delay(220); const mapBefore = await mapPan();
    runtime.mapUpdateGate.resolve(); await until('the saved fixture step update', () => runtime.stage === 'map-updated');
    await until('the updated blocked step in the rendered map', async () => (await mapPan()).saveStatus === 'blocked'); await frames();
    const mapAfter = await mapPan();
    const liveUpdatePreservedFocus = mapAfter.focused && mapAfter.previousCanvasDetached;
    const keyboardPanPreserved = Math.abs(mapAfter.x - mapBefore.x) <= 1 && Math.abs(mapAfter.y - mapBefore.y) <= 1;
    check('An actual saved-step update replaces the map while preserving its canvas focus and keyboard pan', liveUpdatePreservedFocus && keyboardPanPreserved && app.engine.listRuns()[0].taskState.steps.find(step => step.id === 'save').status === 'blocked');
    await key('ArrowRight', 'ArrowRight', 39); await key('ArrowDown', 'ArrowDown', 40);
    await until('keyboard panning after the streamed map update', async () => { const value = await mapPan(); return value.focused && value.x > mapAfter.x && value.y > mapAfter.y; });
    await delay(220); const afterKeyboardPan = await mapPan();
    check('The replacement map canvas continues to respond to real arrow-key panning', afterKeyboardPan.focused && afterKeyboardPan.x > mapAfter.x && afterKeyboardPan.y > mapAfter.y);
    await screenshot('12-map-focus-recovery-desktop.jpg');
    runtime.mapRestoreGate.resolve(); await until('the saved fixture step to resume', () => runtime.stage === 'planned-restored');
    await until('the resumed active step in the map', async () => (await mapPan()).saveStatus === 'active');
    for (let index = 0; index < 14 && !(await zoomState()).minimumDisabled; index++) await click('#mission-plan [data-plan-action="map-zoom-out"]');
    const zoomMinimum = await zoomState();
    check('Reaching minimum map zoom also keeps focus on an enabled Fit width control', zoomMinimum.minimumDisabled && zoomMinimum.focusEnabled && zoomMinimum.focusAction === 'map-fit');
    report.recovery.map = { before: mapBefore, afterUpdate: mapAfter, afterKeyboardPan, zoomMaximum, zoomMinimum, liveUpdatePreservedFocus, keyboardPanPreserved, enabledZoomFallback: zoomMaximum.focusEnabled && zoomMaximum.focusAction === 'map-fit' && zoomMinimum.focusEnabled && zoomMinimum.focusAction === 'map-fit' };
    await click('#mission-plan [data-plan-action="map-fit"]'); await evaluate(() => { delete globalThis.__blackiceQAOldMapCanvas; });
    check('The desktop mind map and shared inspector fit the workspace', await geometry('1440px mind map')); await screenshot('08-mind-map-desktop.jpg');
    report.mindMap = { savedNodeIds: mapIds, dependenciesVisible: true, sharedNotesVisible: true, focusPreservesTree: true, zoomChangesViewport: true, keyboardSelection: true, hoverPreservesPosition: true, readingTitlePx: mapReadability.titlePx, internallyScrollable: mapReadability.internallyScrollable };
    await click('#mission-plan [data-plan-action="view-outline"]');
    await resize(390, 844); await waitVisible('#conversation-plan-tab');
    check('At 390px Plan is the default reachable pane and Conversation is inert until selected', await evaluate(() => document.querySelector('#conversation-plan-tab').getAttribute('aria-selected') === 'true' && document.querySelector('#conversation-dialogue').inert) && await geometry('390px planned task'));
    if (!await visible('#mission-plan [data-plan-action="details"][aria-expanded="true"]')) await click('#mission-plan [data-plan-action="details"][aria-expanded="false"]');
    await waitVisible('#mission-plan [data-plan-action="details"][aria-expanded="true"]');
    await click('#mission-plan [data-plan-action="details"][aria-expanded="true"]');
    await waitVisible('#mission-plan [data-plan-action="view-map"]');
    check('Mobile step details return to the reachable outline and map controls', await evaluate(() => document.querySelector('#mission-plan [data-plan-action="details"]').getAttribute('aria-expanded') === 'false' && !document.querySelector('#mission-plan [data-plan-region="toolbar"]').inert));
    await screenshot('05-task-plan-mobile.jpg');
    await click('#mission-plan [data-plan-action="view-map"]'); await waitVisible('#mission-plan .task-plan-map-viewport');
    await click('#mission-plan [data-plan-action="map-fit"]');
    check('The mobile mind map can be reached and fits without page overflow', await geometry('390px mind map') && await evaluate(() => document.querySelector('#mission-plan [data-plan-action="view-map"]').getAttribute('aria-selected') === 'true'));
    await screenshot('09-mind-map-mobile.jpg');
    await click('#mission-plan [data-plan-action="view-outline"]');
    runtime.finalGate.resolve(); await until('the checked fixture result', () => app.engine.listRuns().some(run => run.status === 'completed' && run.settled));
    const completed = app.engine.listRuns().find(run => run.status === 'completed');
    const planAt = completed.events.findIndex(event => event.data?.type === 'task.state' && event.data.state.plan?.origin === 'agent'), firstAnswerAt = completed.events.findIndex(event => ['delta', 'message'].includes(event.data?.type));
    check('The final result follows its durable plan receipt and completion reflects two checked actions', planAt >= 0 && firstAnswerAt > planAt && completed.taskState.progress.done === 2 && completed.taskState.progress.complete === true && await fs.readFile(path.join(cwd, 'qa-result.txt'), 'utf8') === FINAL + '\n' + NOTE + '\n');
    await click('#conversation-dialogue-tab'); await until('final result in mobile conversation', () => evaluate(final => document.querySelector('#conversation-dialogue').textContent.includes(final), FINAL));
    check('The checked final answer remains readable in the mobile Conversation pane', await geometry('390px final answer')); await screenshot('06-result-mobile.jpg');
    await resize(1440); await fill('#mission-task', 'QA follow-up: exercise the explicit missing-plan error.'); await click('#mission-start-button');
    await until('the deliberately unplanned turn to fail', () => app.engine.listRuns().some(run => run.errorCode === 'TASK_PLAN_REQUIRED' && run.settled));
    await until('the honest missing-plan notice', () => evaluate(() => /answer was withheld/.test(document.querySelector('#conversation-dialogue').textContent)));
    check('An unplanned final answer fails visibly while its text remains withheld and prior completed work stays intact', await evaluate(text => !document.querySelector('#conversation-dialogue').textContent.includes(text), UNPLANNED) && app.engine.listRuns().some(run => run.errorCode === 'TASK_PLAN_REQUIRED' && run.nodes.agent.output === '' && run.taskState.steps.every(step => step.status === 'done')));
    await click('[data-mission-action="new-task"]');
    await fill('#mission-task', 'QA cancellation task: wait for a stop request and acknowledge it only when released.'); await click('#mission-start-button');
    await until('the cancellable fixture task', () => runtime.stage === 'cancel-running');
    const cancelRun = app.engine.listRuns().find(run => run.nodes.agent?.threadId === 'revised-ui-fixture-3'); assert.ok(cancelRun);
    const directionReady = () => evaluate(id => { const button = document.querySelector('#mission-start-button'), input = document.querySelector('#mission-task'); return button?.dataset.mode === 'steer' && !button.disabled && input && !input.readOnly && [...document.querySelectorAll('#conversation-dialogue .conversation-turn')].some(turn => turn.dataset.runId === id && turn.getClientRects().length); }, cancelRun.id);
    await until('the adopted task and live direction composer', directionReady);
    const otherRun = app.engine.listRuns().find(run => run.nodes.agent?.threadId === 'revised-ui-fixture-2'); assert.ok(otherRun);
    const errorDirection = 'QA direction: reject this owned request only after another draft is selected.';
    const newDraft = 'QA unsent new-chat draft: navigation must keep this text while another request waits.';
    const otherDraft = 'QA unsent existing-chat draft.\nThis text belongs only to this chat.\nThe other direction is still pending.\nKeep this fourth line.\nKeep the fifth line too.\nNo new model turn is requested.\nPreserve selection and scroll.\nThis is the end of the saved draft.';
    const sendDirection = async (text, count) => { await until('an editable live direction composer', directionReady); await fill('#mission-task', text); await frames(); await click('#mission-start-button[data-mode="steer"]'); await until(`owned direction request ${count}`, () => runtime.directionRequests === count && runtime.stage === 'direction-pending'); };
    const finishDirection = async (gate, count, status) => { gate.resolve(); await until(`the completed direction HTTP receipt ${count}`, () => cdp.directionNetwork[count - 1]?.finished && cdp.directionNetwork[count - 1].status === status); await frames(); };
    const sameDraftView = (before, after) => after.draft === before.draft && JSON.stringify(after.runIds) === JSON.stringify(before.runIds) && after.error === before.error && !after.readOnly && after.mode !== 'sending' && after.selectionStart === before.selectionStart && after.selectionEnd === before.selectionEnd && Math.abs(after.scrollTop - before.scrollTop) <= 1 && after.focused;
    await sendDirection(errorDirection, 1);
    await click('[data-mission-action="new-task"]');
    await until('a writable new chat while the original direction waits', async () => { const value = await composer(); return !value.readOnly && value.mode !== 'sending' && !value.runIds.includes(cancelRun.id); });
    await fill('#mission-task', newDraft); const newDraftState = await composer();
    const newDraftUsable = !newDraftState.readOnly && newDraftState.mode !== 'sending' && newDraftState.draft === newDraft && !newDraftState.runIds.includes(cancelRun.id);
    check('New chat stays reachable and writable while a different chat owns a held direction request', newDraftUsable && runtime.calls.length === 3 && runtime.directionSettlements.length === 0);
    await openChat(cancelRun.id); await until('the origin composer lock to return', async () => { const value = await composer(); return value.readOnly && value.disabled && value.mode === 'sending'; });
    const lockedOrigin = await composer(), originLockRestored = lockedOrigin.draft === errorDirection && lockedOrigin.readOnly && lockedOrigin.disabled && lockedOrigin.mode === 'sending';
    check('Returning to the request origin restores its exact draft, send lock and available Stop control', originLockRestored && await visible('#conversation-stop') && await evaluate(() => !document.querySelector('#conversation-stop').disabled));
    await openChat(otherRun.id); await until('the other saved chat to be editable', async () => !(await composer()).readOnly);
    await fill('#mission-task', otherDraft); await evaluate(() => { const input = document.querySelector('#mission-task'); input.setSelectionRange(3, 9); input.scrollTop = 0; }); await frames();
    const otherBeforeError = await composer();
    await finishDirection(runtime.navigationErrorGate, 1, 409);
    const otherAfterError = await composer(), otherDraftPreservedAfterError = sameDraftView(otherBeforeError, otherAfterError);
    check('A late direction failure leaves the selected other chat, draft, cursor, scroll and error unchanged', otherDraftPreservedAfterError && !otherAfterError.error.includes(DIRECTION_ERROR));
    await screenshot('13-direction-draft-preserved-desktop.jpg');
    await openChat(cancelRun.id); await until('the direction error in its originating chat', async () => (await composer()).error.includes(DIRECTION_ERROR));
    const failedOrigin = await composer(), lateErrorOwned = failedOrigin.error.includes(DIRECTION_ERROR) && failedOrigin.draft === errorDirection;
    const originRetryEnabled = failedOrigin.mode === 'steer' && !failedOrigin.disabled && !failedOrigin.readOnly;
    check('The originating chat retains the rejected direction and its error with an enabled retry', lateErrorOwned && originRetryEnabled);
    const acceptedDirection = 'QA direction: accept this owned request after the other saved draft is selected.';
    await sendDirection(acceptedDirection, 2); await openChat(otherRun.id);
    await until('the preserved other draft to return', async () => (await composer()).draft === otherDraft);
    await evaluate(() => { const input = document.querySelector('#mission-task'); input.focus({ preventScroll: true }); input.setSelectionRange(5, 12); input.scrollTop = 0; }); await frames();
    const otherBeforeSuccess = await composer(); await finishDirection(runtime.navigationSuccessGate, 2, 200);
    const otherAfterSuccess = await composer(), lateSuccessPreservedOtherDraft = sameDraftView(otherBeforeSuccess, otherAfterSuccess);
    check('A late accepted direction clears only its submitted origin draft and leaves the current other draft in place', lateSuccessPreservedOtherDraft);
    await openChat(cancelRun.id); await until('the accepted origin draft to clear', async () => { const value = await composer(); return value.draft === '' && !value.error && value.mode === 'steer' && !value.readOnly; });
    report.recovery.directions = { originRunId: cancelRun.id, otherRunId: otherRun.id, newDraftUsable, originLockRestored, lateErrorOwned, otherDraftPreservedAfterError, lateSuccessPreservedOtherDraft, originRetryEnabled, originAcceptedDraftCleared: (await composer()).draft === '', otherBeforeError, otherAfterError, otherBeforeSuccess, otherAfterSuccess };
    const directionText = 'QA direction: this request deliberately waits while Stop remains available.';
    await fill('#mission-task', directionText);
    await evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await until('the exact direction draft in the ready composer', async () => await directionReady() && await evaluate(text => document.querySelector('#mission-task').value === text, directionText));
    await click('#mission-start-button[data-mode="steer"]');
    await until('the deliberately held direction request', () => runtime.stage === 'direction-pending' && runtime.directionRequests === 3);
    check('Stop stays available while a direction request is pending', await evaluate(() => { const button = document.querySelector('#conversation-stop'); return Boolean(button && !button.disabled && button.getClientRects().length); }));
    await click('#conversation-stop');
    await until('cancellation received without a settlement acknowledgement', () => app.engine.getRun(cancelRun.id).status === 'cancelled' && app.engine.getRun(cancelRun.id).settled === false && runtime.cancelObservations === 1);
    const cancellationStatus = () => evaluate(id => [...document.querySelectorAll('#conversation-dialogue .conversation-turn')].find(turn => turn.dataset.runId === id)?.querySelector('.conversation-turn-status')?.textContent.trim() || '', cancelRun.id);
    await until('the cancelling turn itself to say stopping', async () => { const status = await cancellationStatus(); return /\bStopping\b/.test(status) && !/\bStopped\b/.test(status); });
    const pendingStatus = await cancellationStatus();
    check('Cancellation remains visibly stopping while the original task still owns its execution slot', app.engine.getRun(cancelRun.id).settled === false && app.engine.executionStatus().activeCount > 0 && /\bStopping\b/.test(pendingStatus) && !/\bStopped\b/.test(pendingStatus));
    const headerStatus = () => evaluate(() => document.querySelector('#workspace-health').textContent.trim());
    await until('the global workspace header to acknowledge stopping', async () => /Stopping/.test(await headerStatus()));
    const pendingHeader = await headerStatus(), stoppingUntilSettled = /Stopping/.test(pendingHeader) && !/Ready/.test(pendingHeader) && app.engine.getRun(cancelRun.id).settled === false;
    check('The workspace header remains Stopping while cancellation is still awaiting acknowledgement', stoppingUntilSettled);
    check('The stopping controls and task view fit their viewport', await geometry('1440px stopping task')); await screenshot('07-task-stopping-desktop.jpg');
    runtime.directionGate.resolve(); runtime.cancelGate.resolve();
    await until('the original cancellation to settle', () => app.engine.getRun(cancelRun.id).settled === true);
    await until('the final held direction HTTP receipt', () => cdp.directionNetwork[2]?.finished && cdp.directionNetwork[2].status === 409);
    await until('the same turn to acknowledge stopped', async () => await cancellationStatus() === 'Stopped');
    const settledStatus = await cancellationStatus();
    check('Only acknowledged cancellation is marked stopped and its execution slot is released', app.engine.getRun(cancelRun.id).status === 'cancelled' && app.engine.getRun(cancelRun.id).settled === true && app.engine.executionStatus().activeCount === 0 && runtime.cancelObservations === 1 && runtime.directionRequests === 3 && settledStatus === 'Stopped');
    await until('the settled workspace header to return to Ready', async () => await headerStatus() === 'Ready');
    const settledHeader = await headerStatus();
    check('The workspace header returns to Ready only after the owned execution slot is released', settledHeader === 'Ready' && app.engine.executionStatus().activeCount === 0 && app.engine.getRun(cancelRun.id).settled);
    report.recovery.header = { pending: pendingHeader, settled: settledHeader, stoppingUntilSettled, readyAfterSettlement: settledHeader === 'Ready' && app.engine.executionStatus().activeCount === 0 };
    report.recovery.directions.requests = runtime.directionRequests; report.recovery.directions.receipts = runtime.directionSettlements;
    report.cancellation = { runId: cancelRun.id, directionRequests: runtime.directionRequests, directionRequestScope: 'entire-owned-fixture', stopJourneyDirectionRequests: 1, cancellationObserved: runtime.cancelObservations, pendingStatus, settledStatus, settled: app.engine.getRun(cancelRun.id).settled, status: app.engine.getRun(cancelRun.id).status };
    await click('[data-mission-action="new-task"]');
    await until('the unsent new-chat draft to return', async () => (await composer()).draft === newDraft && !(await composer()).readOnly);
    check('The independent unsent New chat draft survives both late direction outcomes and cancellation', (await composer()).draft === newDraft && runtime.calls.length === 3);
    report.recovery.directions.newDraftPreserved = true;
    await select('#mission-planning-mode', 'off');
    await resize(390, 844);
    await fill('#mission-task', 'QA Off task: return a short answer without automatic planning.'); await click('#mission-start-button');
    await until('the Off fixture result', () => runtime.stage === 'off-completed' && app.engine.listRuns().some(run => run.nodes.agent?.output === OFF_FINAL && run.status === 'completed' && run.settled));
    const offRun = app.engine.listRuns().find(run => run.nodes.agent?.output === OFF_FINAL);
    await until('the Off answer to be visible', () => evaluate(text => document.querySelector('#conversation-dialogue').textContent.includes(text), OFF_FINAL));
    check('Off permits an actual final answer without automatic plan calls or a missing-plan error', offRun.planningMode === 'off' && !offRun.errorCode && runtime.calls[3].toolCalls === 0 && runtime.calls[0].toolCalls > 0 && completed.planningMode === 'on');
    await resize(390, 844);
    check('The Off conversation remains readable on mobile without a preparing-plan notice', await geometry('390px planning off') && await evaluate(() => document.querySelector('#conversation-dialogue-tab').getAttribute('aria-selected') === 'true' && !/Preparing the plan/.test(document.querySelector('#mission-plan').textContent)));
    const offControls = await composerControlGeometry(); report.recovery.composer = { off: offControls, offControlsSeparated: offControls.controlsSeparated };
    check('Mobile Off keeps Planning and Reasoning visibly separate with unobstructed composer hit targets', offControls.width === 390 && offControls.controlsSeparated);
    await screenshot('10-planning-off-mobile.jpg');
    report.planning = { choices: modeChoices, descriptions: modeNotes, plannedMode: completed.planningMode, offMode: offRun.planningMode, offCompleted: offRun.status === 'completed' && offRun.settled, offToolCalls: runtime.calls[3].toolCalls, offFinalVisible: await evaluate(text => document.querySelector('#conversation-dialogue').textContent.includes(text), OFF_FINAL) };
    const paneState = () => evaluate(() => { const conversation = document.querySelector('#conversation-dialogue'), plan = document.querySelector('#mission-plan'), planTab = document.querySelector('#conversation-plan-tab'), conversationTab = document.querySelector('#conversation-dialogue-tab'); return { conversationSelected: conversationTab.getAttribute('aria-selected') === 'true', conversationVisible: !conversation.hidden && !conversation.inert && conversation.getClientRects().length > 0, planHidden: plan.hidden && plan.inert, planTabReachable: !planTab.disabled && !planTab.closest('[hidden],[inert]') && planTab.getClientRects().length > 0, planSelected: planTab.getAttribute('aria-selected') === 'true', planVisible: !plan.hidden && !plan.inert && plan.getClientRects().length > 0 }; });
    const checkEmptyPlan = async (kind, run, actualState) => {
      await until(`${kind} planning to default to the narrow Conversation pane`, async () => { const value = await paneState(); return value.conversationSelected && value.conversationVisible && value.planHidden; });
      const initial = await paneState(), conversationDefault = initial.conversationSelected && initial.conversationVisible && initial.planHidden;
      check(`At 390px an empty ${kind} plan defaults to the visible Conversation and its actual result or error`, conversationDefault && actualState && await geometry(`390px empty ${kind} plan`));
      await click('#conversation-plan-tab'); await waitVisible('#mission-plan');
      const reached = await paneState(), planReachable = initial.planTabReachable && reached.planSelected && reached.planVisible;
      await click('[data-mission-action="new-task"]'); await openChat(run.id);
      await until(`the explicit ${kind} Plan choice after returning to the chat`, async () => { const value = await paneState(); return value.planSelected && value.planVisible; });
      const restored = await paneState(), explicitChoicePreserved = restored.planSelected && restored.planVisible && !restored.conversationVisible;
      check(`The empty ${kind} Plan remains reachable and a deliberate pane choice survives navigation`, planReachable && explicitChoicePreserved);
      await click('#conversation-dialogue-tab'); await waitVisible('#conversation-dialogue');
      return { runId: run.id, planningStatus: run.nodes.agent.planning.status, steps: run.taskState?.steps?.length || 0, conversationDefault, planReachable, explicitChoicePreserved, initial, restored };
    };
    await click('[data-mission-action="new-task"]'); await select('#mission-planning-mode', 'on'); await select('#mission-model', 'fixture-model');
    await fill('#mission-task', 'QA empty missing-plan task: return without saving any outline so its failure stays readable.'); await click('#mission-start-button');
    await until('the empty missing-plan task to settle', () => app.engine.listRuns().some(run => run.nodes.agent?.threadId === 'revised-ui-fixture-5' && run.errorCode === 'TASK_PLAN_REQUIRED' && run.settled));
    const missingRun = app.engine.listRuns().find(run => run.nodes.agent?.threadId === 'revised-ui-fixture-5');
    await until('the empty missing-plan error in Conversation', () => evaluate(() => /answer was withheld/.test(document.querySelector('#conversation-dialogue').textContent)));
    report.recovery.emptyPlans = { missing: await checkEmptyPlan('missing', missingRun, missingRun.nodes.agent.planning?.status === 'missing' && (missingRun.taskState?.steps?.length || 0) === 0 && missingRun.nodes.agent.output === '' && await evaluate(text => !document.querySelector('#conversation-dialogue').textContent.includes(text), EMPTY_UNPLANNED)) };
    await click('[data-mission-action="new-task"]'); await select('#mission-planning-mode', 'on'); await select('#mission-model', 'fixture-no-tools');
    await fill('#mission-task', 'QA conversation-only task: show its local answer when this model has no planning tools.'); await click('#mission-start-button');
    await until('the unavailable-planning task to settle', () => app.engine.listRuns().some(run => run.nodes.agent?.threadId === 'revised-ui-fixture-6' && run.status === 'completed' && run.settled));
    const unavailableRun = app.engine.listRuns().find(run => run.nodes.agent?.threadId === 'revised-ui-fixture-6');
    await until('the answer without planning tools in Conversation', () => evaluate(text => document.querySelector('#conversation-dialogue').textContent.includes(text), UNAVAILABLE_FINAL));
    report.recovery.emptyPlans.unavailable = await checkEmptyPlan('unavailable', unavailableRun, unavailableRun.planningMode === 'on' && unavailableRun.nodes.agent.planning?.status === 'unavailable' && (unavailableRun.taskState?.steps?.length || 0) === 0 && unavailableRun.nodes.agent.output === UNAVAILABLE_FINAL && runtime.calls[5].toolCalls === 0);
    const unavailableControls = await composerControlGeometry(); report.recovery.composer.unavailable = unavailableControls; report.recovery.composer.unavailableControlsSeparated = unavailableControls.controlsSeparated;
    check('Mobile unavailable planning keeps Planning and Reasoning visibly separate with unobstructed composer hit targets', unavailableControls.width === 390 && unavailableControls.controlsSeparated);
    await screenshot('14-unavailable-plan-mobile.jpg');
    await workflowJourney({ app, runtime, cdp, session, origin, report, completed, unavailableRun, evaluate, until, visible, waitVisible, click, fill, select, frames, key, openChat, composer, resize, screenshot, geometry, check });
    await interfaceJourney({ api, app, runtime, cdp, report, unavailableRun, evaluate, until, visible, waitVisible, click, fill, select, frames, key, menu, closeModal, composer, resize, screenshot, geometry, check });
    await planningJourney({ api, app, runtime, cdp, session, origin, report, completed, unavailableRun, swarm, evaluate, until, visible, waitVisible, click, fill, select, frames, key, menu, closeModal, composer, resize, screenshot, geometry, check });
    await planningOrganizationUIJourney({ api, app, runtime, report, taskId: completed.taskId || completed.id, cwd, cdp, session, origin, evaluate, until, waitVisible, click, fill, select, key, menu, closeModal, resize, screenshot, geometry, check });
    await containedBrowserJourney({ api, contained, report, cdp, session, evaluate, until, visible, waitVisible, click, fill, frames, key, closeModal, composer, resize, screenshot, geometry, check });
    await remoteSettingsJourney({ api, app, remoteFixture, desktopLifecycle, report, evaluate, until, visible, waitVisible, click, fill, select, frames, closeModal, composer, resize, screenshot, geometry, check });
    await chatGPTConnectorUIJourney({ api, app, runtime, report, cwd, evaluate, until, waitVisible, click, resize, screenshot, geometry, check });
    await browserCredentialsUIJourney({ api, app, runtime, fixture: passwordFixture, report, cdp, session, evaluate, until, waitVisible, click, fill, select, resize, screenshot, geometry, check });
    await chatClipboardJourney({ report, runId: unavailableRun.id, expected: UNAVAILABLE_FINAL, evaluate, until, click, fill, openChat, composer, screenshot, check });
    await chatModeRetirementUIJourney({ api, app, runtime, cdp, session, origin, report, sourceRun: unavailableRun, evaluate, until, visible, waitVisible, click, fill, frames, key, openChat, composer, resize, screenshot, geometry, check });
    check('All required Planning, browser and remote acceptance features completed', REQUIRED_FEATURES.every(name => report.features[name] === true));
    report.runtimeCalls = runtime.calls; report.pageErrors = cdp.events.filter(event => event.method === 'Runtime.exceptionThrown');
    report.directionHttpReceipts = cdp.directionNetwork;
    check('Exactly six explicit fake-model turns, six email interface checks and three read-only mailbox fixtures ran, with one unexecuted saved-project fixture and no external requests or real mailbox execution', runtime.calls.length === 6 && runtime.calls.every(call => call.externalRequests === 0 && call.harnessIdentified) && runtime.directionRequests === 3 && cliCalls.length === 9 && cliCalls.filter(call => call.mailboxFixture).length === 3 && cliCalls.every(call => call.fixtureOnly === true && !call.args.includes('--seen') && !call.args.includes('send')) && app.projects.list().length === 1 && app.projects.list().every(project => report.recovery.planningOrganization.projectIds.includes(project.id) && project.status === 'draft' && project.tasks.every(task => task.attempts.length === 0)) && (await api('/api/operations')).jobs.length === 0);
    check('The exercised UI has no uncaught JavaScript exceptions', report.pageErrors.length === 0);
    report.after = await hashes(); report.appFingerprintAfter = await appFingerprint(candidate);
    report.unchangedDuringChecks = report.appFingerprintBefore === report.appFingerprintAfter && JSON.stringify(report.before) === JSON.stringify(report.after);
    check('The UI acceptance is bound to unchanged whole-application fingerprints and explicit source hashes', report.unchangedDuringChecks);
    report.ok = true;
  } catch (error) {
    report.ok = false; report.error = error.stack || error.message; process.stderr.write(`${report.error}\n`);
    report.pageErrors = cdp?.events.filter(event => event.method === 'Runtime.exceptionThrown') || [];
    report.runtimeCalls = runtime?.calls || [];
    report.failureState = { runtimeStage: runtime?.stage, directionRequests: runtime?.directionRequests, directionHttpReceipts: cdp?.directionNetwork || [], cancelObservations: runtime?.cancelObservations };
    if (cdp && !controller.signal.aborted) report.failureState.composer = await evaluate(() => ({ mode: document.querySelector('#mission-start-button')?.dataset.mode, disabled: document.querySelector('#mission-start-button')?.disabled, inputReadOnly: document.querySelector('#mission-task')?.readOnly, draft: document.querySelector('#mission-task')?.value, runIds: [...document.querySelectorAll('#conversation-dialogue .conversation-turn')].map(turn => turn.dataset.runId) })).catch(error => ({ error: error.message }));
    if (cdp && !controller.signal.aborted) await screenshot('failure.jpg').catch(() => {});
  } finally {
    clearTimeout(timeout); runtime?.releaseControls(); controller.abort(Error('UI fixture cleanup.'));
    if (cdp) { try { await cdp.call('Browser.close', {}, undefined, { cleanup: true }); } catch {} cdp.close(); }
    if (browser && browser.exitCode === null && browser.signalCode === null) { await Promise.race([once(browser, 'exit'), delay(2500)]); if (browser.exitCode === null && browser.signalCode === null && browser.pid) { if (process.platform === 'win32') { const stop = spawn('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await Promise.race([once(stop, 'exit'), delay(4000)]); } else browser.kill('SIGKILL'); } }
    await browserLog?.close().catch(() => {});
    try { await app?.close(); report.serverClosed = true; } catch (error) { report.cleanupError = error.message; report.ok = false; }
    try { assert.ok(path.basename(root).startsWith('blackice-planning-remote-ui-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); report.disposableStateRemoved = true; } catch (error) { report.cleanupError = error.message; report.ok = false; }
    report.finishedAt = new Date().toISOString(); report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt); report.passed = report.checks.length;
    await fs.writeFile(path.join(out, 'planning-remote-ui-report.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`REPORT ${path.join(out, 'planning-remote-ui-report.json')}\n`); if (!report.ok) process.exitCode = 1;
  }
  return report;
}

async function workflowJourney({ app, runtime, cdp, session, origin, report, completed, unavailableRun, evaluate, until, visible, waitVisible, click, fill, select, frames, key, openChat, composer, resize, screenshot, geometry, check }) {
  const flags = report.workflowImprovement = {}, evidence = report.workflowEvidence = {};
  const savedDraft = 'QA unsent workflow draft: search, navigation and shortcuts must keep this exact text.';
  const runIds = () => app.engine.listRuns().map(run => run.id).sort();
  const originalRuns = runIds(), originalTurns = runtime.calls.length, networkStart = cdp.conversationNetwork.length;
  assert.equal(originalTurns, 6); assert.equal(app.engine.executionStatus().activeCount, 0);
  const noDispatch = () => runtime.calls.length === originalTurns && JSON.stringify(runIds()) === JSON.stringify(originalRuns) && app.engine.executionStatus().activeCount === 0;
  const revealSidebar = async () => {
    if (!await visible('#conversation-search') && await visible('#conversation-sidebar-toggle')) await click('#conversation-sidebar-toggle');
    await waitVisible('#conversation-search');
  };
  const searchResponse = async (query, start) => {
    const request = await until('a completed browser search for ' + query, () => cdp.conversationNetwork.slice(start).findLast(item => {
      const url = new URL(item.url);
      return item.method === 'GET' && url.origin === origin && url.pathname === '/api/conversations/search' && url.searchParams.get('q') === query && item.status === 200 && item.finished;
    }));
    const body = await cdp.call('Network.getResponseBody', { requestId: request.requestId }, session);
    const response = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
    assert.equal(response.query, query); assert.equal(response.state, 'all'); assert.ok(Array.isArray(response.conversations));
    return { request, response };
  };
  const sidebarMatch = async (query, expectedRunId) => {
    await revealSidebar(); const start = cdp.conversationNetwork.length;
    await fill('#conversation-search', query);
    const result = await searchResponse(query, start);
    (evidence.searchResponses ||= []).push({ query, request: result.request, total: result.response.total, matches: result.response.conversations.map(item => ({ conversationId: item.rootId || item.taskId || item.id, ...item.match })) });
    const row = await until('the sidebar content match for ' + query, () => evaluate((query, expectedRunId) => {
      const button = [...document.querySelectorAll('#conversation-list [data-mission-action="open-run"][data-search-run-id]')].find(node => (!expectedRunId || node.dataset.searchRunId === expectedRunId) && node.querySelector('.conversation-sidebar-preview')?.textContent.includes(query));
      if (!button) return null;
      return { runId: button.dataset.searchRunId, messageId: button.dataset.searchMessageId || '', conversationId: button.dataset.conversationId, title: button.querySelector('.conversation-sidebar-title')?.textContent || '', preview: button.querySelector('.conversation-sidebar-preview').textContent, status: document.querySelector('#conversation-search-status')?.textContent || '' };
    }, query, expectedRunId));
    const match = result.response.conversations.find(item => item.match?.runId === row.runId && (item.rootId || item.taskId || item.id) === row.conversationId);
    assert.ok(match, 'The rendered sidebar result must belong to the real search response.');
    return { ...row, kind: match.match.kind, request: result.request };
  };
  const selectedMatch = () => evaluate(id => {
    const target = [...document.querySelectorAll('#conversation-dialogue .conversation-search-target')].find(node => node.closest('.conversation-turn')?.dataset.runId === id);
    const notice = document.querySelector('#conversation-match-notice');
    return { found: Boolean(target && target.getClientRects().length && !target.closest('[hidden],[inert]')), runId: target?.closest('.conversation-turn')?.dataset.runId || '', text: target?.textContent || '', messageId: target?.dataset.messageId || '', notice: Boolean(notice && !notice.hidden && notice.getClientRects().length && notice.textContent.trim()) };
  }, completed.id);
  await resize(1440, 900); await revealSidebar(); await fill('#conversation-search', ''); await openChat(unavailableRun.id);
  await until('the origin chat to be editable before search', async () => !(await composer()).readOnly);
  await fill('#mission-task', savedDraft);
  const message = await sidebarMatch(FINAL, completed.id); evidence.message = message;
  check('Sidebar search finds saved answer text beyond chat titles through the real content API', message.kind === 'message' && Boolean(message.messageId) && message.preview.includes(FINAL) && !message.title.includes(FINAL) && noDispatch());
  flags.sidebarMessageSearch = true;
  await key('Enter', 'Enter', 13, 2); await frames(); await delay(250);
  const searchShortcutScoped = noDispatch() && (await composer()).draft === savedDraft;
  assert.ok(searchShortcutScoped, 'Ctrl+Enter in sidebar search must not dispatch the unrelated composer draft.');

  const registeredFile = completed.taskState?.artifacts?.find(item => item.fileName === 'qa-result.txt');
  assert.ok(registeredFile?.id && registeredFile.verification === 'filesystem-sha256' && registeredFile.sha256 === createHash('sha256').update(FINAL + '\n' + NOTE + '\n').digest('hex'), 'The completed fixture must retain its registered result before filename search.');
  evidence.registeredFile = { id: registeredFile.id, fileName: registeredFile.fileName, sha256: registeredFile.sha256 };
  const file = await sidebarMatch('qa-result.txt'); evidence.file = file;
  check('Sidebar search finds the registered result filename with a file preview', file.kind === 'file' && file.conversationId === message.conversationId && file.preview.includes('qa-result.txt') && noDispatch());
  flags.sidebarFileSearch = true;
  const narrow = [];
  for (const width of [320, 390]) {
    await resize(width, 844); await revealSidebar(); await frames();
    const layout = await evaluate(() => {
      const input = document.querySelector('#conversation-search'), button = [...document.querySelectorAll('#conversation-list [data-search-run-id]')].find(node => node.querySelector('.conversation-sidebar-preview')?.textContent.includes('qa-result.txt')), preview = button?.querySelector('.conversation-sidebar-preview');
      const bounds = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const search = bounds(input), result = bounds(button), excerpt = bounds(preview);
      const front = result && document.elementFromPoint(result.left + result.width / 2, result.top + result.height / 2);
      return { width: innerWidth, search, result, excerpt, hit: Boolean(front && button.contains(front)), query: input?.value, statusPresent: Boolean(document.querySelector('#conversation-search-status')) };
    });
    const inViewport = box => box && box.width > 0 && box.height > 0 && box.left >= -1 && box.right <= width + 1 && box.top >= -1 && box.bottom <= 845;
    assert.ok(layout.width === width && layout.query === 'qa-result.txt' && layout.statusPresent && layout.hit && inViewport(layout.search) && inViewport(layout.result) && inViewport(layout.excerpt) && await geometry(width + 'px content search'), 'Search controls and result previews must fit the narrow viewport.');
    narrow.push(layout); await screenshot(width === 320 ? '19-content-search-320.jpg' : '20-content-search-390.jpg');
  }
  evidence.narrowLayouts = narrow;
  check('Content search and filename previews remain readable and reachable at 320px and 390px', narrow.length === 2 && noDispatch());
  flags.narrowSearchLayout = true;
  await resize(1440, 900); await sidebarMatch(FINAL, completed.id);
  await click(`#conversation-list [data-mission-action="open-run"][data-search-run-id="${completed.id}"]`);
  await until('the older matching answer to be highlighted', async () => { const match = await selectedMatch(); return match.found && match.notice && match.text.includes(FINAL); });
  evidence.matchedTurn = await selectedMatch();
  check('Opening a search hit reveals and highlights its older matching turn with a visible match notice', evidence.matchedTurn.runId === completed.id && evidence.matchedTurn.found && evidence.matchedTurn.notice && evidence.matchedTurn.text.includes(FINAL) && noDispatch());
  flags.matchedTurnNavigation = true;
  await screenshot('21-content-match-desktop.jpg');

  await revealSidebar(); await fill('#conversation-search', ''); await openChat(unavailableRun.id);
  assert.equal((await composer()).draft, savedDraft);
  await key('k', 'KeyK', 75, 2); await waitVisible('#command-query');
  const paletteStart = cdp.conversationNetwork.length;
  await fill('#command-query', FINAL);
  const palette = await until('the command palette content result', () => evaluate(id => {
    const button = [...document.querySelectorAll('#command-results .command-result[data-search-run-id]')].find(node => node.dataset.searchRunId === id);
    if (!button?.querySelector('.command-match-preview')) return null;
    return { runId: button.dataset.searchRunId, messageId: button.dataset.searchMessageId || '', preview: button.querySelector('.command-match-preview').textContent, statusPresent: Boolean(document.querySelector('#command-search-status')) };
  }, completed.id));
  const paletteHttp = await searchResponse(FINAL, paletteStart);
  assert.ok(paletteHttp.response.conversations.some(item => item.match?.runId === completed.id && item.match.kind === 'message'));
  await screenshot('22-command-content-search-desktop.jpg');
  await click(`#command-results .command-result[data-search-run-id="${completed.id}"]`);
  await until('the command palette result to open in its matching chat', async () => !await visible('#command-query') && (await selectedMatch()).found && (await selectedMatch()).notice);
  evidence.palette = { ...palette, request: paletteHttp.request };
  check('Ctrl+K searches saved message content and opens the matching passage from its preview', palette.runId === completed.id && palette.preview.includes(FINAL) && palette.statusPresent && noDispatch());
  flags.paletteContentSearch = true;

  await click('#conversation-actions > summary'); await click('#conversation-action-list [data-mission-action="rename-conversation"]'); await waitVisible('#conversation-name');
  await fill('#conversation-name', 'QA shortcut scope in the rename field');
  const renameDraft = (await composer()).draft;
  await key('Enter', 'Enter', 13, 2); await frames(); await delay(250);
  const renameShortcutScoped = noDispatch() && (await composer()).draft === renameDraft;
  if (await visible('#conversation-name')) await key('Escape', 'Escape', 27);
  evidence.shortcuts = { searchInput: searchShortcutScoped, renameInput: renameShortcutScoped, runtimeTurns: runtime.calls.length, runCount: runIds().length };
  check('Ctrl+Enter in search and rename fields never submits a different composer draft', searchShortcutScoped && renameShortcutScoped && noDispatch());
  flags.composerShortcutScoped = true;
  await revealSidebar(); await fill('#conversation-search', ''); await openChat(unavailableRun.id);
  await until('the origin draft to survive sidebar and palette navigation', async () => (await composer()).draft === savedDraft && !(await composer()).readOnly);
  check('The unsent origin draft survives message search, file search and command palette navigation', (await composer()).draft === savedDraft && noDispatch());
  flags.searchDraftPreserved = true;

  await revealSidebar();
  const isCatalog = item => { const url = new URL(item.url); return item.method === 'GET' && url.origin === origin && url.pathname === '/api/conversations'; };
  await until('owned catalog reads to settle before the controlled retry', () => cdp.conversationNetwork.filter(isCatalog).every(item => item.finished));
  const catalogBefore = await evaluate(() => [...document.querySelectorAll('#conversation-list [data-mission-action="open-run"]')].map(node => node.dataset.conversationId).sort());
  const failureText = 'QA owned catalog retry: one active-history request deliberately failed.';
  const fault = { count: 0, url: '', requestId: '' };
  cdp.interceptRequest = async (params, targetSession) => {
    const url = new URL(params.request.url);
    if (fault.count === 0 && targetSession === session && params.request.method === 'GET' && url.origin === origin && url.pathname === '/api/conversations' && url.searchParams.get('state') === 'active') {
      fault.count++; fault.url = url.href; fault.requestId = params.requestId;
      await cdp.call('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ error: failureText })).toString('base64') }, targetSession);
    } else await cdp.call('Fetch.continueRequest', { requestId: params.requestId }, targetSession);
  };
  try {
    await cdp.call('Fetch.enable', { patterns: [{ urlPattern: origin + '/api/conversations?*', requestStage: 'Request' }] }, session);
    await select('#conversation-history-state', 'active');
    await until('the real catalog error and Retry control', async () => {
      if (cdp.interceptionError) throw Error(cdp.interceptionError);
      return fault.count === 1 && await visible('#conversation-sidebar-retry') && await evaluate(text => document.querySelector('#conversation-sidebar-error-text').textContent.includes(text), failureText);
    });
    const retained = await evaluate(() => ({ draft: document.querySelector('#mission-task').value, conversationIds: [...document.querySelectorAll('#conversation-list [data-mission-action="open-run"]')].map(node => node.dataset.conversationId).sort(), busy: document.querySelector('#conversation-sidebar-retry').getAttribute('aria-disabled') }));
    const retryStart = cdp.conversationNetwork.length;
    await click('#conversation-sidebar-retry');
    await until('successful real catalog reads after Retry', async () => {
      if (cdp.interceptionError) throw Error(cdp.interceptionError);
      const successful = cdp.conversationNetwork.slice(retryStart).filter(item => isCatalog(item) && item.status === 200 && item.finished).map(item => new URL(item.url).searchParams.get('state'));
      return ['active', 'archived', 'deleted'].every(state => successful.includes(state)) && await evaluate(() => document.querySelector('#conversation-sidebar-error').hidden);
    });
    evidence.catalogRetry = { injectedFailures: fault.count, failedUrl: fault.url, catalogBefore, retained, requests: cdp.conversationNetwork.slice(retryStart).filter(isCatalog), focus: await evaluate(() => document.activeElement.id) };
    check('A failed catalog read retains chats and the draft, and Retry restores all real catalog buckets', fault.count === 1 && catalogBefore.length > 0 && JSON.stringify(retained.conversationIds) === JSON.stringify(catalogBefore) && retained.draft === savedDraft && retained.busy === 'false' && (await composer()).draft === savedDraft && evidence.catalogRetry.focus === 'conversation-search' && noDispatch());
    flags.catalogRetry = true;
  } finally {
    await cdp.call('Fetch.disable', {}, session, { cleanup: true }); cdp.interceptRequest = null;
  }
  evidence.requests = cdp.conversationNetwork.slice(networkStart);
  assert.equal(Object.keys(flags).length, 8); assert.ok(Object.values(flags).every(value => value === true)); assert.ok(noDispatch());
}

async function interfaceJourney({ api, app, runtime, cdp, report, unavailableRun, evaluate, until, visible, waitVisible, click, fill, select, frames, key, menu, closeModal, composer, resize, screenshot, geometry, check }) {
  const flags = report.workflowImprovement, evidence = report.workflowEvidence;
  const initial = await composer(), originalRuns = app.engine.listRuns().map(run => run.id).sort(), providerBefore = await api('/api/providers');
  assert.equal(runtime.calls.length, 6); assert.ok(initial.runIds.includes(unavailableRun.id) && initial.draft.length > 0);
  const noDispatch = () => runtime.calls.length === 6 && app.engine.executionStatus().activeCount === 0 && JSON.stringify(app.engine.listRuns().map(run => run.id).sort()) === JSON.stringify(originalRuns);
  const preserved = async () => { const value = await composer(); return noDispatch() && value.draft === initial.draft && JSON.stringify(value.runIds) === JSON.stringify(initial.runIds); };
  const revealSidebar = async () => { if (!await visible('#conversation-search') && await visible('#conversation-sidebar-toggle')) await click('#conversation-sidebar-toggle'); await waitVisible('#conversation-search'); };
  const settleCatalog = async () => { await until('the interface catalog refresh to finish', () => cdp.conversationNetwork.filter(item => new URL(item.url).pathname === '/api/conversations').every(item => item.finished)); await frames(); };

  const pickerLayouts = []; evidence.modelPickerList = { pickerLayouts };
  for (const width of [1440, 390]) {
    await resize(width, width === 390 ? 844 : 900);
    if (width === 390 && await visible('#conversation-sidebar-scrim')) await click('#conversation-sidebar-toggle');
    await click('.conversation-model-choice .model-picker-button'); await waitVisible('#mission-model-picker .model-picker-search'); await frames();
    const layout = await evaluate(() => {
      const panel = document.querySelector('#mission-model-picker'), bounds = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      return { width: innerWidth, height: innerHeight, panel: bounds(panel), rows: [...panel.querySelectorAll('[data-model-value]')].map(node => {
        const name = node.querySelector('.model-picker-option-name'), detail = node.querySelector('.model-picker-option-detail');
        return { value: node.dataset.modelValue, rect: bounds(node), name: bounds(name), detail: bounds(detail), namePx: parseFloat(getComputedStyle(name).fontSize), detailPx: parseFloat(getComputedStyle(detail).fontSize), nameWhiteSpace: getComputedStyle(name).whiteSpace, detailWhiteSpace: getComputedStyle(detail).whiteSpace, detailText: detail.textContent, selected: node.getAttribute('aria-selected') === 'true', check: node.querySelector('.model-picker-check')?.textContent };
      }) };
    });
    pickerLayouts.push(layout);
    assert.ok(layout.rows.length >= 3 && layout.rows.some(row => row.value === 'fixture-model') && layout.rows.some(row => row.value === 'fixture-no-tools'));
    assert.ok(layout.panel.left >= 0 && layout.panel.right <= width && layout.panel.top >= 0 && layout.panel.bottom <= layout.height && layout.panel.width <= 461 && layout.panel.height <= 481);
    assert.ok(layout.rows.every((row, index, rows) => Math.abs(row.rect.height - 40) <= .5 && row.namePx === 13 && row.detailPx === 11 && row.nameWhiteSpace === 'nowrap' && row.detailWhiteSpace === 'nowrap' && row.name.right <= row.detail.left + .5 && row.name.width > 0 && row.detail.width > 0 && row.detailText.includes('Codex') && (!index || row.rect.top >= rows[index - 1].rect.bottom - .5)));
    assert.ok(layout.rows.some(row => row.selected && row.value === 'fixture-no-tools' && row.check === '✓'));
    await fill('#mission-model-picker .model-picker-search', 'fixture-no-tools');
    await until('the compact model search to filter the real local catalog', () => evaluate(() => { const rows = [...document.querySelectorAll('#mission-model-picker [data-model-value]')]; return rows.length === 1 && rows[0].dataset.modelValue === 'fixture-no-tools'; }));
    layout.filteredValues = await evaluate(() => [...document.querySelectorAll('#mission-model-picker [data-model-value]')].map(node => node.dataset.modelValue));
    await fill('#mission-model-picker .model-picker-search', ''); await frames();
    await screenshot(width === 390 ? '24-model-picker-list-mobile.jpg' : '23-model-picker-list-desktop.jpg');
    await key('Escape', 'Escape', 27); await until('the model picker to close and restore its button focus', () => evaluate(() => document.querySelector('#mission-model-picker').hidden && document.activeElement.matches('.conversation-model-choice .model-picker-button')));
    assert.ok(await preserved());
  }

  await resize(1440, 900); await revealSidebar();
  if (!await evaluate(() => document.querySelector('#mission-context').open)) await click('#mission-context > summary');
  const dropdowns = []; evidence.nativeDropdowns = { samples: dropdowns, sampleCount: 0, itemCount: 0, popup: null };
  const sampleDropdowns = async (group, selectors) => {
    await frames();
    const samples = await evaluate((group, selectors) => {
      const color = value => { const numbers = value.match(/[\d.]+/g)?.map(Number); return numbers?.length >= 3 ? { rgb: numbers.slice(0, 3), alpha: numbers[3] ?? 1 } : null; };
      const luminance = rgb => rgb.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
      const appearance = node => {
        const style = getComputedStyle(node), background = color(style.backgroundColor), foreground = color(style.color), dark = background && luminance(background.rgb), light = foreground && luminance(foreground.rgb);
        return { tag: node.tagName.toLowerCase(), value: node.value ?? '', disabled: node.disabled === true, background: style.backgroundColor, foreground: style.color, colorScheme: style.colorScheme, opacity: Number(style.opacity), backgroundAlpha: background?.alpha, foregroundAlpha: foreground?.alpha, backgroundLuminance: dark, contrast: background && foreground ? (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05) : 0 };
      };
      return selectors.map(selector => { const node = document.querySelector(selector); return { group, selector, missing: !node || node.tagName !== 'SELECT', items: node ? [appearance(node), ...[...node.querySelectorAll('option,optgroup')].map(appearance)] : [] }; });
    }, group, selectors);
    dropdowns.push(...samples);
    evidence.nativeDropdowns.sampleCount = dropdowns.length; evidence.nativeDropdowns.itemCount = dropdowns.reduce((count, sample) => count + sample.items.length, 0);
    for (const sample of samples) assert.ok(!sample.missing && sample.items.length >= 2 && sample.items.every(item => item.colorScheme.split(/\s+/).includes('dark') && item.backgroundAlpha === 1 && item.foregroundAlpha === 1 && item.backgroundLuminance < .15 && item.contrast >= 4.5), 'Every native dropdown and option must retain opaque dark surfaces with readable text: ' + sample.selector + ' ' + JSON.stringify(sample.items));
  };
  await sampleDropdowns('chat', ['#mission-model', '#mission-effort', '#mission-planning-mode', '#conversation-history-state']);
  if (await evaluate(() => document.querySelector('#mission-context').open)) await click('#mission-context > summary');
  const planningBefore = await evaluate(() => document.querySelector('#mission-planning-mode').value);
  const popup = evidence.nativeDropdowns.popup = { selector: '#mission-planning-mode', requestedBy: 'real pointer click', screenshot: '27-native-planning-dropdown-desktop.jpg' };
  const popupOpen = () => evaluate(() => { try { return document.querySelector('#mission-planning-mode').matches(':open'); } catch { return null; } });
  try {
    await click('#mission-planning-mode'); await frames(); popup.open = await popupOpen();
    if (popup.open === false) { await key('ArrowDown', 'ArrowDown', 40, 1); await frames(); popup.requestedBy += ' and Alt+ArrowDown'; popup.open = await popupOpen(); }
    await screenshot(popup.screenshot); popup.captured = true;
  } finally { await key('Escape', 'Escape', 27); }
  popup.observation = popup.open === true ? 'The browser reported the native select open during capture.' : 'An actual native popup was requested; this headless browser did not expose an open state. The screenshot requires visual inspection.';
  assert.equal(await evaluate(() => document.querySelector('#mission-planning-mode').value), planningBefore);

  await click('#workspace-modes [data-mode="configure"]'); await waitVisible('[data-configure-section="response-defaults"] > summary');
  if (!await evaluate(() => document.querySelector('[data-configure-section="response-defaults"]').open)) await click('[data-configure-section="response-defaults"] > summary');
  await waitVisible('#configure-default-effort');
  await sampleDropdowns('settings', ['#configure-default-effort', '#configure-verbosity', '#configure-max-subagents', '#configure-default-context']);
  await click('#workspace-modes [data-mode="view"]'); await waitVisible('#mission-task'); assert.ok(await preserved());

  await menu('models-connections'); await waitVisible('#connection-default-model');
  await sampleDropdowns('models', ['#connection-default-model']);
  if (!await evaluate(() => document.querySelector('#connection-codex-details').open)) await click('#connection-codex-details > summary');
  await waitVisible('#connection-codex-search');
  await evaluate(() => document.querySelector('.connection-codex-models').scrollIntoView({ block: 'center' })); await frames();
  const nativeRows = evidence.modelPickerList.nativeRows = await evaluate(() => {
    const bounds = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    return { toolsClosed: !document.querySelector('#connection-codex-tools').open, rows: [...document.querySelectorAll('.connection-codex-models .connection-codex-list-row')].map(node => {
      const name = node.querySelector('.connection-codex-row > strong'), provider = node.querySelector('.connection-codex-provider'), details = node.querySelector('.connection-codex-more'), body = details.querySelector('.connection-codex-more-body');
      // Closed details use a content-visibility:hidden shadow slot; latent boxes are not paint visibility.
      return { id: node.dataset.codexModel, role: node.getAttribute('role'), rect: bounds(node), namePx: parseFloat(getComputedStyle(name).fontSize), providerPx: parseFloat(getComputedStyle(provider).fontSize), nameWhiteSpace: getComputedStyle(name).whiteSpace, name: bounds(name), provider: bounds(provider), detailsOpen: details.open, summary: details.querySelector('summary').textContent.trim(), detailsClientRects: [...body.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height })), detailsContentVisibility: getComputedStyle(details, '::details-content').contentVisibility, detailsVisible: body.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, opacityProperty: true }) };
    }) };
  });
  assert.equal(nativeRows.rows.length, 2); assert.ok(nativeRows.toolsClosed);
  assert.ok(nativeRows.rows.every((row, index, rows) => row.role === 'listitem' && row.rect.height >= 43 && row.rect.height <= 60 && row.namePx === 13 && row.providerPx === 11 && row.nameWhiteSpace === 'nowrap' && !row.detailsOpen && !row.detailsVisible && row.summary === 'Details' && row.name.right <= row.provider.left + .5 && (!index || row.rect.top >= rows[index - 1].rect.bottom - .5 && Math.abs(row.rect.left - rows[index - 1].rect.left) < 1 && Math.abs(row.rect.width - rows[index - 1].rect.width) < 1)));
  await fill('#connection-codex-search', 'fixture-no-tools');
  assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.connection-codex-models .connection-codex-list-row')].filter(node => !node.hidden).map(node => node.dataset.codexModel)), ['fixture-no-tools']);
  await fill('#connection-codex-search', ''); await frames(); await screenshot('25-models-native-list-desktop.jpg');
  await click('.connection-codex-models [data-codex-model="fixture-model"] .connection-codex-more > summary');
  await waitVisible('.connection-codex-models [data-codex-model="fixture-model"] .connection-codex-more-body');
  nativeRows.openedDetails = await evaluate(() => { const row = document.querySelector('.connection-codex-models [data-codex-model="fixture-model"]'), details = row.querySelector('.connection-codex-more'), body = row.querySelector('.connection-codex-more-body'); return { open: details.open, visible: body.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true, opacityProperty: true }), modelIdPresent: row.querySelector('.connection-codex-identity').textContent.includes('fixture-model') }; });
  nativeRows.revealedModelId = nativeRows.openedDetails.open && nativeRows.openedDetails.visible && nativeRows.openedDetails.modelIdPresent;
  assert.ok(nativeRows.revealedModelId); await click('.connection-codex-models [data-codex-model="fixture-model"] .connection-codex-more > summary');

  await click('[data-connection-new="compatible"]'); await waitVisible('#connection-form');
  await sampleDropdowns('provider editor', ['#connection-preset', '#connection-form select[name="type"]']);
  await click('.connection-manual > summary');
  for (const id of ['qa-local-manual-a', 'qa-local-manual-b']) { await fill('#connection-manual-model', id); await click('#connection-add-model'); }
  const manualRows = evidence.modelPickerList.manualRows = await evaluate(() => [...document.querySelectorAll('#connection-selected .connection-model-list-row')].map(node => { const r = node.getBoundingClientRect(), name = node.querySelector('strong'), checkbox = node.querySelector('input[type="checkbox"]'); return { id: checkbox.dataset.modelId, checked: checkbox.checked, top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, namePx: parseFloat(getComputedStyle(name).fontSize) }; }));
  assert.deepEqual(manualRows.map(row => row.id).sort(), ['qa-local-manual-a', 'qa-local-manual-b']);
  assert.ok(manualRows.every((row, index, rows) => row.checked && row.height >= 43 && row.height <= 62 && row.namePx === 13 && (!index || row.top >= rows[index - 1].bottom - .5)));
  await screenshot('26-provider-model-list-desktop.jpg'); await closeModal();
  assert.deepEqual(await api('/api/providers'), providerBefore, 'Unsaved manual model rows must not create or alter a provider.');
  evidence.modelPickerList.providerSettingsUnchanged = true;
  check('Model search, native catalogs and unsaved provider choices use compact single rows with secondary details and preserve the chat draft', pickerLayouts.length === 2 && nativeRows.revealedModelId && await preserved());
  flags.modelPickerList = true;
  check('Model, reasoning, planning, history and Settings dropdowns keep opaque dark option surfaces and at least 4.5:1 text contrast', dropdowns.length === 11 && dropdowns.some(sample => sample.items.some(item => item.disabled)) && popup.captured === true && await preserved());
  flags.modelReasoningContrast = true;

  const otherId = evidence.message.conversationId, currentTitle = 'QA renamed current chat', otherTitle = 'QA renamed other chat', archivedTitle = 'QA renamed archived chat'; evidence.chatRename = {};
  assert.notEqual(otherId, unavailableRun.id);
  const catalogEntry = async (bucket, id) => (await api('/api/conversations?state=' + bucket)).conversations.find(item => (item.taskId || item.rootId || item.id) === id);
  const saveName = async (title, bucket, id) => {
    await waitVisible('#conversation-name'); await fill('#conversation-name', title); assert.ok(await preserved());
    await click('#conversation-rename-save');
    await until('the exact renamed chat to be saved in ' + bucket, async () => !await visible('#conversation-name') && (await catalogEntry(bucket, id))?.title === title);
    await settleCatalog(); assert.ok(await preserved());
    return { id, title, bucket, persisted: (await catalogEntry(bucket, id))?.title === title, selectedTurns: (await composer()).runIds };
  };
  const rowMenu = async id => {
    await revealSidebar(); await waitVisible(`#conversation-list [data-chat-more][data-conversation-id="${id}"]`);
    await click(`#conversation-list [data-chat-more][data-conversation-id="${id}"]`); await waitVisible('.conversation-row-menu [data-chat-action="rename"]');
    assert.equal(await evaluate(() => document.querySelector('.conversation-row-menu [role="menuitem"]').dataset.chatAction), 'rename');
    assert.ok(await preserved());
  };
  await waitVisible('#conversation-rename-title'); await click('#conversation-rename-title'); await waitVisible('#conversation-name');
  await screenshot('28-rename-current-chat-desktop.jpg');
  const renamedCurrent = evidence.chatRename.current = await saveName(currentTitle, 'active', unavailableRun.id);
  assert.equal(await evaluate(() => document.querySelector('#conversation-title').textContent.trim()), currentTitle);
  await rowMenu(otherId); await click('.conversation-row-menu [data-chat-action="rename"]');
  const renamedOther = evidence.chatRename.other = await saveName(otherTitle, 'active', otherId);
  assert.equal(await evaluate(() => document.querySelector('#conversation-title').textContent.trim()), currentTitle);

  await rowMenu(otherId); await click('.conversation-row-menu [data-chat-action="archive"]');
  await until('the other chat to archive without changing the selected chat', async () => (await catalogEntry('archived', otherId))?.title === otherTitle && !await visible('.conversation-row-menu'));
  await settleCatalog(); assert.ok(await preserved());
  await select('#conversation-history-state', 'archived'); await resize(390, 844);
  await rowMenu(otherId); await key('Escape', 'Escape', 27); await key('F2', 'F2', 113); await waitVisible('#conversation-name');
  assert.equal(await evaluate(() => document.querySelector('#conversation-name').value), otherTitle);
  const renameLayout = evidence.chatRename.mobileControls = await evaluate(() => [...document.querySelectorAll('#conversation-name,#conversation-rename-save,#conversation-rename-cancel')].map(node => { const r = node.getBoundingClientRect(), front = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { id: node.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, hit: Boolean(front && node.contains(front)) }; }));
  assert.ok(renameLayout.every(rect => rect.width > 0 && rect.height >= 28 && rect.left >= -1 && rect.right <= 391 && rect.top >= 0 && rect.bottom <= 844 && rect.hit) && await geometry('390px archived chat rename'));
  await screenshot('29-rename-other-archived-chat-mobile.jpg');
  const renamedArchived = evidence.chatRename.archived = await saveName(archivedTitle, 'archived', otherId);
  assert.equal(await evaluate(() => document.querySelector('#conversation-title').textContent.trim()), currentTitle);
  await rowMenu(otherId); await click('.conversation-row-menu [data-chat-action="restore"]');
  await until('the renamed archived chat to return to active history', async () => (await catalogEntry('active', otherId))?.title === archivedTitle && !await visible('.conversation-row-menu'));
  await settleCatalog(); await select('#conversation-history-state', 'active'); await resize(1440, 900); await settleCatalog();
  evidence.chatRename = { current: renamedCurrent, other: renamedOther, archived: renamedArchived, renameFirstInRowMenus: true, archivedF2: true, mobileControls: renameLayout, draftPreserved: await preserved(), restoredTitle: (await catalogEntry('active', otherId))?.title };
  check('Header, other-row and archived chat rename persist the correct names while preserving the selected chat and draft', renamedCurrent.persisted && renamedOther.persisted && renamedArchived.persisted && evidence.chatRename.restoredTitle === archivedTitle && evidence.chatRename.draftPreserved && noDispatch());
  flags.chatRename = true;
  assert.equal(Object.keys(flags).length, 11); assert.ok(Object.values(flags).every(value => value === true)); assert.ok(await preserved());
}

/** No network engine: the real Observe UI receives explicit page receipts from this owned fixture. */
export class ContainedBrowserFixture extends EventEmitter {
  constructor() { super(); this.enabled = false; this.tabs = []; this.activeTab = null; this.counter = 0; this.requests = []; this.frameImage = ''; this.globalEnabled = true; this.exemptOrigins = new Set(); this.filterCount = 1000; }
  tabProtection(tab) { let origin = null; try { const url = new URL(tab.url); if (['https:', 'http:'].includes(url.protocol)) origin = url.origin; } catch {} const siteExempt = this.exemptOrigins.has(origin); return { tabId: tab.tabId, available: this.enabled, enabled: this.enabled && this.globalEnabled && !siteExempt, siteExempt, origin, blockedRequests: 5 }; }
  protectionStatus() { return { available: this.enabled, enabled: this.globalEnabled, ready: this.enabled, engine: 'Owned UI fixture', filterCount: this.filterCount, updatedAt: '2026-10-19T12:00:00Z', sources: [], refreshing: false, exemptOrigins: [...this.exemptOrigins], tabs: this.tabs.map(tab => this.tabProtection(tab)) }; }
  status() { return { available: this.enabled, contained: true, background: true, physicalInput: false, acceptingActions: this.enabled, busy: false, activeTab: this.activeTab, tabs: this.tabs.map(tab => ({ ...tab, protection: this.tabProtection(tab) })), browsers: { relay: { available: this.enabled } }, protection: this.protectionStatus() }; }
  updated() { this.emit('status', this.status()); }
  async perform(value, options = {}) {
    assert.equal(options.source, 'user'); assert.equal(value.browser, 'relay'); assert.equal(this.enabled, true); this.requests.push({ kind: 'page', ...structuredClone(value) });
    if (value.action === 'open') { const url = new URL(value.url); assert.ok(['https:', 'http:'].includes(url.protocol)); assert.equal(url.username, ''); assert.equal(url.password, ''); const tab = { tabId: 'qa-tab-' + ++this.counter, browser: 'relay', visible: false, title: `Owned page ${this.counter}`, url: url.href, loading: false }; this.tabs.push(tab); this.activeTab = tab.tabId; this.updated(); return this.document(tab); }
    const tab = this.tabs.find(tab => tab.tabId === value.tabId); assert.ok(tab, 'Only a current contained tab may receive an action.');
    if (value.action === 'screenshot') { assert.ok(this.frameImage.startsWith('data:image/png;base64,')); return { tabId: tab.tabId, width: 960, height: 540, imageUrl: this.frameImage, url: tab.url }; }
    if (value.action === 'snapshot') return this.document(tab);
    if (value.action === 'navigate') { const url = new URL(value.url); assert.ok(['http:', 'https:'].includes(url.protocol)); tab.url = url.href; this.activeTab = tab.tabId; this.updated(); return this.document(tab); }
    if (value.action === 'close') { this.tabs = this.tabs.filter(item => item !== tab); if (this.activeTab === tab.tabId) this.activeTab = this.tabs[0]?.tabId || null; this.updated(); return { tabId: tab.tabId, closed: true }; }
    if (['click', 'fill', 'press', 'scroll', 'select', 'back', 'forward'].includes(value.action)) return this.document(tab);
    throw Error('Unexpected contained browser fixture action.');
  }
  document(tab) { return { tabId: tab.tabId, url: tab.url, frames: [{ text: `Owned contained page fixture: ${tab.title}. No remote website was loaded.`, elements: [{ ref: 'qa-field-' + tab.tabId, role: 'textbox', type: 'text', name: 'Owned page input' }] }] }; }
  async configureProtection(value, options = {}) {
    assert.equal(options.source, 'user'); this.requests.push({ kind: 'protection', ...structuredClone(value) });
    if (value.action === 'global') this.globalEnabled = value.enabled;
    else if (value.action === 'refresh') this.filterCount++;
    else if (value.action === 'site') { const tab = this.tabs.find(tab => tab.tabId === value.tabId), origin = tab && this.tabProtection(tab).origin; if (!origin || origin !== value.origin) throw Object.assign(Error('The observed page changed. Refresh before changing its site protection.'), { status: 409 }); value.enabled ? this.exemptOrigins.delete(origin) : this.exemptOrigins.add(origin); }
    else throw Error('Unexpected protection fixture action.');
    this.updated(); return this.protectionStatus();
  }
  async cancel() {} async close() { this.tabs = []; this.activeTab = null; }
}

// Installed only around one save at a time in the owned disposable Planning fixture.
// These observers read DOM state; they never alter event defaults or retry work.
function installPlanningObjectiveDiagnostics(taskId) {
  globalThis.__qaPlanningObjectiveSave?.finish();
  const data = { taskId, snapshots: [], events: [], awarenessMutations: [] }, ids = new WeakMap(), timers = new Set();
  let nextId = 0, active = true;
  const identity = node => { if (!node) return null; if (!ids.has(node)) ids.set(node, ++nextId); return ids.get(node); };
  const describe = node => node ? { identity: identity(node), id: node.id || null, tag: node.tagName || node.nodeName, type: node.type || null, action: node.dataset?.planningAction || null, field: node.dataset?.planningField || null, child: node.dataset?.planningChild ?? null, childField: node.dataset?.childField || null, connected: node.isConnected } : null;
  const bounds = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const formInfo = node => { const form = node?.tagName === 'FORM' ? node : node?.form || node?.closest?.('form'); return form ? { ...describe(form), noValidate: form.noValidate, method: form.method } : null; };
  const snapshot = (phase, extra = {}) => {
    const save = document.querySelector('#planning-save'), form = document.querySelector('#planning-editor-form'), goal = document.querySelector('[data-planning-field="goal"]'), layout = document.querySelector('[data-planning-field="layout"]'), panel = document.querySelector('#planning-editor-panel'), awareness = document.querySelector('#planning-editor-awareness'), rect = bounds(save);
    const controls = [...(form?.querySelectorAll('input,textarea,select') || [])];
    // Read ValidityState directly: checkValidity/reportValidity would dispatch
    // invalid events and could change the native submission being diagnosed.
    const fields = controls.slice(0, 32).map(node => ({ ...describe(node), value: String(node.value).slice(0, 1500), valueTruncated: String(node.value).length > 1500, checked: node.type === 'checkbox' ? node.checked : undefined, required: node.required, disabled: node.disabled, willValidate: node.willValidate, valid: node.validity?.valid ?? null, valueMissing: node.validity?.valueMissing ?? null, validationMessage: node.validationMessage?.slice(0, 300) || '', rect: bounds(node) }));
    return { phase, at: performance.now(), ...extra, mountedTask: document.querySelector('#planning-plan-mount')?.dataset.planTask || null, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, save: save ? { ...describe(save), disabled: save.disabled, formAttribute: save.getAttribute('form'), form: formInfo(save), rect, hitAtCenter: describe(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) } : null, form: formInfo(form), formValid: Boolean(form) && controls.every(node => !node.willValidate || node.validity.valid), fields, fieldCount: controls.length, fieldsTruncated: controls.length > fields.length, fieldsetDisabled: form?.querySelector('fieldset')?.disabled ?? null, goal: goal ? { ...describe(goal), value: goal.value, rect: bounds(goal) } : null, layout: layout ? { ...describe(layout), value: layout.value, rect: bounds(layout) } : null, editorScrollTop: panel?.scrollTop ?? null, editorRect: bounds(panel), revision: document.querySelector('#planning-editor-revision')?.textContent || '', messages: document.querySelector('#planning-editor-messages')?.textContent?.slice(0, 2000) || '', activeElement: describe(document.activeElement), awareness: awareness ? { ...describe(awareness), rect: bounds(awareness), text: awareness.textContent.slice(0, 1200), html: awareness.innerHTML.slice(0, 4000) } : null };
  };
  const capture = (phase, extra) => { if (!active) return null; const value = snapshot(phase, extra); if (data.snapshots.length < 100) data.snapshots.push(value); return value; };
  const kinds = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'submit', 'invalid'];
  const eventCapture = event => {
    if (!active || data.events.length >= 48) return;
    const entry = { type: event.type, at: performance.now(), trusted: event.isTrusted, target: describe(event.target), targetForm: formInfo(event.target), submitter: describe(event.submitter), clientX: event.clientX ?? null, clientY: event.clientY ?? null, button: event.button ?? null, pointerId: event.pointerId ?? null, defaultPreventedAtCapture: event.defaultPrevented, state: snapshot('event-' + event.type) };
    data.events.push(entry);
    const timer = setTimeout(() => { timers.delete(timer); if (active) { entry.defaultPreventedAfterTask = event.defaultPrevented; entry.afterTask = snapshot('after-' + event.type); } }, 0); timers.add(timer);
  };
  for (const kind of kinds) document.addEventListener(kind, eventCapture, true);
  const awareness = document.querySelector('#planning-editor-awareness'), observer = new MutationObserver(records => {
    if (!active || data.awarenessMutations.length >= 48) return;
    data.awarenessMutations.push({ at: performance.now(), records: records.slice(0, 12).map(record => ({ type: record.type, target: describe(record.target), attribute: record.attributeName, added: [...record.addedNodes].slice(0, 8).map(describe), removed: [...record.removedNodes].slice(0, 8).map(describe) })), state: snapshot('awareness-mutation') });
  });
  if (awareness) observer.observe(awareness, { childList: true, subtree: true, attributes: true, characterData: true });
  globalThis.__qaPlanningObjectiveSave = { capture, finish() { capture('capture-finished'); active = false; observer.disconnect(); for (const kind of kinds) document.removeEventListener(kind, eventCapture, true); for (const timer of timers) clearTimeout(timer); timers.clear(); return data; } };
  capture('capture-installed');
}

async function planningJourney({ api, app, runtime, cdp, session, origin, report, completed, unavailableRun, swarm, evaluate, until, visible, waitVisible, click, fill, select, frames, key, closeModal, composer, resize, screenshot, geometry, check }) {
  const evidence = report.recovery.planning = {}, taskId = completed.taskId || completed.id, callsBefore = runtime.calls.length;
  const editorSettled = revision => until('the Planning editor saved revision and enabled fields', () => evaluate(revision => { const fieldset = document.querySelector('#planning-editor-form > fieldset'); return fieldset && !fieldset.disabled && document.querySelector('#planning-editor-revision')?.textContent === `Revision ${revision}`; }, revision));
  const structure = async () => { if (!await evaluate(() => document.querySelector('[data-planning-disclosure="structure"]')?.open)) await click('[data-planning-disclosure="structure"] > summary'); };
  await closeModal(); await resize(1440); await click('#workspace-modes [data-mode="view"]'); await waitVisible('#mission-task');
  const retained = await composer(); evidence.retainedDraftLength = retained.draft.length;
  await click('#workspace-modes [data-mode="planning"]'); await waitVisible('#planning-catalog-list');
  const catalog = await api('/api/planning'); assert.ok(catalog.plans.some(plan => plan.taskId === taskId));
  await waitVisible(`[data-planning-task="${taskId}"]`); await click(`[data-planning-task="${taskId}"]`);
  await until('the selected saved Planning task', () => evaluate(taskId => document.querySelector('#planning-plan-mount')?.dataset.planTask === taskId, taskId));
  await click('#planning-task-bar [data-planning-action="objective"]'); await waitVisible('[data-planning-field="goal"]');
  const original = await api(`/api/tasks/${taskId}`), objective = 'QA shared Planning workspace: edit the same durable objective and dependency graph.';
  const diagnostic = evidence.objectiveSaveDiagnostics = { fixtureOnly: true, taskId, expected: { goal: objective, layout: 'parallel', previousRevision: original.revision }, network: [], presence: { network: [] } };
  const presenceUrl = origin + `/api/tasks/${encodeURIComponent(taskId)}/plan/presence`;
  const network = cdp.planningSaveDiagnostics = { sessionId: session, url: origin + `/api/tasks/${encodeURIComponent(taskId)}/plan/edit`, presenceUrl, requests: diagnostic.network, presenceRequests: diagnostic.presence.network };
  const previousPresenceIntercept = cdp.interceptRequest;
  let saved, heldPresence, presenceTimer, presenceRelease, savePoint, mousePressed = false, fetchEnabled = false;
  const releasePresence = reason => {
    clearTimeout(presenceTimer);
    if (!heldPresence) return Promise.resolve();
    if (!presenceRelease) {
      diagnostic.presence.releaseReason = reason; diagnostic.presence.releaseAt = Date.now();
      presenceRelease = cdp.call('Fetch.continueRequest', { requestId: heldPresence.requestId }, heldPresence.sessionId, { cleanup: true });
    }
    return presenceRelease;
  };
  cdp.interceptRequest = async (params, targetSession) => {
    if (!heldPresence && targetSession === session && params.request.url === presenceUrl && params.request.method === 'POST') {
      heldPresence = { requestId: params.requestId, networkId: params.networkId, sessionId: targetSession };
      Object.assign(diagnostic.presence, { heldAt: Date.now(), requestId: params.requestId, networkId: params.networkId, request: JSON.parse(params.request.postData || '{}') });
      presenceTimer = setTimeout(() => { diagnostic.presence.deadlineReleased = true; void releasePresence('hold-deadline').catch(error => { diagnostic.presence.releaseError = error.message; }); }, 3500);
      return;
    }
    await cdp.call('Fetch.continueRequest', { requestId: params.requestId }, targetSession, { cleanup: true });
  };
  try {
    await cdp.call('Fetch.enable', { patterns: [{ urlPattern: presenceUrl, requestStage: 'Request' }] }, session); fetchEnabled = true;
    await evaluate(installPlanningObjectiveDiagnostics, taskId);
    await fill('[data-planning-field="goal"]', objective); await evaluate(() => globalThis.__qaPlanningObjectiveSave.capture('after-goal-fill'));
    await select('[data-planning-field="layout"]', 'parallel'); await evaluate(() => globalThis.__qaPlanningObjectiveSave.capture('before-save-click'));
    await until('the exact owned objective editing-presence request to be held', () => heldPresence, 3000);
    assert.equal(diagnostic.presence.deadlineReleased, undefined); assert.ok(diagnostic.presence.request.editorId); assert.equal(diagnostic.presence.request.stepId, null);
    assert.equal(await evaluate(() => Boolean(document.querySelector('#planning-editor-awareness .planning-presence'))), false, 'The editing badge must still be absent while its first presence request is held.');
    savePoint = await evaluate(() => {
      const node = document.querySelector('#planning-save'); if (!node || node.disabled) throw Error('Missing or disabled Planning Save.');
      node.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = node.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (!r.width || !r.height || node.closest('[hidden],[inert]') || !node.contains(document.elementFromPoint(x, y))) throw Error('The Planning Save point is not reachable.');
      const before = globalThis.__qaPlanningObjectiveSave.capture('presence-before-mousedown', { x, y });
      return { x, y, save: before.save, editorScrollTop: before.editorScrollTop };
    });
    diagnostic.presence.before = savePoint;
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: savePoint.x, y: savePoint.y }, session); mousePressed = true;
    assert.equal(diagnostic.presence.deadlineReleased, undefined, 'Presence must remain held until after the native Save press.');
    await releasePresence('after-native-mousedown');
    await until('the held presence HTTP acknowledgment and visible editing badge', async () => {
      const request = diagnostic.presence.network.find(item => item.requestId === heldPresence.networkId);
      return request?.status === 200 && request.finished && await evaluate(() => /You.*are editing/.test(document.querySelector('#planning-editor-awareness .planning-presence')?.textContent || ''));
    }, 3000);
    await frames();
    diagnostic.presence.after = await evaluate(({ x, y }) => {
      const after = globalThis.__qaPlanningObjectiveSave.capture('presence-after-ack-before-mouseup', { x, y }), node = document.querySelector('#planning-save');
      return { save: after.save, editorScrollTop: after.editorScrollTop, originalPointStillHitsSave: Boolean(node?.contains(document.elementFromPoint(x, y))) };
    }, { x: savePoint.x, y: savePoint.y });
    assert.equal(diagnostic.presence.after.save.identity, savePoint.save.identity, 'Presence must preserve the physically pressed Save button.');
    assert.deepEqual(diagnostic.presence.after.save.rect, savePoint.save.rect, 'Presence must not move Save while the pointer is down.');
    assert.equal(diagnostic.presence.after.originalPointStillHitsSave, true); assert.equal(diagnostic.presence.after.save.disabled, false);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: savePoint.x, y: savePoint.y }, session); mousePressed = false;
    await evaluate(() => globalThis.__qaPlanningObjectiveSave.capture('after-save-click'));
    saved = await until('the objective to be saved by the Planning editor', async () => { const state = await api(`/api/tasks/${taskId}`); return state.goal === objective && state.revision > original.revision && state; });
    await editorSettled(saved.revision); assert.deepEqual(saved.steps, original.steps); assert.deepEqual(saved.artifacts, original.artifacts); assert.equal(saved.plan.layout, 'parallel');
    await until('the one completed objective-save HTTP receipt', () => diagnostic.network.some(request => request.finished), 2000);
    assert.equal(diagnostic.network.length, 1); assert.equal(diagnostic.network[0].status, 200);
    assert.deepEqual(JSON.parse(diagnostic.network[0].postData), { expectedRevision: original.revision, operations: [{ type: 'metadata', patch: { goal: objective, layout: 'parallel' } }] });
    assert.equal(saved.revision, original.revision + 1);
    diagnostic.saved = { revision: saved.revision, goal: saved.goal, layout: saved.plan.layout };
    check('A delayed editing-presence acknowledgment across a native Save press keeps its button in place and commits exactly one objective edit'); report.features.planningPresenceGesture = true;
  } catch (error) {
    diagnostic.failure = error.message;
    throw error;
  } finally {
    clearTimeout(presenceTimer);
    await releasePresence('cleanup').catch(error => { diagnostic.presence.releaseError = error.message; });
    if (mousePressed && savePoint) await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 0, y: 0 }, session, { cleanup: true }).catch(error => { diagnostic.mouseReleaseError = error.message; });
    if (fetchEnabled) await cdp.call('Fetch.disable', {}, session, { cleanup: true }).catch(error => { diagnostic.fetchCleanupError = error.message; });
    cdp.interceptRequest = previousPresenceIntercept;
    if (cdp.planningSaveDiagnostics === network) cdp.planningSaveDiagnostics = null;
    if (diagnostic.failure) diagnostic.finalTask = await api(`/api/tasks/${taskId}`).catch(readError => ({ diagnosticReadError: readError.message }));
    diagnostic.dom = await evaluate(() => { const value = globalThis.__qaPlanningObjectiveSave?.finish(); delete globalThis.__qaPlanningObjectiveSave; return value || null; }).catch(error => ({ diagnosticError: error.message }));
    for (const request of diagnostic.network) if (request.finished) {
      try { const response = await cdp.call('Network.getResponseBody', { requestId: request.requestId }, session, { cleanup: true }), body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body; request.responseBody = body.slice(0, 65536); request.responseBodyTruncated = body.length > 65536; }
      catch (error) { request.responseBodyError = error.message; }
    }
    if (!diagnostic.failure && (diagnostic.fetchCleanupError || diagnostic.mouseReleaseError)) throw Error('Planning presence fixture cleanup failed: ' + (diagnostic.fetchCleanupError || diagnostic.mouseReleaseError));
  }
  const addAction = async (title, doneWhen, dependency) => {
    const previous = await api(`/api/tasks/${taskId}`); await click('#planning-task-bar [data-planning-action="add"]'); await waitVisible('[data-planning-field="title"]'); await fill('[data-planning-field="title"]', title); await fill('[data-planning-field="doneWhen"]', doneWhen);
    if (dependency) await click(`[data-planning-dependency="${dependency}"]`); await click('#planning-save');
    const result = await until('the saved step ' + title, async () => { const state = await api(`/api/tasks/${taskId}`), step = state.steps.find(step => step.title === title); return state.revision > previous.revision && step && { state, step }; });
    await editorSettled(result.state.revision); return result;
  };
  const first = await addAction('QA inspect independent input', 'The owned local input and constraints are recorded.');
  const second = await addAction('QA use the checked input', 'The result uses the checked input and records its limitations.', first.step.id);
  assert.equal(second.state.availableWork.byId[first.step.id].state, 'ready'); assert.equal(second.state.availableWork.byId[second.step.id].state, 'waiting');
  await structure(); await select('[data-planning-field="beforeId"]', first.step.id); await click('#planning-save');
  saved = await until('the explicit step position to save without deleting its prerequisite', async () => { const state = await api(`/api/tasks/${taskId}`); return state.steps.findIndex(step => step.id === second.step.id) < state.steps.findIndex(step => step.id === first.step.id) && state; });
  await editorSettled(saved.revision); assert.deepEqual(saved.steps.find(step => step.id === second.step.id).dependsOn, [first.step.id]);
  evidence.editor = { taskId, originalRevision: original.revision, revision: saved.revision, objective, independentStep: first.step.id, dependentStep: second.step.id, ready: saved.availableWork.byId[first.step.id], waiting: saved.availableWork.byId[second.step.id], reorderedWithoutLosingDependencies: true, retainedRegisteredFiles: saved.artifacts?.length || 0 };
  check('Planning edits the real saved objective, creates ready and dependent actions, and reorders without losing evidence or dependencies', runtime.calls.length === callsBefore && saved.goal === objective && saved.artifacts.length === original.artifacts.length);
  report.features.planningSharedEditor = true;

  // Hold one actual browser POST while the real store receives newer agent progress.
  await click('#planning-task-bar [data-planning-action="objective"]'); await click('#planning-task-bar [data-planning-action="add"]'); await waitVisible('[data-planning-field="title"]'); await fill('[data-planning-field="title"]', 'QA choose an implementation path'); await select('[data-planning-field="kind"]', 'choice');
  for (const [index, title, condition] of [[0, 'Use the local approach', 'The owned input is entirely local.'], [1, 'Inspect a connected source', 'The source is already connected and inspection is authorized.']]) { await fill(`[data-planning-child="${index}"][data-child-field="title"]`, title); await fill(`[data-planning-child="${index}"][data-child-field="doneWhen"]`, `${title} has an observed, recorded result.`); await fill(`[data-planning-child="${index}"][data-child-field="condition"]`, condition); }
  const branchDiagnostic = evidence.branchSaveDiagnostics = { fixtureOnly: true, taskId, expected: { title: 'QA choose an implementation path', kind: 'choice', childCount: 2 }, network: [] };
  const previousSaveDiagnostics = cdp.planningSaveDiagnostics, branchNetwork = cdp.planningSaveDiagnostics = { sessionId: session, url: origin + `/api/tasks/${encodeURIComponent(taskId)}/plan/edit`, requests: branchDiagnostic.network };
  let branch;
  try {
    await evaluate(installPlanningObjectiveDiagnostics, taskId);
    await evaluate(() => globalThis.__qaPlanningObjectiveSave.capture('branch-before-save'));
    await click('#planning-save');
    await evaluate(() => globalThis.__qaPlanningObjectiveSave.capture('branch-after-save-click'));
    branch = await until('an atomic branch and both child paths', async () => { const state = await api(`/api/tasks/${taskId}`), group = state.steps.find(step => step.title === 'QA choose an implementation path'); return group && state.steps.filter(step => step.parentId === group.id).length === 2 && { state, group }; });
    branchDiagnostic.saved = { revision: branch.state.revision, group: branch.group, children: branch.state.steps.filter(step => step.parentId === branch.group.id) };
  } catch (error) {
    branchDiagnostic.failure = error.message;
    branchDiagnostic.finalTask = await api(`/api/tasks/${taskId}`).catch(readError => ({ diagnosticReadError: readError.message }));
    await screenshot('30a-planning-branch-submit-failure.jpg').catch(captureError => { branchDiagnostic.screenshotError = captureError.message; });
    throw error;
  } finally {
    if (cdp.planningSaveDiagnostics === branchNetwork) cdp.planningSaveDiagnostics = previousSaveDiagnostics;
    branchDiagnostic.dom = await evaluate(() => { const value = globalThis.__qaPlanningObjectiveSave?.finish(); delete globalThis.__qaPlanningObjectiveSave; return value || null; }).catch(error => ({ diagnosticError: error.message }));
    for (const request of branchDiagnostic.network) if (request.finished) {
      try { const response = await cdp.call('Network.getResponseBody', { requestId: request.requestId }, session, { cleanup: true }), body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body; request.responseBody = body.slice(0, 65536); request.responseBodyTruncated = body.length > 65536; }
      catch (error) { request.responseBodyError = error.message; }
    }
  }
  await editorSettled(branch.state.revision); const child = branch.state.steps.find(step => step.parentId === branch.group.id);
  await structure(); await select('[data-planning-field="selectedChildId"]', child.id); await click('#planning-save');
  const chosen = await until('the explicit saved branch choice', async () => { const state = await api(`/api/tasks/${taskId}`); return state.steps.find(step => step.id === branch.group.id)?.selectedChildId === child.id && state; }); await editorSettled(chosen.revision);
  evidence.branch = { id: branch.group.id, chosen: child.id, atomicChildren: 2 };
  check('The Planning editor creates a validated branching structure and saves an explicit path choice', runtime.calls.length === callsBefore);
  // Select by the real tree row so its external editor callback is also exercised.
  await click('#planning-plan-mount [data-plan-action="view-outline"]');
  await waitVisible(`#planning-plan-mount [role="treeitem"][data-plan-node="${first.step.id}"]`); await click(`#planning-plan-mount [role="treeitem"][data-plan-node="${first.step.id}"]`);
  await waitVisible('[data-planning-field="title"]'); const authoredTitle = 'QA human correction kept through a competing agent revision'; await fill('[data-planning-field="title"]', authoredTitle);
  await evaluate(() => { const field = document.querySelector('[data-planning-field="title"]'); field.focus(); field.setSelectionRange(3, 17, 'backward'); globalThis.__qaPlanningField = field; });
  let held; const previousIntercept = cdp.interceptRequest; cdp.interceptRequest = async (params, targetSession) => {
    if (!held && targetSession === session && params.request.method === 'POST' && new URL(params.request.url).pathname === `/api/tasks/${taskId}/plan/edit`) { held = params; return; }
    return cdp.call('Fetch.continueRequest', { requestId: params.requestId }, targetSession);
  };
  await cdp.call('Fetch.enable', { patterns: [{ urlPattern: origin + `/api/tasks/${taskId}/plan/edit`, requestStage: 'Request' }] }, session);
  try {
    await click('#planning-save'); await until('the held Planning edit request', () => held);
    const before = await api(`/api/tasks/${taskId}`), agent = await app.tasks.editPlan(taskId, { operations: [{ type: 'update', stepId: first.step.id, patch: { status: 'active', note: 'The owned agent fixture recorded newer progress while the human was editing.' } }] }, { expectedRevision: before.revision, source: 'agent' });
    await cdp.call('Fetch.continueRequest', { requestId: held.requestId }, session); held = { released: true };
    await until('the revision conflict review control', () => visible('#planning-editor-messages [data-planning-action="review"]'));
    const conflict = await evaluate(() => ({ value: document.querySelector('[data-planning-field="title"]').value, sameField: document.querySelector('[data-planning-field="title"]') === globalThis.__qaPlanningField, messages: document.querySelector('#planning-editor-messages').textContent, selection: [globalThis.__qaPlanningField.selectionStart, globalThis.__qaPlanningField.selectionEnd, globalThis.__qaPlanningField.selectionDirection] }));
    assert.equal(conflict.value, authoredTitle); assert.equal(conflict.sameField, true); assert.equal((await api(`/api/tasks/${taskId}`)).steps.find(step => step.id === first.step.id).status, 'active');
    await screenshot('30-planning-revision-conflict-desktop.jpg'); await click('#planning-editor-messages [data-planning-action="review"]'); await waitVisible('#planning-editor-messages [data-planning-action="use-review"]'); await click('#planning-editor-messages [data-planning-action="use-review"]'); await click('#planning-save');
    const merged = await until('the reviewed human correction on the newer agent revision', async () => { const state = await api(`/api/tasks/${taskId}`), step = state.steps.find(step => step.id === first.step.id); return step.title === authoredTitle && state.revision > agent.revision && { state, step }; });
    await editorSettled(merged.state.revision); assert.equal(merged.step.status, 'active'); assert.equal(merged.step.note, agent.steps.find(step => step.id === first.step.id).note); evidence.conflict = { ...conflict, agentRevision: agent.revision, savedRevision: merged.state.revision, preservedAgentStatus: merged.step.status, preservedAgentNote: merged.step.note };
    check('A real Planning 409 preserves the authored field and requires review before saving on the newer agent revision', conflict.sameField && merged.step.status === 'active'); report.features.planningRevisionConflict = true;
  } finally { if (held?.requestId) await cdp.call('Fetch.continueRequest', { requestId: held.requestId }, session).catch(() => {}); await cdp.call('Fetch.disable', {}, session); cdp.interceptRequest = previousIntercept; await evaluate(() => { delete globalThis.__qaPlanningField; }); }
  for (const width of [390, 320]) {
    await resize(width, 844); await click('.planning-mobile-tabs button[data-planning-pane="plan"]'); await frames(); const planFits = await geometry(`${width}px Planning plan`); await click('.planning-mobile-tabs button[data-planning-pane="edit"]'); await waitVisible('[data-planning-field="title"]'); await frames();
    const editor = await evaluate(() => { const fields = [...document.querySelectorAll('#planning-editor-panel input:not([type="checkbox"]),#planning-editor-panel textarea,#planning-editor-panel select')].filter(node => node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })); return { fields: fields.map(node => { const r = node.getBoundingClientRect(); return { width: r.width, left: r.left, right: r.right, fontSize: parseFloat(getComputedStyle(node).fontSize) }; }), visiblePanes: [...document.querySelectorAll('.planning-layout > *')].filter(node => !node.hidden && !node.inert && node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })).length }; });
    assert.equal(editor.visiblePanes, 1); assert.ok(editor.fields.length && editor.fields.every(field => field.width >= 60 && field.left >= -1 && field.right <= width + 1 && field.fontSize >= 11)); assert.ok(planFits && await geometry(`${width}px Planning editor`)); evidence[`mobile${width}`] = editor; await screenshot(`31-planning-editor-${width}.jpg`);
    await click('.planning-mobile-tabs button[data-planning-pane="saved"]'); await waitVisible('#planning-search'); assert.ok(await geometry(`${width}px saved plan catalog`));
  }
  await resize(1440); await click('#workspace-modes [data-mode="view"]'); await waitVisible('#mission-task'); const back = await composer(); assert.equal(back.draft, retained.draft); assert.deepEqual(back.runIds, retained.runIds); report.features.planningMobile = true;
  check('Planning at 320px and 390px keeps usable panes and returns to the unchanged selected chat draft', back.draft === retained.draft && runtime.calls.length === callsBefore);

  // Bind a distinct saved runtime fixture to an existing disposable chat. Its
  // worker statuses are fixture data; dispatch remains covered by backend tests.
  const swarmTask = unavailableRun.taskId || unavailableRun.id, fixtureRun = 'qa-owned-swarm-' + unavailableRun.id;
  const workers = swarm.nodes.filter(node => node.type === 'agent' && node.id !== 'coordinator'); const shared = structuredClone(swarm); shared.edges.push({ id: 'qa-specialist-dependency', source: workers[0].id, target: workers[1].id });
  let sharedState = await app.tasks.bindWorkflow(swarmTask, shared, { runId: fixtureRun, nodeStates: Object.fromEntries(shared.nodes.filter(node => node.type === 'agent').map(node => [node.id, { status: node.id === 'coordinator' ? 'waiting' : 'queued' }])) });
  sharedState = await api(`/api/tasks/${swarmTask}/plan/edit`, 'POST', { expectedRevision: sharedState.revision, operations: [{ type: 'metadata', patch: { goal: 'QA saved shared swarm: independent work proceeds while the coordinator waits.' } }] });
  const sharedCatalogPlan = (await api(`/api/planning?state=active&taskId=${encodeURIComponent(swarmTask)}`)).plans.find(plan => plan.taskId === swarmTask);
  assert.ok(sharedCatalogPlan); assert.equal(sharedCatalogPlan.goal, sharedState.goal); assert.equal(sharedCatalogPlan.revision, sharedState.revision);
  await click('#workspace-modes [data-mode="planning"]');
  await until('the refreshed saved swarm catalog entry with its effective display title', () => evaluate((id, title) => { const row = document.querySelector(`#planning-catalog-list [data-planning-task="${id}"]`); return row?.querySelector('strong')?.textContent === title && /^\d+ active plans?$/.test(document.querySelector('#planning-catalog-status')?.textContent || ''); }, swarmTask, sharedCatalogPlan.title));
  await waitVisible(`#planning-catalog-list [data-planning-task="${swarmTask}"]`); await click(`#planning-catalog-list [data-planning-task="${swarmTask}"]`);
  await until('the saved swarm task in the shared plan renderer', () => evaluate(id => document.querySelector('#planning-plan-mount').dataset.planTask === id, swarmTask));
  await click('#planning-task-bar [data-planning-action="objective"]'); await waitVisible('[data-planning-field="goal"]');
  await until('the actual saved swarm objective and executable revision', () => evaluate((goal, revision) => document.querySelector('[data-planning-field="goal"]').value === goal && document.querySelector('#planning-editor-revision').textContent === `Revision ${revision}`, sharedState.goal, sharedState.revision));
  const firstId = 'agent-' + workers[0].id, dependentId = 'agent-' + workers[1].id, independentId = 'agent-' + workers[2].id, coordinatorId = 'agent-coordinator';
  evidence.swarm = { taskId: swarmTask, runtimeFixture: true, displayTitle: sharedCatalogPlan.title, goal: sharedState.goal, revision: sharedState.revision, ready: sharedState.availableWork.byId[independentId], dependent: sharedState.availableWork.byId[dependentId], coordinator: sharedState.availableWork.byId[coordinatorId], first: sharedState.availableWork.byId[firstId] };
  assert.equal(evidence.swarm.ready.state, 'ready'); assert.equal(evidence.swarm.dependent.state, 'waiting'); assert.ok(['waiting', 'blocked'].includes(evidence.swarm.coordinator.state));
  await waitVisible('#planning-plan-mount .task-plan-row-owner'); const owners = await evaluate(() => [...document.querySelectorAll('#planning-plan-mount .task-plan-row-owner')].map(node => node.textContent)); assert.ok(owners.some(text => text.includes(workers[2].name)));
  await screenshot('32-planning-swarm-readiness-desktop.jpg'); check('The same saved plan renderer shows explicit owners, independent ready work and real dependency waits while the coordinator is held', owners.length >= workers.length && runtime.calls.length === callsBefore); report.features.swarmSharedReadiness = true;
  await planningAwarenessJourney({ api, app, runtime, report, taskId: swarmTask, runId: fixtureRun, workers: [workers[0], workers[2]], evaluate, until, visible, waitVisible, click, fill, frames, resize, screenshot, geometry, check });
  await click('#workspace-modes [data-mode="view"]'); await waitVisible('#mission-task'); assert.equal((await composer()).draft, retained.draft);
}

/** The model is not asked to comply with an edit here. Two controlled tool
 * adapters exercise production admission, delivery receipts and actual local
 * reads while the real browser authors a human edit through authenticated HTTP.
 */
async function planningAwarenessJourney({ api, app, runtime, report, taskId, runId, workers, evaluate, until, visible, waitVisible, click, fill, frames, resize, screenshot, geometry, check }) {
  const evidence = report.recovery.planningAwareness = { taskId, runId, modelTurnsAdded: 0, fixture: 'Two controlled scoped tool adapters using production Planning guards, task handlers and local workspace readers; browser-authored saved edit and rendered status.' };
  const { createPlanningWorkerGuard, wrapPlanningToolHandler } = await import(pathToFileURL(path.join(report.candidate, 'lib/planning-awareness.mjs')).href);
  const { createTaskToolHandler } = await import(pathToFileURL(path.join(report.candidate, 'lib/task-state.mjs')).href);
  const { createWorkspaceToolHandler } = await import(pathToFileURL(path.join(report.candidate, 'lib/workspace-tools.mjs')).href);
  const firstId = 'agent-' + workers[0].id, independentId = 'agent-' + workers[1].id, modelCalls = runtime.calls.length, adapters = [];
  const readCall = { name: 'relay_task', arguments: { action: 'read' } }, operation = { name: 'relay_workspace', arguments: { action: 'read', path: 'qa-source.txt' } };
  const receiptValue = receipt => { assert.equal(receipt.success, true, JSON.stringify(receipt)); return JSON.parse(receipt.contentItems[0].text); };
  const awareness = () => api(`/api/tasks/${taskId}/plan/awareness`);
  const workerText = id => evaluate(id => [...document.querySelectorAll('#planning-editor-awareness [data-planning-worker]')].find(node => node.dataset.planningWorker === id)?.textContent || '', id);
  const openReceipts = async () => { await waitVisible('#planning-editor-awareness [data-planning-disclosure="awareness"] > summary'); if (!await evaluate(() => document.querySelector('#planning-editor-awareness [data-planning-disclosure="awareness"]').open)) await click('#planning-editor-awareness [data-planning-disclosure="awareness"] > summary'); };
  try {
    for (const [index, worker] of workers.entries()) {
      const scopeStepId = index === 0 ? firstId : independentId;
      const guard = await createPlanningWorkerGuard({ store: app.tasks, taskId, runId, nodeId: worker.id, label: worker.name, scopeStepId }); assert.ok(guard);
      const taskHandler = createTaskToolHandler({ store: app.tasks, taskId, runId, nodeId: worker.id, scopeStepId, worker: true });
      const workspace = createWorkspaceToolHandler({ cwd: runtime.cwd, runId, nodeId: worker.id });
      const adapter = { id: guard.id, scopeStepId, guard, executedReads: 0 };
      adapter.call = wrapPlanningToolHandler(guard, async call => {
        const review = await guard.before(call); if (review) return review;
        if (call.name === 'relay_task') return guard.after(call, await taskHandler(call));
        assert.equal(call.name, 'relay_workspace'); assert.deepEqual(call.arguments, operation.arguments); adapter.executedReads++;
        return workspace(call);
      });
      adapters.push(adapter);
      if (index === 1) { const delivered = receiptValue(await adapter.call(readCall)); assert.equal(delivered.planningAwareness.worker.id, adapter.id); assert.equal(delivered.planningAwareness.worker.lastReadRevision, delivered.revision); }
    }
    const before = await api(`/api/tasks/${taskId}`), originalStep = before.steps.find(step => step.id === firstId); assert.ok(originalStep);
    evidence.beforeRevision = before.revision;
    await click('#planning-plan-mount [data-plan-action="view-outline"]'); await waitVisible(`#planning-plan-mount [role="treeitem"][data-plan-node="${firstId}"]`); await click(`#planning-plan-mount [role="treeitem"][data-plan-node="${firstId}"] > .task-plan-row`); await waitVisible('[data-planning-field="title"]');
    await until('the selected awareness fixture step', () => evaluate(title => document.querySelector('[data-planning-field="title"]').value === title, originalStep.title));
    await until('the unread worker shown honestly in Planning', async () => (await workerText(adapters[0].id)).includes('No plan read recorded'));
    await openReceipts();
    const correction = 'QA human correction: check the saved input before completing this assignment.';
    await evaluate(() => { globalThis.__qaAwarenessField = document.querySelector('[data-planning-field="title"]'); });
    await fill('[data-planning-field="title"]', correction);
    const editing = await until('the browser editing lease in the real awareness API', async () => { const value = await awareness(); return value.presence.find(editor => editor.stepId === firstId) && value; });
    const editor = editing.presence.find(item => item.stepId === firstId);
    assert.equal((await api(`/api/tasks/${taskId}`)).revision, before.revision); assert.equal((await api(`/api/tasks/${taskId}`)).steps.find(step => step.id === firstId).title, originalStep.title);
    assert.deepEqual(Object.keys(editor).sort(), ['actor', 'editorId', 'expiresAt', 'label', 'stepId', 'taskId'].sort());
    await until('the own editing badge in the rendered inspector', () => evaluate(() => /You.*are editing/.test(document.querySelector('#planning-editor-awareness').textContent)));
    assert.equal(await evaluate(() => document.querySelector('[data-planning-field="title"]') === globalThis.__qaAwarenessField), true, 'The first editing-presence render must retain the actual input.');
    await evaluate(() => { const field = document.querySelector('[data-planning-field="title"]'); globalThis.__qaAwarenessSave = document.querySelector('#planning-save'); field.focus(); field.setSelectionRange(4, 13, 'backward'); document.querySelector('#planning-editor-panel').scrollTop = 0; });
    const deliveredWhileEditing = receiptValue(await adapters[0].call(readCall)); assert.ok(deliveredWhileEditing.planningAwareness.presence.some(item => item.editorId === editor.editorId));
    const advisory = receiptValue(await adapters[0].call(operation)); assert.equal(readText(advisory.content), SOURCE);
    await until('the first delivered worker revision in the rendered receipt', async () => (await workerText(adapters[0].id)).includes(`Read revision ${before.revision}`)); await frames();
    evidence.draftIdentity = await evaluate(() => ({ sameField: document.querySelector('[data-planning-field="title"]') === globalThis.__qaAwarenessField, sameSave: document.querySelector('#planning-save') === globalThis.__qaAwarenessSave, focused: document.activeElement === globalThis.__qaAwarenessField, selection: [globalThis.__qaAwarenessField.selectionStart, globalThis.__qaAwarenessField.selectionEnd, globalThis.__qaAwarenessField.selectionDirection], draft: globalThis.__qaAwarenessField.value }));
    assert.equal(evidence.draftIdentity.sameField, true); assert.equal(evidence.draftIdentity.sameSave, true); assert.equal(evidence.draftIdentity.focused, true); assert.deepEqual(evidence.draftIdentity.selection, [4, 13, 'backward']); assert.equal(evidence.draftIdentity.draft, correction);
    evidence.presence = { editorId: editor.editorId, stepId: editor.stepId, serverAuthoredActor: editor.actor.type, draftTextSent: false, observedByTaskRead: true, advisoryOperationSucceeded: true };
    await screenshot('38-planning-editing-presence-desktop.jpg');
    check('Actual browser input shares an authenticated advisory editing lease without saving text, blocking a read, or replacing its focused draft', evidence.draftIdentity.sameField && adapters[0].executedReads === 1); report.features.planningEditingPresence = true;

    await click('#planning-save');
    const saved = await until('the browser-authored correction saved to the shared plan', async () => { const value = await api(`/api/tasks/${taskId}`); return value.revision > before.revision && value.steps.find(step => step.id === firstId)?.title === correction && value; });
    await until('the saved edit lease to be released', async () => !(await awareness()).presence.some(item => item.editorId === editor.editorId));
    const waiting = await until('only the affected worker requiring a new read', async () => { const value = await awareness(), first = value.workers.find(worker => worker.id === adapters[0].id), other = value.workers.find(worker => worker.id === adapters[1].id); return first?.state === 'needs-review' && first.pendingRevision === saved.revision && other?.state === 'current' && value; });
    await until('the rendered affected worker review requirement', async () => (await workerText(adapters[0].id)).includes(`Needs revision ${saved.revision}`)); await openReceipts();
    const rejected = await adapters[0].call(operation); assert.equal(rejected.success, false); assert.equal(rejected.code, 'TASK_PLAN_REVIEW_REQUIRED'); assert.equal(adapters[0].executedReads, 1);
    const independent = receiptValue(await adapters[1].call(operation)); assert.equal(readText(independent.content), SOURCE); assert.equal(adapters[1].executedReads, 1);
    const otherWorker = waiting.workers.find(worker => worker.id === adapters[1].id); assert.equal(otherWorker.lastReadRevision, before.revision); assert.equal(otherWorker.pendingRevision, null);
    evidence.saved = { revision: saved.revision, releasedEditorId: editor.editorId, affected: waiting.workers.find(worker => worker.id === adapters[0].id), independent: otherWorker, rejectedCode: rejected.code, rejectedActionExecuted: false, independentReadSucceeded: true };
    await evaluate(() => { document.querySelector('#planning-editor-panel').scrollTop = 0; }); await screenshot('39-planning-worker-review-desktop.jpg');
    check('A real saved human correction gates the affected worker before its next action while a separate ownership scope still reads its input', rejected.code === 'TASK_PLAN_REVIEW_REQUIRED' && adapters[1].executedReads === 1);

    await resize(320, 844); await click('.planning-mobile-tabs button[data-planning-pane="edit"]'); await waitVisible('[data-planning-field="title"]');
    const mobileDraft = 'QA mobile draft retained while the plan pane is visible.'; await fill('[data-planning-field="title"]', mobileDraft);
    const mobileLease = await until('the compact editor lease', async () => (await awareness()).presence.find(item => item.stepId === firstId));
    await openReceipts(); await evaluate(() => { document.querySelector('#planning-editor-panel').scrollTop = 0; }); await frames();
    evidence.mobile = await evaluate(() => { const panel = document.querySelector('#planning-editor-panel'), box = document.querySelector('#planning-editor-awareness').getBoundingClientRect(); return { width: innerWidth, panelWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth, awareness: { left: box.left, right: box.right, width: box.width }, text: document.querySelector('#planning-editor-awareness').textContent, fields: [...panel.querySelectorAll('input:not([type="checkbox"]),textarea,select')].map(field => { const rect = field.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, fontSize: parseFloat(getComputedStyle(field).fontSize) }; }), visiblePanes: [...document.querySelectorAll('.planning-layout > *')].filter(node => !node.hidden && !node.inert).length }; });
    assert.equal(evidence.mobile.visiblePanes, 1); assert.ok(evidence.mobile.panelScrollWidth <= evidence.mobile.panelWidth + 2); assert.ok(evidence.mobile.awareness.left >= -1 && evidence.mobile.awareness.right <= 321); assert.ok(evidence.mobile.fields.length && evidence.mobile.fields.every(field => field.left >= -1 && field.right <= 321 && field.width >= 60 && field.fontSize >= 11)); assert.match(evidence.mobile.text, /You.*are editing/); assert.match(evidence.mobile.text, new RegExp(`Needs revision ${saved.revision}`)); assert.ok(await geometry('320px Planning awareness with an unsaved draft and pending review'));
    await screenshot('40-planning-awareness-320.jpg');
    await click('.planning-mobile-tabs button[data-planning-pane="plan"]'); await until('hiding the compact editor to release its lease', async () => !(await awareness()).presence.some(item => item.editorId === mobileLease.editorId));
    assert.equal(await evaluate(() => document.querySelector('[data-planning-field="title"]').value), mobileDraft);
    await click('.planning-mobile-tabs button[data-planning-pane="edit"]'); await frames(); assert.equal((await awareness()).presence.some(item => item.stepId === firstId), false); assert.equal(await evaluate(() => document.querySelector('[data-planning-field="title"]').value), mobileDraft);
    await click('[data-planning-action="discard"]'); assert.equal(await evaluate(() => document.querySelector('[data-planning-field="title"]').value), correction); assert.equal((await api(`/api/tasks/${taskId}`)).revision, saved.revision);
    evidence.mobile.releasedOnHide = true; evidence.mobile.draftPreserved = true; evidence.mobile.reopeningDidNotAdvertise = true;
    check('At 320px shared editing and worker review fit one pane; hiding it releases presence and reopening retains the exact unsaved draft', evidence.mobile.releasedOnHide && evidence.mobile.draftPreserved); report.features.planningAwarenessMobile = true;

    const delivered = receiptValue(await adapters[0].call(readCall)); assert.equal(delivered.revision, saved.revision); assert.equal(delivered.planningAwareness.worker.lastReadRevision, saved.revision); assert.equal(delivered.planningAwareness.worker.pendingRevision, null);
    const resumed = receiptValue(await adapters[0].call(operation)); assert.equal(readText(resumed.content), SOURCE); assert.equal(adapters[0].executedReads, 2);
    await until('the delivered corrected revision in the rendered read receipt', async () => { const value = await workerText(adapters[0].id); return value.includes(`Read revision ${saved.revision}`) && !value.includes('Needs revision'); });
    evidence.after = { deliveredRevision: delivered.revision, affectedWorkerReadsExecuted: adapters[0].executedReads, independentWorkerReadsExecuted: adapters[1].executedReads, nativeModelTurns: runtime.calls.length - modelCalls };
    check('Only an actual task-tool read records the corrected revision and admits the affected worker’s next local action', evidence.after.deliveredRevision === saved.revision && evidence.after.nativeModelTurns === 0); report.features.planningWorkerReview = true;
    await resize(1440);
  } finally {
    for (const adapter of adapters) adapter.guard.finish('completed');
    await evaluate(() => { delete globalThis.__qaAwarenessField; delete globalThis.__qaAwarenessSave; }).catch(() => {});
  }
}

async function containedBrowserJourney({ api, contained, report, cdp, session, evaluate, until, visible, waitVisible, click, fill, frames, key, closeModal, composer, resize, screenshot, geometry, check }) {
  const evidence = report.recovery.containedBrowser = {}; await closeModal(); await resize(1440); await click('#workspace-modes [data-mode="view"]'); const retained = await composer();
  contained.frameImage = await evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 540; const ctx = canvas.getContext('2d'); const gradient = ctx.createLinearGradient(0, 0, 960, 540); gradient.addColorStop(0, '#162c3b'); gradient.addColorStop(1, '#08101a'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, 960, 540); ctx.fillStyle = '#d6e9f3'; ctx.font = '28px sans-serif'; ctx.fillText('Owned contained page fixture', 48, 78); ctx.fillStyle = '#97b4c5'; ctx.font = '18px sans-serif'; ctx.fillText('The tab UI is real. This page makes no network request.', 48, 115); ctx.strokeStyle = '#416477'; ctx.lineWidth = 2; ctx.strokeRect(48, 160, 640, 52); ctx.fillStyle = '#bdd9e5'; ctx.fillText('Observed page input', 68, 193); return canvas.toDataURL('image/png'); });
  contained.enabled = true; contained.updated(); await click('#workspace-modes [data-mode="observe"]'); await waitVisible('[data-observe-surface="browser"]'); await click('[data-observe-surface="browser"]'); await waitVisible('#observe-browser');
  const controlReady = selector => until('the settled browser control ' + selector, () => evaluate(selector => { const node = document.querySelector(selector); return node && !node.matches(':disabled') && node.getAttribute('aria-disabled') !== 'true' && node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }); }, selector));
  await controlReady('#observe-browser-address-form [type="submit"]');
  const open = async (url, first = false) => { await fill('#observe-browser-url', url); await click(first ? '#observe-browser-address-form [type="submit"]' : '[data-observe-browser="new"]'); await until('a contained tab and its captured frame', () => evaluate(url => document.querySelector('#observe-browser-url')?.value === url && Boolean(document.querySelector('#observe-browser-image')) && document.querySelector('#observe-browser')?.getAttribute('aria-busy') === 'false', url)); };
  await open('https://first.qa.example.test/', true); await open('https://second.qa.example.test/'); await open('https://third.qa.example.test/');
  const ids = contained.tabs.map(tab => tab.tabId), selectTab = id => click(`[data-observe-browser="tab"][data-tab-id="${id}"]`), selected = () => evaluate(() => document.querySelector('#observe-browser-tabs [aria-selected="true"]')?.dataset.tabId);
  await selectTab(ids[1]); await until('the second pinned browser tab', async () => await selected() === ids[1] && !await evaluate(() => document.querySelector('#observe-browser')?.getAttribute('aria-busy') === 'true'));
  contained.activeTab = ids[0]; contained.updated(); await click('[data-observe-browser="refresh"]'); await until('the pinned frame refresh', () => evaluate(() => document.querySelector('#observe-browser').getAttribute('aria-busy') === 'false')); assert.equal(await selected(), ids[1]); assert.equal(await evaluate(() => document.querySelector('#observe-browser-follow').getAttribute('aria-pressed')), 'false');
  // Explicitly focus the tab before exercising its roving keys.
  await evaluate(id => document.querySelector(`[data-observe-browser="tab"][data-tab-id="${id}"]`).focus(), ids[1]); await key('End', 'End', 35); await until('End selects the final contained tab', async () => await selected() === ids[2]); await key('Home', 'Home', 36); await until('Home selects the first contained tab', async () => await selected() === ids[0]); await key('ArrowRight', 'ArrowRight', 39); await until('Right selects the next contained tab', async () => await selected() === ids[1]);
  await until('the browser tab read to settle before closing', () => evaluate(() => document.querySelector('#observe-browser').getAttribute('aria-busy') === 'false')); await key('Delete', 'Delete', 46); await until('closing the middle tab selects the right neighbour', async () => await selected() === ids[2] && contained.tabs.length === 2);
  await until('the replacement tab frame', () => evaluate(() => document.querySelector('#observe-browser').getAttribute('aria-busy') === 'false')); await fill('#observe-browser-url', 'https://draft.qa.example.test/unfinished'); await evaluate(() => { const input = document.querySelector('#observe-browser-url'); input.focus(); input.setSelectionRange(8, 17, 'backward'); globalThis.__qaBrowserAddress = input; });
  await selectTab(ids[0]); await until('the first tab preview settles', () => evaluate(() => document.querySelector('#observe-browser').getAttribute('aria-busy') === 'false')); await selectTab(ids[2]); await until('the retained address draft in the third tab', () => evaluate(() => document.querySelector('#observe-browser-url').value === 'https://draft.qa.example.test/unfinished' && document.querySelector('#observe-browser').getAttribute('aria-busy') === 'false'));
  const draft = await evaluate(() => ({ value: document.querySelector('#observe-browser-url').value, sameField: document.querySelector('#observe-browser-url') === globalThis.__qaBrowserAddress, tab: document.querySelector('#observe-browser-tabs [aria-selected="true"]').dataset.tabId })); assert.equal(draft.tab, ids[2]); assert.equal(draft.sameField, true);
  await screenshot('33-contained-browser-tabs-desktop.jpg'); await resize(390, 844); await frames();
  const mobile = await evaluate(() => { const strip = document.querySelector('#observe-browser-tabs'), r = strip.getBoundingClientRect(); return { width: innerWidth, left: r.left, right: r.right, scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth, overflowX: getComputedStyle(strip).overflowX, tabCount: strip.querySelectorAll('[role="tab"]').length, selected: strip.querySelector('[aria-selected="true"]')?.dataset.tabId }; }); evidence.mobile = mobile; assert.ok(mobile.right <= 391 && mobile.left >= 0 && ['auto', 'scroll'].includes(mobile.overflowX) && await geometry('390px contained tab strip')); await screenshot('34-contained-browser-tabs-mobile.jpg');
  evidence.tabs = { ids, selectedAfterClose: ids[2], pinnedDuringAgentChange: true, keyboard: true, retainedDraft: draft, pageActions: contained.requests.filter(item => item.kind === 'page').map(({ action, tabId }) => ({ action, tabId })) };
  check('The real contained browser tab strip opens, pins, switches and closes actual fixture tabs with keyboard navigation and mobile overflow', contained.tabs.length === 2 && draft.value === 'https://draft.qa.example.test/unfinished' && mobile.selected === ids[2]); report.features.browserTabs = true;
  await resize(1440); await controlReady('#observe-browser-site-protection');
  const site = contained.tabs.find(tab => tab.tabId === ids[2]), origin = new URL(site.url).origin; await click('#observe-browser-site-protection'); await until('the exact site exemption receipt', async () => (await api('/api/browser/protection')).exemptOrigins.includes(origin) && await evaluate(() => /Off for this site/.test(document.querySelector('#observe-browser-protection-status').textContent)));
  assert.equal(await evaluate(() => document.querySelector('#observe-browser-url').value), 'https://draft.qa.example.test/unfinished'); assert.equal(contained.tabProtection(contained.tabs[0]).enabled, true); await controlReady('#observe-browser-site-protection');
  // Deliver the real fixture response between a native summary press/release.
  // The backend state changes before the response, just as in the failed run.
  const gesture = evidence.protectionGesture = { fixtureOnly: true }, responseGate = deferred(), previousConfigureProtection = contained.configureProtection;
  let responseHeld = false, responseReleased = false, responseTimer, summaryPoint, mousePressed = false;
  const releaseResponse = reason => { if (!responseReleased) { responseReleased = true; gesture.releaseReason = reason; clearTimeout(responseTimer); responseGate.resolve(); } };
  contained.configureProtection = async function(value, options) {
    const result = await previousConfigureProtection.call(this, value, options);
    if (!responseHeld && value.action === 'site' && value.tabId === site.tabId && value.origin === origin && value.enabled === true) {
      responseHeld = true; gesture.responseHeld = true;
      if (!responseReleased) {
        responseTimer = setTimeout(() => { gesture.deadlineReleased = true; releaseResponse('hold-deadline'); }, 6500);
        await responseGate.promise;
      }
    }
    return result;
  };
  try {
    await evaluate((tabId, origin) => {
      if (globalThis.__qaProtectionPointer) throw Error('A protection pointer fixture is already active.');
      const originalJSON = Response.prototype.json, state = { decoded: false, responseTaskCompleted: false, events: [], summary: null, responseTimer: null };
      // Observe consumption without changing the response or the app's handler.
      // A following task runs after its await continuations and final render.
      const json = async function(...args) {
        const value = await originalJSON.apply(this, args);
        if (!state.decoded && this.status === 200 && new URL(this.url, location.href).pathname === '/api/browser/protection' && value?.tabs?.some(tab => tab.tabId === tabId && tab.origin === origin && tab.siteExempt === false)) {
          state.decoded = true; state.responseTimer = setTimeout(() => { state.responseTaskCompleted = true; }, 0);
        }
        return value;
      };
      Response.prototype.json = json;
      const event = value => {
        const target = value.target.closest?.('#observe-browser-protection-settings > summary');
        if (target) state.events.push({ type: value.type, trusted: value.isTrusted, originalTarget: target === state.summary });
      };
      for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event, true);
      state.finish = () => {
        clearTimeout(state.responseTimer);
        if (Response.prototype.json === json) Response.prototype.json = originalJSON;
        for (const type of ['pointerdown', 'pointerup', 'click']) document.removeEventListener(type, event, true);
        return { decoded: state.decoded, responseTaskCompleted: state.responseTaskCompleted, events: state.events };
      };
      globalThis.__qaProtectionPointer = state;
    }, site.tabId, origin);
    await click('#observe-browser-site-protection');
    await until('the exact site-protection response to be held', () => responseHeld, 3000);
    assert.equal(contained.exemptOrigins.has(origin), false); assert.equal(gesture.deadlineReleased, undefined);
    summaryPoint = await evaluate(() => {
      const summary = document.querySelector('#observe-browser-protection-settings > summary');
      if (!summary || summary.parentElement.open) throw Error('Protection settings must start closed.');
      summary.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = summary.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (!rect.width || !rect.height || !summary.contains(document.elementFromPoint(x, y))) throw Error('The protection summary is not reachable.');
      globalThis.__qaProtectionPointer.summary = summary;
      return { x, y, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
    });
    gesture.before = summaryPoint;
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: summaryPoint.x, y: summaryPoint.y }, session); mousePressed = true;
    assert.equal(gesture.deadlineReleased, undefined);
    releaseResponse('after-native-mousedown');
    await until('the held protection response and its application continuation', () => evaluate(() => globalThis.__qaProtectionPointer.responseTaskCompleted), 3000);
    gesture.held = await evaluate(({ x, y }) => {
      const original = globalThis.__qaProtectionPointer.summary, current = document.querySelector('#observe-browser-protection-settings > summary'), rect = current.getBoundingClientRect();
      return { originalConnected: original.isConnected, sameSummary: original === current, originalPointHitsSummary: original.contains(document.elementFromPoint(x, y)), rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
    }, summaryPoint);
    assert.equal(gesture.held.originalConnected, true, 'A site response must not detach the physically pressed protection summary.');
    assert.equal(gesture.held.sameSummary, true); assert.equal(gesture.held.originalPointHitsSummary, true); assert.deepEqual(gesture.held.rect, summaryPoint.rect);
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: summaryPoint.x, y: summaryPoint.y }, session); mousePressed = false;
    await controlReady('#observe-browser-global-protection');
    gesture.opened = await evaluate(() => document.querySelector('#observe-browser-protection-settings').open);
    gesture.trustedClicks = await evaluate(() => globalThis.__qaProtectionPointer.events.filter(event => event.type === 'click' && event.trusted && event.originalTarget).length);
    assert.equal(gesture.opened, true); assert.equal(gesture.trustedClicks, 1); assert.equal(gesture.deadlineReleased, undefined);
  } catch (error) { gesture.error = error.message; throw error; }
  finally {
    releaseResponse('cleanup'); contained.configureProtection = previousConfigureProtection;
    if (mousePressed) await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 0, y: 0 }, session, { cleanup: true }).catch(error => { gesture.mouseReleaseError = error.message; });
    gesture.response = await evaluate(() => { const result = globalThis.__qaProtectionPointer?.finish(); delete globalThis.__qaProtectionPointer; return result || null; }).catch(error => ({ diagnosticError: error.message }));
    if (!gesture.error && (gesture.mouseReleaseError || gesture.response?.diagnosticError)) throw Error('Protection pointer fixture cleanup failed.');
  }
  await click('#observe-browser-global-protection'); await until('global protection disabled honestly', async () => (await api('/api/browser/protection')).enabled === false && await evaluate(() => document.querySelector('#observe-browser-site-protection').disabled)); await controlReady('#observe-browser-global-protection'); await click('#observe-browser-global-protection'); await until('global protection restored', async () => (await api('/api/browser/protection')).enabled === true); const count = contained.filterCount; await controlReady('#observe-browser-refresh-protection'); await click('#observe-browser-refresh-protection'); await until('explicit filter refresh receipt', () => contained.filterCount > count); await controlReady('#observe-browser-refresh-protection');
  evidence.protection = { fixtureOnly: true, actions: contained.requests.filter(item => item.kind === 'protection'), originalOrigin: origin, retainedDraft: await evaluate(() => document.querySelector('#observe-browser-url').value), final: await api('/api/browser/protection') }; await screenshot('35-contained-browser-protection-desktop.jpg');
  check('Browser protection reports real fixture state and sends only explicit global, exact-origin site and filter-refresh requests', evidence.protection.actions.length === 5 && evidence.protection.actions[0].tabId === ids[2] && evidence.protection.actions[0].origin === origin && evidence.protection.retainedDraft === 'https://draft.qa.example.test/unfinished' && gesture.held.sameSummary && gesture.opened && gesture.trustedClicks === 1 && gesture.response.decoded && gesture.response.responseTaskCompleted); report.features.browserProtection = true;
  await evaluate(() => { delete globalThis.__qaBrowserAddress; }); await click('#workspace-modes [data-mode="view"]'); await waitVisible('#mission-task'); assert.equal((await composer()).draft, retained.draft);
}

/** Browser-local Copy receipts. Never invokes a native clipboard or changes a permission. */
export function installClipboardFixture(surface = globalThis) {
  const document = surface.document, navigator = surface.navigator;
  if (!document || !navigator || typeof surface.relayDesktop?.writeClipboard === 'function' || surface.__qaClipboard) throw Error('Copy acceptance requires its own browser-only fixture.');
  let mode = 'deny', expected = '', pending = null, reads = 0, unexpected = 0, nativeCopyEvents = 0;
  const events = [];
  const denied = () => Object.assign(Error('The owned browser fixture denied this write.'), { name: 'NotAllowedError' });
  const observe = () => ({ mode, pending: Boolean(pending), reads, unexpected, nativeCopyEvents, events: events.map(event => ({ ...event })), temporaryFields: document.querySelectorAll('textarea[aria-label="Copy text"]').length });
  const fixture = {
    setMode(value) { if (pending || !['deny', 'selection', 'pending'].includes(value)) throw Error('Finish the current fixture copy before changing its mode.'); mode = value; },
    expect(value) { if (typeof value !== 'string' || !value) throw Error('A visible copy source is required.'); expected = value; },
    observe,
    finish() { if (!pending) throw Error('No browser fixture write is pending.'); const finish = pending; pending = null; finish(); },
  };
  Object.defineProperty(document, 'execCommand', { configurable: true, value(command) {
    if (command !== 'copy') { unexpected++; throw Error('The Copy fixture refuses other document commands.'); }
    const field = document.activeElement, selectionValid = field?.tagName === 'TEXTAREA' && field.readOnly === true && field.getAttribute('aria-label') === 'Copy text' && field.selectionStart === 0 && field.selectionEnd === field.value.length;
    const accepted = mode === 'selection' && selectionValid;
    events.push({ method: 'selection', exact: selectionValid && field.value === expected, selectionValid, accepted });
    return accepted;
  } });
  const read = () => { reads++; throw Error('The Copy fixture refuses clipboard reads.'); };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read, readText: read, write() { unexpected++; throw Error('The Copy fixture accepts text writes only.'); }, async writeText(value) {
    const event = { method: 'clipboard', exact: value === expected, accepted: false }; events.push(event);
    if (mode !== 'pending') throw denied();
    if (pending) throw Error('Only one fixture copy may be pending.');
    await new Promise(resolve => { pending = () => { event.accepted = true; resolve(); }; });
  } } });
  // Protect the owned run against an accidental browser Copy shortcut as well.
  document.addEventListener('copy', event => { event.preventDefault(); nativeCopyEvents++; }, true);
  surface.__qaClipboard = fixture;
  return observe();
}

async function remoteClipboardJourney({ report, evaluate, until, click, check }) {
  const evidence = report.recovery.clipboard = { fixtureOnly: true, osClipboardTouched: false, permissionChanges: false };
  await evaluate(installClipboardFixture);
  await evaluate(() => {
    __qaClipboard.expect(document.querySelector('#remote-pair-code').value);
    globalThis.__qaCopyDraft = { code: document.querySelector('#remote-pair-code').value, name: document.querySelector('#remote-agent-name').value };
  });
  const retained = () => evaluate(() => ({
    sourceRetained: document.querySelector('#remote-pair-code').value === __qaCopyDraft.code,
    readonlySource: document.querySelector('#remote-pair-code').readOnly,
    agentDraftRetained: document.querySelector('#remote-agent-name').value === __qaCopyDraft.name,
    scopeRetained: document.querySelector('[data-remote-scope="planning:write"]').checked,
    temporaryFieldsRemoved: __qaClipboard.observe().temporaryFields === 0,
  }));
  await click('[data-remote-action="copy-code"]');
  await until('a useful denied-copy message in Remote Settings', () => evaluate(() => {
    const message = document.querySelector('#remote-access-message');
    return message?.getAttribute('role') === 'alert' && message.textContent === 'Copy is unavailable here. Select the text and use your device’s Copy command.' && document.querySelector('[data-remote-action="copy-code"]').getAttribute('aria-disabled') !== 'true';
  }));
  evidence.denied = { ...(await retained()), ...(await evaluate(() => __qaClipboard.observe())) };
  assert.ok(evidence.denied.sourceRetained && evidence.denied.readonlySource && evidence.denied.agentDraftRetained && evidence.denied.scopeRetained && evidence.denied.temporaryFieldsRemoved);
  assert.deepEqual(evidence.denied.events.map(event => [event.method, event.exact, event.accepted]), [['selection', true, false], ['clipboard', true, false]]);
  await evaluate(() => __qaClipboard.setMode('pending')); await click('[data-remote-action="copy-code"]');
  await until('the browser write receipt to remain pending', () => evaluate(() => __qaClipboard.observe().pending));
  evidence.noPrematureSuccess = await evaluate(() => !document.querySelector('#remote-access-message') && document.querySelector('[data-remote-action="copy-code"]').getAttribute('aria-disabled') === 'true');
  assert.ok(evidence.noPrematureSuccess);
  await evaluate(() => __qaClipboard.finish());
  await until('a confirmed retry receipt for the same pairing code', () => evaluate(() => document.querySelector('#remote-access-message')?.textContent === 'Pairing code copied.' && document.querySelector('#remote-access-message')?.getAttribute('role') === 'status' && document.querySelector('[data-remote-action="copy-code"]').getAttribute('aria-disabled') !== 'true'));
  evidence.retry = { ...(await retained()), ...(await evaluate(() => __qaClipboard.observe())) };
  assert.ok(evidence.retry.sourceRetained && evidence.retry.agentDraftRetained && evidence.retry.scopeRetained && evidence.retry.temporaryFieldsRemoved);
  assert.deepEqual(evidence.retry.events.map(event => [event.method, event.exact, event.accepted]), [['selection', true, false], ['clipboard', true, false], ['selection', true, false], ['clipboard', true, true]]);
  check('Denied browser Copy preserves its visible source and remote-agent draft, and retry confirms only a completed write', evidence.noPrematureSuccess && evidence.retry.sourceRetained && evidence.retry.agentDraftRetained && evidence.retry.reads === 0 && evidence.retry.unexpected === 0);
  await evaluate(() => { delete globalThis.__qaCopyDraft; });
}

async function remoteSettingsJourney({ api, app, remoteFixture, desktopLifecycle, report, evaluate, until, visible, waitVisible, click, fill, select, frames, composer, resize, screenshot, geometry, check }) {
  const evidence = report.recovery.remote = {}, beforeConfig = remoteFixture.config, before = await composer(); await resize(1440); await click('#workspace-modes [data-mode="configure"]'); await waitVisible('#remote-access-settings');
  const controlReady = selector => until('the settled remote control ' + selector, () => evaluate(selector => { const node = document.querySelector(selector); return node && !node.matches(':disabled') && node.getAttribute('aria-disabled') !== 'true' && node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }); }, selector));
  assert.equal(await evaluate(() => document.querySelector('#remote-mode').value), 'private'); await controlReady('#remote-enable'); await click('#remote-enable'); await until('owned private remote access to become ready', async () => (await api('/api/remote-access')).enabled === true && await visible('#remote-pair'));
  await controlReady('#remote-pair'); const privateStatus = await api('/api/remote-access'); assert.equal(privateStatus.mode, 'private'); assert.ok(privateStatus.endpoints.mcp.endsWith('/mcp')); assert.ok(privateStatus.endpoints.api.endsWith('/api/agent'));
  await select('#remote-mode', 'public'); await waitVisible('#remote-public-confirm'); assert.equal(await evaluate(() => document.querySelector('#remote-enable').disabled), true); await click('#remote-public-confirm'); await click('#remote-enable'); await until('explicit public mode on the isolated transport fixture', async () => (await api('/api/remote-access')).enabled && (await api('/api/remote-access')).mode === 'public');
  await controlReady('#remote-pair'); await click('#remote-pair'); await waitVisible('#remote-pair-code'); await controlReady('#remote-pair'); assert.ok(await evaluate(() => document.querySelector('#remote-pair-code').value.length >= 6));
  await click('#remote-agent-setup > summary'); await waitVisible('#remote-agent-name'); await fill('#remote-agent-name', 'QA outside planning agent'); await click('[data-remote-scope="planning:write"]');
  const draftBefore = await evaluate(() => { const field = document.querySelector('#remote-agent-name'); field.focus(); field.setSelectionRange(3, 15, 'backward'); globalThis.__qaRemoteField = field; return { value: field.value, pairingVisible: Boolean(document.querySelector('#remote-pair-code').value) }; });
  await app.remoteAccess.refresh(); await frames(); const retainedRemote = await evaluate(() => { const field = document.querySelector('#remote-agent-name'); return { value: field.value, focused: document.activeElement === field, selection: [field.selectionStart, field.selectionEnd, field.selectionDirection], pairing: Boolean(document.querySelector('#remote-pair-code').value), scopeChecked: document.querySelector('[data-remote-scope="planning:write"]').checked }; }); assert.equal(retainedRemote.value, 'QA outside planning agent'); assert.equal(retainedRemote.focused, true); assert.deepEqual(retainedRemote.selection, [3, 15, 'backward']); assert.ok(retainedRemote.pairing && retainedRemote.scopeChecked); evidence.retainedRemoteDraft = retainedRemote;
  await remoteClipboardJourney({ report, evaluate, until, click, check });
  await controlReady('#remote-create-agent'); await click('#remote-create-agent'); await waitVisible('#remote-agent-token'); await controlReady('#remote-create-agent'); const withAgent = await api('/api/remote-access'), device = withAgent.devices.find(item => item.kind === 'agent' && item.label === 'QA outside planning agent'); assert.ok(device && device.scopes.includes('read') && device.scopes.includes('planning:write')); assert.ok(await evaluate(() => document.querySelector('#remote-agent-token').value.length > 20));
  // One-time values stay in the disposable browser and are never placed in the report.
  await controlReady(`[data-remote-revoke="${device.id}"]`); await click(`[data-remote-revoke="${device.id}"]`); await until('the explicit agent credential revocation', async () => !(await api('/api/remote-access')).devices.some(item => item.id === device.id));
  if (await visible('[data-remote-action="clear-pair"]')) { await controlReady('[data-remote-action="clear-pair"]'); await click('[data-remote-action="clear-pair"]'); }
  // Capture denied-copy recovery only after one-time codes and credentials are gone.
  await evaluate(() => { __qaClipboard.expect(document.querySelector('.remote-address a').getAttribute('href')); __qaClipboard.setMode('deny'); });
  await click('[data-remote-action="copy-address"]');
  await until('a visible Copy recovery message without exposed credentials', () => evaluate(() => document.querySelector('#remote-access-message')?.getAttribute('role') === 'alert' && !document.querySelector('#remote-pair-code') && !document.querySelector('#remote-agent-token')));
  await evaluate(() => document.querySelector('#remote-access-settings').scrollIntoView({ block: 'start' })); await screenshot('45-clipboard-recovery-desktop.jpg');
  await resize(320, 900); await evaluate(() => document.querySelector('#remote-access-settings').scrollIntoView({ block: 'start' })); await frames();
  report.recovery.clipboard.mobileFits = await geometry('320px clipboard recovery'); assert.ok(report.recovery.clipboard.mobileFits);
  await screenshot('46-clipboard-recovery-320.jpg'); await resize(1440, 900);
  await evaluate(() => __qaClipboard.setMode('selection')); await click('[data-remote-action="copy-address"]');
  await until('a browser selection-copy receipt', () => evaluate(() => document.querySelector('#remote-access-message')?.textContent === 'Address copied.'));
  report.recovery.clipboard.selection = await evaluate(() => __qaClipboard.observe());
  assert.deepEqual(report.recovery.clipboard.selection.events.at(-1), { method: 'selection', exact: true, selectionValid: true, accepted: true });
  await controlReady('#desktop-background'); await click('#desktop-background'); await until('the headless lifecycle receipt', async () => desktopLifecycle.status().mode === 'background' && await visible('#desktop-show')); assert.equal(app.engine.listRuns().length, 6); await controlReady('#desktop-show'); await click('#desktop-show'); await until('the same desktop profile shown again', () => desktopLifecycle.status().mode === 'window');
  await controlReady('#desktop-background'); await screenshot('36-remote-access-settings-desktop.jpg'); await resize(390, 844); await evaluate(() => document.querySelector('#remote-access-settings').scrollIntoView({ block: 'start' })); assert.ok(await geometry('390px remote Settings')); await screenshot('37-remote-access-settings-mobile.jpg'); await resize(1440);
  await controlReady('#remote-disable'); await click('#remote-disable');
  const disabled = await until('remote disable, revocation and owned-route removal to complete', async () => { const status = await api('/api/remote-access'); return remoteDisableSettled(status) && status; });
  await controlReady('#remote-refresh'); assert.deepEqual(remoteFixture.config, beforeConfig);
  evidence.disable = { state: disabled.state, configuredEnabled: disabled.configuredEnabled, enabled: disabled.enabled, gateway: disabled.gateway, remainingDevices: disabled.devices.length, error: disabled.error };
  evidence.privateReady = privateStatus.enabled; evidence.publicExplicit = true; evidence.retainedPairingAndDraft = draftBefore.pairingVisible; evidence.agent = { id: device.id, label: device.label, scopes: device.scopes, revoked: true }; evidence.headless = { sameProfile: desktopLifecycle.status().sameProfile, finalMode: desktopLifecycle.status().mode }; evidence.routesPreserved = true; evidence.fixtureTransportCalls = remoteFixture.calls;
  check('Remote Settings explicitly enables private or public access, creates a browser pairing code, creates and revokes a scoped agent, and preserves the same headless profile', evidence.privateReady && evidence.routesPreserved && evidence.headless.sameProfile && evidence.agent.revoked); report.features.remoteSettings = true;
  await evaluate(() => { delete globalThis.__qaRemoteField; }); await click('#workspace-modes [data-mode="view"]'); await waitVisible('#mission-task'); assert.equal((await composer()).draft, before.draft);
}

async function chatClipboardJourney({ report, runId, expected, evaluate, until, click, fill, openChat, composer, screenshot, check }) {
  await openChat(runId); const before = await composer(), selector = `.conversation-turn[data-run-id="${runId}"] [data-mission-action="copy"]`;
  const draft = 'This unsent draft must survive copying a completed response.\n'.repeat(12);
  await fill('#mission-task', draft);
  await evaluate(expected => {
    const input = document.querySelector('#mission-task'); input.focus(); input.setSelectionRange(3, 23, 'backward'); input.scrollTop = input.scrollHeight;
    globalThis.__qaCopyComposer = { input, value: input.value, scrollTop: input.scrollTop, selection: [input.selectionStart, input.selectionEnd, input.selectionDirection] };
    __qaClipboard.expect(expected); __qaClipboard.setMode('selection');
  }, expected);
  await click(selector);
  await until('the main-chat Copy receipt', () => evaluate(() => [...document.querySelectorAll('#toast-root .toast')].some(node => node.textContent === 'Copied to clipboard.')));
  const state = await evaluate(selector => {
    const input = document.querySelector('#mission-task'), saved = __qaCopyComposer;
    return { ...__qaClipboard.observe(), inputPreserved: input === saved.input, draftPreserved: input.value === saved.value, selectionPreserved: JSON.stringify([input.selectionStart, input.selectionEnd, input.selectionDirection]) === JSON.stringify(saved.selection), scrollPreserved: input.scrollTop === saved.scrollTop, copyButtonFocused: document.activeElement === document.querySelector(selector) };
  }, selector);
  report.recovery.clipboard.chat = state;
  assert.deepEqual(state.events.at(-1), { method: 'selection', exact: true, selectionValid: true, accepted: true });
  const preserved = state.inputPreserved && state.draftPreserved && state.selectionPreserved && state.scrollPreserved && state.copyButtonFocused && state.temporaryFields === 0;
  check('Main-chat Copy uses the shared browser helper and preserves the unsent draft, selection and scroll without reading a clipboard', preserved && state.reads === 0 && state.unexpected === 0 && state.nativeCopyEvents === 0);
  await screenshot('47-clipboard-chat-draft.jpg');
  await fill('#mission-task', before.draft); await evaluate(() => { delete globalThis.__qaCopyComposer; });
  report.features.clipboardRecovery = true;
}

async function createEmailOAuthFixture({ candidate, dataDir, cliCalls }) {
  const { EmailOAuthManager } = await import(pathToFileURL(path.join(candidate, 'lib/email-oauth.mjs')).href);
  const key = randomBytes(32), opened = [], providerCalls = [], fixture = { allowCliChecks: false, opened, providerCalls };
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  fixture.manager = await new EmailOAuthManager({ dataDir, tokenRuntimeExecutable: process.execPath,
    encryptSecret(value) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64'); },
    decryptSecret(value) { const data = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'); },
    openExternal: async value => { const url = new URL(value); assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth'); opened.push(url); },
    fetchImpl: async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        const body = new URLSearchParams(options.body), authorization = opened.at(-1);
        assert.equal(options.method, 'POST'); assert.equal(body.get('grant_type'), 'authorization_code'); assert.equal(body.get('code'), 'blackice-owned-ui-consent');
        assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
        assert.equal(body.get('redirect_uri'), authorization.searchParams.get('redirect_uri')); assert.equal(body.get('client_id'), authorization.searchParams.get('client_id'));
        providerCalls.push({ kind: 'token', provider: 'gmail', fixtureOnly: true, pkceVerified: true });
        return json({ access_token: 'blackice-ui-fixture-access', refresh_token: 'blackice-ui-fixture-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
      }
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
        assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer blackice-ui-fixture-access');
        providerCalls.push({ kind: 'identity', provider: 'gmail', fixtureOnly: true }); return json({ emailAddress: 'verified-ui@example.test' });
      }
      throw Error('The email UI fixture refused an unexpected provider endpoint.');
    },
  }).init();
  fixture.runner = async value => {
    const command = value.args.join(' '), allowed = ['--version', 'gmail --help', 'envelope list --help', 'message read --help', 'envelope search --help', 'mailbox list --help'];
    if (fixture.allowMailboxReads && !value.args.includes('--help')) {
      assert.ok(value.args.includes('--json') && value.args.some(arg => arg.startsWith('--config=./')) && value.args.some(arg => arg.startsWith('--account=')));
      assert.ok(!value.args.some(arg => ['--seen', '--counts', 'send', 'delete', 'move'].includes(arg)));
      const mailboxFixture = value.args.includes('mailbox') && value.args.includes('list') ? 'mailboxes' : value.args.includes('envelope') && value.args.includes('list') ? 'list' : value.args.includes('message') && value.args.includes('read') ? 'read' : null;
      assert.ok(mailboxFixture, 'Only explicit folder, list and raw read fixtures are supported.');
      cliCalls.push({ args: [...value.args], fixtureOnly: true, mailboxFixture });
      if (mailboxFixture === 'mailboxes') return { exitCode: 0, stdout: JSON.stringify({ mailboxes: [{ id: 'inbox-id', name: 'Inbox', role: 'inbox', total: null, unread: null }, { id: 'archive-id', name: 'Archive', role: 'archive', total: null, unread: null }] }) };
      assert.ok(value.args.includes('--mailbox=archive-id'), 'Mailbox reads must retain the exact selected folder ID.');
      if (mailboxFixture === 'list') return { exitCode: 0, stdout: JSON.stringify({ queued: 0, envelopes: [{ id: '42', subject: 'Readable café', from: [{ name: 'José', email: 'sender@example.test' }], to: [{ email: 'reader@example.test' }], flags: [], date: '2026-10-20T09:00:00Z', size: 500, 'has-attachment': true }] }) };
      assert.ok(value.args.includes('--raw') && value.args.at(-1) === '42');
      const message = ['From: =?UTF-8?Q?Jos=C3=A9?= <sender@example.test>', 'To: reader@example.test', 'Reply-To: reply@example.test', 'Subject: =?UTF-8?Q?Readable_caf=C3=A9?=', 'Date: Tue, 20 Oct 2026 09:00:00 +0000', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="owned-mail"', '', '--owned-mail', 'Content-Type: multipart/alternative; boundary="owned-body"', '', '--owned-body', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '', 'A readable message about caf=C3=A9.', '<script>window.__emailInjection=true</script>', '--owned-body', 'Content-Type: text/html; charset=UTF-8', '', '<p>A readable message about café.</p><img src="https://tracker.example.test/pixel"><script>window.__emailInjection=true</script>', '--owned-body--', '--owned-mail', 'Content-Type: application/octet-stream; name="report.txt"', 'Content-Disposition: attachment; filename="report.txt"', 'Content-Transfer-Encoding: base64', '', 'cmVwb3J0', '--owned-mail--', ''].join('\r\n');
      return { exitCode: 0, stdout: JSON.stringify({ message }) };
    }
    assert.ok(fixture.allowCliChecks && allowed.includes(command), 'Only the explicit Sign in click may request the six local CLI interface fixtures.');
    cliCalls.push({ args: [...value.args], fixtureOnly: true });
    return { exitCode: 0, stdout: command === '--version' ? 'himalaya v2.2.1 +gmail +msgraph\n' : command === 'gmail --help' ? 'Gmail backend commands: profile labels messages' : '--json --page-size --page --mailbox --account --raw --seen Read, leaving its flags alone otherwise', stderr: '' };
  };
  return fixture;
}

async function emailOAuthJourney({ api, report, emailFixture, cliCalls, evaluate, waitVisible, until, click, fill, select, menu, check, screenshot, geometry, resize, frames, key }) {
  const evidence = report.recovery.emailOAuth = { fixtureConsent: true, externalRequests: 0, mailboxReads: 0 }, clientId = 'blackice-owned-ui.apps.googleusercontent.com';
  const importRegistration = async () => {
    await evaluate(clientId => {
      const input = document.querySelector('#email-oauth-import'), files = new DataTransfer();
      files.items.add(new File([JSON.stringify({ installed: { client_id: clientId, client_secret: 'blackice-ui-desktop-fixture', project_id: 'blackice-owned-ui', redirect_uris: ['http://localhost'] } })], 'owned-desktop-client.json', { type: 'application/json' }));
      input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    }, clientId);
    await until('the Google Desktop client file to fill the current registration form', () => evaluate(clientId => document.querySelector('#email-oauth-client-id').value === clientId && document.querySelector('#email-oauth-client-secret').value.length > 0 && !document.querySelector('#email-oauth-save').disabled, clientId));
  };
  await menu('email'); await waitVisible('#email-oauth-provider'); await resize(1440, 900);
  await importRegistration();
  const imported = await api('/api/email');
  evidence.localImport = imported.oauth.revision === 0 && !imported.oauth.configured && emailFixture.opened.length === 0 && cliCalls.length === 0;
  check('Google Desktop registration import fills password-masked local fields without saving, opening consent or launching the mail engine', evidence.localImport && await evaluate(() => document.querySelector('#email-oauth-client-secret').type === 'password' && !document.querySelector('#email-oauth-import').value));

  const draftBody = 'This local draft survives registration conflicts and consent polling.\nNothing will be sent.';
  await fill('#email-body', draftBody); await fill('#email-oauth-client-id', 'blackice-unsaved-ui.apps.googleusercontent.com');
  await api('/api/email/oauth/config', 'PUT', { expectedRevision: imported.oauth.revision, config: { provider: 'gmail', clientId: 'blackice-other-ui.apps.googleusercontent.com', clientSecret: 'other-ui-fixture' } });
  await click('#email-oauth-save');
  await until('the registration conflict to expose a deliberate reload', async () => {
    const state = await evaluate(() => {
      const receipt = document.querySelector('#email-receipt');
      return { staleVisible: !document.querySelector('#email-oauth-stale').hidden, reloadVisible: !document.querySelector('#email-oauth-reload').hidden, reloadDisabled: document.querySelector('#email-oauth-reload').disabled, editingDisabled: document.querySelector('#email-oauth-client-id').disabled, saveDisabled: document.querySelector('#email-oauth-save').disabled, receiptError: receipt?.dataset.error === 'true', receipt: receipt?.textContent.trim().slice(0, 400) || '' };
    });
    evidence.conflictView = state;
    if (state.receiptError && !state.editingDisabled && (!state.staleVisible || !state.reloadVisible)) throw Error(`Registration save settled without its required reload action: ${JSON.stringify(state)}`);
    return state.staleVisible && state.reloadVisible && !state.reloadDisabled;
  });
  evidence.conflictPreserved = await evaluate(body => document.querySelector('#email-oauth-client-id').value === 'blackice-unsaved-ui.apps.googleusercontent.com' && document.querySelector('#email-oauth-client-secret').value === '' && document.querySelector('#email-oauth-connect').disabled && document.querySelector('#email-body').value === body, draftBody);
  assert.ok(evidence.conflictPreserved);
  await click('#email-oauth-reload'); await until('explicit registration reload to settle', () => evaluate(() => document.querySelector('#email-oauth-stale').hidden && !document.querySelector('#email-oauth-provider').disabled));
  await select('#email-oauth-provider', 'microsoft');
  assert.ok(await evaluate(() => document.querySelector('#email-oauth-client-secret').hidden && document.querySelector('#email-oauth-import').hidden && /Microsoft/.test(document.querySelector('#email-oauth-connect').textContent)));
  await select('#email-oauth-provider', 'gmail'); await importRegistration(); await fill('#email-oauth-login-hint', 'suggested-ui@example.test');
  await click('#email-oauth-save'); await until('the owned registration save to settle', () => evaluate(() => document.querySelector('#email-oauth-save').disabled && !document.querySelector('#email-oauth-connect').disabled));
  await evaluate(() => { document.querySelector('#email-workspace').scrollTop = 0; }); await frames();
  await screenshot('41-email-oauth-registration-desktop.jpg');

  evidence.dropdown = await evaluate(() => {
    const color = value => { const parts = value.match(/[\d.]+/g)?.map(Number); return parts?.length >= 3 ? { rgb: parts.slice(0, 3), alpha: parts[3] ?? 1 } : null; };
    const luminance = rgb => rgb.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    return [...document.querySelectorAll('#email-oauth-provider,#email-oauth-provider option')].map(node => {
      const style = getComputedStyle(node), background = color(style.backgroundColor), foreground = color(style.color), dark = background && luminance(background.rgb), light = foreground && luminance(foreground.rgb);
      return { tag: node.tagName.toLowerCase(), background: style.backgroundColor, foreground: style.color, colorScheme: style.colorScheme, backgroundAlpha: background?.alpha, foregroundAlpha: foreground?.alpha, backgroundLuminance: dark, contrast: background && foreground ? (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05) : 0 };
    });
  });
  const darkDropdown = evidence.dropdown.length === 3 && evidence.dropdown.every(item => item.colorScheme.split(/\s+/).includes('dark') && item.backgroundAlpha === 1 && item.foregroundAlpha === 1 && item.backgroundLuminance < .15 && item.contrast >= 4.5);
  assert.ok(darkDropdown, 'Email provider options retain opaque dark surfaces and readable text.');
  const popupOpen = () => evaluate(() => { try { return document.querySelector('#email-oauth-provider').matches(':open'); } catch { return null; } });
  evidence.popup = { selector: '#email-oauth-provider', requestedBy: 'real pointer click', screenshot: '42-email-oauth-provider-dropdown.jpg' };
  try {
    await click('#email-oauth-provider'); await frames(); evidence.popup.open = await popupOpen();
    if (evidence.popup.open === false) { await key('ArrowDown', 'ArrowDown', 40, 1); await frames(); evidence.popup.open = await popupOpen(); evidence.popup.requestedBy += ' and Alt+ArrowDown'; }
    await screenshot(evidence.popup.screenshot); evidence.popup.captured = true;
  } finally { await key('Escape', 'Escape', 27); }
  assert.equal(await evaluate(() => document.querySelector('#email-oauth-provider').value), 'gmail');
  evidence.popup.observation = evidence.popup.open === true ? 'The browser reported the native provider dropdown open during capture.' : 'A native provider dropdown was requested; this headless browser did not expose its open state. Inspect the screenshot.';

  await resize(320, 900); await evaluate(() => { document.querySelector('#email-workspace').scrollTop = 0; }); await frames();
  evidence.mobile = await evaluate(() => {
    const pane = document.querySelector('#email-workspace');
    return { width: innerWidth, paneClientWidth: pane.clientWidth, paneScrollWidth: pane.scrollWidth, fields: [...document.querySelectorAll('.email-oauth input,.email-oauth select,.email-oauth button')].filter(node => node.getClientRects().length).map(node => { const r = node.getBoundingClientRect(); return { id: node.id, left: r.left, right: r.right, width: r.width, fontSize: parseFloat(getComputedStyle(node).fontSize) }; }) };
  });
  const mobileFits = await geometry('320px email OAuth') && evidence.mobile.paneScrollWidth <= evidence.mobile.paneClientWidth + 2 && evidence.mobile.fields.length >= 6 && evidence.mobile.fields.every(field => field.left >= -1 && field.right <= 321 && field.width > 0 && field.fontSize >= 12);
  await screenshot('43-email-oauth-320.jpg');
  check('Email registration and provider menus fit 320px with dark native options and at least 4.5:1 text contrast', mobileFits && darkDropdown && evidence.popup.captured);
  report.features.emailOAuthMobile = true;

  await resize(1440, 900); emailFixture.allowCliChecks = true;
  try {
    await click('#email-oauth-connect');
    await until('the explicit sign-in action to finish its interface check and open pending consent', () => evaluate(() => !document.querySelector('#email-oauth-cancel').hidden && !document.querySelector('#email-oauth-cancel').disabled));
  } finally { emailFixture.allowCliChecks = false; }
  assert.equal(emailFixture.opened.length, 1); assert.equal(cliCalls.length, 6); assert.equal(emailFixture.providerCalls.length, 0);
  const authorization = emailFixture.opened[0];
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256'); assert.equal(authorization.searchParams.get('access_type'), 'offline'); assert.match(authorization.searchParams.get('prompt'), /select_account/);
  if (!await evaluate(() => document.querySelector('.email-setup').open)) await click('.email-setup > summary');
  await fill('#email-account', 'qa-unsaved-during-consent'); await fill('#email-body', draftBody);
  await evaluate(() => { const body = document.querySelector('#email-body'); window.__blackiceEmailCompose = body; body.focus(); body.setSelectionRange(3, 17, 'backward'); });
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  assert.equal(callback.hostname, '127.0.0.1'); callback.searchParams.set('state', authorization.searchParams.get('state')); callback.searchParams.set('code', 'blackice-owned-ui-consent');
  const completed = await fetch(callback, { signal: AbortSignal.timeout(10000) }); assert.equal(completed.status, 200); await completed.arrayBuffer();
  await until('consent polling to display the actual provider-verified account', () => evaluate(() => /verified-ui@example\.test/.test(document.querySelector('#email-oauth-note').textContent) && document.querySelector('#email-oauth-cancel').hidden));
  evidence.composePreserved = await evaluate(body => { const field = document.querySelector('#email-body'); return field === window.__blackiceEmailCompose && document.activeElement === field && field.value === body && field.selectionStart === 3 && field.selectionEnd === 17 && field.selectionDirection === 'backward' && document.querySelector('#email-account').value === 'qa-unsaved-during-consent'; }, draftBody);
  const connected = await api('/api/email');
  evidence.identityVerified = connected.oauth.connected && connected.oauth.identity?.email === 'verified-ui@example.test' && connected.oauth.config.loginHint === 'suggested-ui@example.test';
  evidence.pkceVerified = emailFixture.providerCalls.length === 2 && emailFixture.providerCalls[0].pkceVerified === true;
  const encrypted = await fs.readFile(emailFixture.manager.filename, 'utf8'), managed = await fs.readFile(emailFixture.manager.configPath, 'utf8');
  evidence.credentialsProtected = ['blackice-ui-desktop-fixture', 'blackice-ui-fixture-access', 'blackice-ui-fixture-refresh'].every(value => !encrypted.includes(value) && !managed.includes(value));
  check('Explicit email sign-in completes the real loopback PKCE flow through fixture consent and shows provider-verified identity without claiming a mailbox read', evidence.identityVerified && evidence.pkceVerified && connected.cli.checked && !connected.account.observed && connected.capabilities.send === false && evidence.credentialsProtected);
  report.features.emailOAuthSignIn = true;
  check('Registration conflict recovery and completed-consent polling preserve local compose identity, caret and unsaved advanced setup while keeping secret fields empty', evidence.conflictPreserved && evidence.composePreserved && connected.drafts.length === 1 && await evaluate(() => !document.querySelector('#email-oauth-client-secret').value && !document.querySelector('#email-oauth-import').value));
  report.features.emailOAuthDraftSafety = true;
  evidence.cliInterfaceChecks = cliCalls.length; evidence.providerFixtureCalls = [...emailFixture.providerCalls];
  await evaluate(() => { delete window.__blackiceEmailCompose; document.querySelector('#email-workspace').scrollTop = 0; }); await frames(); await screenshot('44-email-oauth-connected-desktop.jpg');
}

async function emailJourney({ api, app, runtime, report, emailClientHandoffs, evaluate, waitVisible, until, click, fill, menu, cards, check, screenshot, geometry, resize, cliCalls, cwd }) {
  const advanced = async () => { if (!await evaluate(() => document.querySelector('.email-setup').open)) await click('.email-setup > summary'); await waitVisible('#email-executable'); };
  await cards(); await click('.priority-workspace-card[data-action="email"]'); await waitVisible('#email-oauth-provider');
  check('Email opens with setup required and local drafts available, without launching its CLI or contacting an account', await evaluate(() => /Setup required/.test(document.querySelector('#email-state').textContent) && document.querySelector('#email-check').disabled && document.querySelector('#email-mailbox-read').disabled && !document.querySelector('#email-draft-save').disabled) && cliCalls.length === 0);
  const subject = 'QA local draft only', body = 'This message stays in the isolated local fixture.\nNo account was contacted and no email was sent.';
  await fill('#email-to', 'fixture@example.test'); await fill('#email-subject', subject); await fill('#email-body', body); await click('#email-draft-save');
  await until('the saved local draft', () => evaluate(() => document.querySelectorAll('#email-drafts [data-email-draft]').length === 1 && !document.querySelector('#email-draft-save').disabled));
  await click('#email-draft-save'); await until('idempotent draft save receipt', () => evaluate(() => /Local draft saved/.test(document.querySelector('#email-receipt').textContent) && !document.querySelector('#email-draft-save').disabled));
  const snapshot = await api('/api/email'), draft = await api(`/api/email/drafts/${snapshot.drafts[0].id}`), saved = draft.draft || draft;
  await click('#email-drafts [data-email-draft]'); await waitVisible('#email-draft-preview');
  check('A local draft saves exact content and readable EML bytes before configuration, with repeated Save producing one draft', snapshot.drafts.length === 1 && saved.sent === false && saved.subject === subject && saved.body === body && await fs.readFile(saved.path, 'utf8') === saved.eml && await evaluate(body => document.querySelector('#email-draft-preview').textContent.includes(body), body) && cliCalls.length === 0);
  await until('the installed-client handoff to become available', () => evaluate(() => document.querySelector('#email-client-open') && !document.querySelector('#email-client-open').disabled));
  assert.deepEqual(emailClientHandoffs, []);
  for (const [selector, action] of [['#email-client-open', 'open'], ['#email-client-compose', 'compose']]) {
    await click(selector);
    await until('the explicit Thunderbird ' + action + ' handoff', () => evaluate(() => !document.querySelector('#email-client-open').disabled && Boolean(document.querySelector('#email-client-receipt').textContent.trim())));
    assert.equal(emailClientHandoffs.at(-1), action);
  }
  check('Thunderbird opens only after explicit native UI clicks, preserves the local draft, and reports a handoff without claiming account access or sending mail', JSON.stringify(emailClientHandoffs) === JSON.stringify(['open', 'compose']) && cliCalls.length === 0 && await evaluate(body => document.querySelector('#email-body').value === body && !/sent successfully/i.test(document.querySelector('#email-client-receipt').textContent), body));
  report.features.emailClientHandoff = true; report.recovery.emailClientHandoff = { fixtureOnly: true, actions: [...emailClientHandoffs], mailSent: false, accountAccess: false, nativeWindowVerified: false };
  await advanced(); await fill('#email-executable', process.execPath); const configPath = path.join(cwd, 'qa-empty-email-config.toml'); await fs.writeFile(configPath, '# Local UI fixture only. No account or credentials.\n'); await fill('#email-config-path', configPath); await fill('#email-account', 'qa-fixture');
  await evaluate(() => { const node = document.querySelector('#email-enabled'); node.checked = true; node.dispatchEvent(new Event('input', { bubbles: true })); }); await click('#email-save-config');
  await until('saved email setup', () => evaluate(() => /Configured.*checks required/i.test(document.querySelector('#email-state').textContent) && !document.querySelector('#email-check').disabled));
  await menu('email'); await waitVisible('#email-oauth-provider'); await advanced(); await resize(390, 844);
  const configured = await api('/api/email');
  check('Email setup and drafts survive reopening, retain unchecked mailbox status, and fit the mobile viewport without starting a process', configured.config.enabled && configured.config.executable === process.execPath && configured.config.account === 'qa-fixture' && configured.drafts.length === 1 && !configured.cli.checked && !configured.account.observed && configured.capabilities.send === false && cliCalls.length === 0 && runtime.calls.length === 0 && await geometry('390px email'));
  await screenshot('03-email-mobile.jpg'); await resize(1440);
  await fill('#email-account', 'qa-unsaved-account');
  await api('/api/email/config', 'PUT', { config: { ...configured.config, account: 'qa-reloaded-account' }, expectedRevision: configured.revision });
  await click('#email-refresh');
  await until('visible saved-setup mismatch', () => evaluate(() => /Saved setup changed/.test(document.querySelector('#email-state').textContent) && !document.querySelector('#email-refresh').disabled));
  const heldSetup = await evaluate(body => document.querySelector('#email-account').value === 'qa-unsaved-account' && document.querySelector('#email-check').disabled && document.querySelector('#email-mailbox-read').disabled && document.querySelector('#email-save-config').disabled && /replace edits/.test(document.querySelector('#email-reload-config').textContent) && document.querySelector('#email-body').value === body, body);
  await menu('email'); await waitVisible('#email-oauth-provider'); await advanced(); await waitVisible('#email-reload-config');
  const preservedOnReopen = await evaluate(() => document.querySelector('#email-account').value === 'qa-unsaved-account' && document.querySelector('#email-check').disabled);
  await click('#email-reload-config');
  await until('deliberately reloaded setup', () => evaluate(() => document.querySelector('#email-account').value === 'qa-reloaded-account' && !document.querySelector('#email-check').disabled));
  check('A different saved account blocks CLI and mailbox actions, preserves unsaved setup and draft text across reopening, and requires deliberate setup reload', heldSetup && preservedOnReopen && await evaluate(body => document.querySelector('#email-body').value === body && document.querySelector('#email-reload-config').hidden, body) && cliCalls.length === 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run(parseArguments(process.argv.slice(2))).catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });


