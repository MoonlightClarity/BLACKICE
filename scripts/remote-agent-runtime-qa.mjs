#!/usr/bin/env node
/**
 * Actual remote-server acceptance with a disposable profile and a deterministic
 * loopback model. The transport fixture implements only the Tailscale CLI; the
 * authentication store, gateway, server, engine, provider and persistence are real.
 * No browser, native model, user profile or real Tailscale service is opened.
 */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'qa-local::qa-deterministic';
const TASK = 'QA_REMOTE_ORIGINAL_CONTEXT: inspect the isolated remote runtime fixture and remember its first result for the next message.';
const FIRST = 'QA_REMOTE_FIRST_RESULT: the isolated first request was received. ' + 'The saved reply is available through bounded output windows. '.repeat(9);
const FOLLOWUP = 'QA_REMOTE_FOLLOWUP_CONTEXT: continue the same saved conversation and account for the latest shared plan.';
const HUMAN_NOTE = 'QA_REMOTE_HUMAN_PLAN: the paired human checked the first response and requires the saved context in the next request.';
const SECOND = 'QA_REMOTE_CONTEXT_RESTORED: original request, prior reply, follow-up and the latest human plan were present.';
const META = 'io.modelcontextprotocol/';
const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';

/** Guarded installers must match every name and every source hash in this report. */
export const REQUIRED_CHECKS = Object.freeze([
  'isolated-real-server-and-local-model',
  'dedicated-8443-preserves-existing-443',
  'one-use-browser-pairing-and-strict-cookie',
  'paired-browser-origin-and-local-management-boundaries',
  'agent-route-and-token-kind-boundaries',
  'read-only-agent-scopes-enforced',
  'modern-mcp-discovery-and-authenticated-identity',
  'legacy-mcp-initialize-and-scoped-tools',
  'concurrent-start-idempotency-one-inference',
  'bounded-output-reconstructs-real-result',
  'completed-start-retry-and-argument-conflict',
  'external-plan-edit-and-human-read-share-one-document',
  'planning-cas-conflict-preserves-current-document',
  'paired-human-edit-has-verified-client-provenance',
  'untrusted-author-and-runtime-fields-rejected',
  'compact-sse-refetch-contract-and-revision-events',
  'revocation-closes-existing-stream-and-denies-new-requests',
  'restart-restores-credentials-plan-and-idempotency',
  'continued-run-reuses-persisted-provider-context',
  'human-plan-completion-does-not-complete-running-model',
  'continued-request-retry-and-argument-conflict',
  'disable-revokes-clients-and-preserves-existing-443',
  'exact-inference-count-and-no-native-execution',
  'disposable-profile-and-listeners-cleaned-up',
  'full-application-and-source-fingerprints-unchanged',
  'report-excludes-credentials-and-private-payloads',
]);

export const SOURCES = Object.freeze([
  'package.json', 'server.mjs',
  'lib/remote-agent-api.mjs', 'lib/remote-access.mjs',
  'lib/remote-access-auth.mjs', 'lib/remote-access-gateway.mjs',
  'lib/remote-access-tailscale.mjs', 'lib/planning-workspace.mjs',
  'lib/task-state.mjs', 'lib/task-plan.mjs', 'lib/planning-edits.mjs',
  'lib/planning-runtime.mjs', 'lib/engine.mjs', 'lib/subagents.mjs',
  'lib/providers.mjs', 'lib/provider-store.mjs', 'lib/provider-transport.mjs',
  'lib/conversations.mjs', 'lib/runtime-settings.mjs', 'lib/event-stream.mjs',
  'public/mission-model.mjs', 'tests/fixtures/remote-transport.mjs',
  'scripts/release-check.mjs', 'scripts/release-signing.mjs',
  'scripts/distribution-manifest.mjs', 'scripts/install-background-update.mjs',
  'scripts/remote-agent-runtime-qa.mjs',
]);

export function parseArguments(argv) {
  const value = { candidate: ROOT, out: path.resolve(ROOT, '..', 'qa-remote'), timeoutMs: 120000 };
  const names = new Map([['--candidate', 'candidate'], ['--out', 'out'], ['--timeout-ms', 'timeoutMs']]);
  for (let index = 0; index < argv.length; index++) {
    if (['--help', '-h'].includes(argv[index])) return { help: true };
    const key = names.get(argv[index]);
    if (!key || !argv[index + 1] || argv[index + 1].startsWith('--')) throw Error('Use --candidate, --out or --timeout-ms with a value.');
    value[key] = key === 'timeoutMs' ? Number(argv[++index]) : path.resolve(argv[++index]);
  }
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 30000 || value.timeoutMs > 180000) throw Error('Use a bounded --timeout-ms from 30000 to 180000.');
  return value;
}

const ensure = (condition, message) => { if (!condition) throw Error(message); };
const equal = (first, second) => JSON.stringify(first) === JSON.stringify(second);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function sourceHashes(candidate) {
  const { captureSourceFiles } = await import(pathToFileURL(path.join(candidate, 'scripts/install-background-update.mjs')).href);
  const files = await captureSourceFiles(candidate);
  ensure(SOURCES.every(relative => /^[a-f0-9]{64}$/.test(files[relative] || '')), 'The complete source inventory omitted a required remote QA source.');
  return files;
}

function disabledControllers() {
  const desktop = new EventEmitter();
  desktop.status = () => ({ available: false, enabled: false, busy: false });
  desktop.setEnabled = async () => desktop.status();
  const browser = new EventEmitter();
  browser.status = () => ({ available: false, contained: true, acceptingActions: false, tabs: [], activeTabId: null, browsers: { relay: { available: false, tabs: [] } } });
  browser.cancel = async () => {}; browser.close = async () => {};
  const applicationWorkspace = new EventEmitter();
  applicationWorkspace.status = () => ({ available: false, sessions: [], documents: [], supportedApps: [], documentStorage: { healthy: true } });
  applicationWorkspace.close = async () => {};
  return { desktop, browser, applicationWorkspace };
}

function request({ port, host, route, method = 'GET', headers = {}, body, signal, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, agent: false, signal,
      headers: { Host: host || `127.0.0.1:${port}`, ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {}), ...headers } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) req.destroy(Error('The isolated HTTP response exceeded its bound.')); else chunks.push(chunk); });
      res.once('error', reject);
      res.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let value;
        if (/application\/json/i.test(String(res.headers['content-type'] || '')) && text) {
          try { value = JSON.parse(text); } catch { reject(Error('The isolated endpoint returned invalid JSON.')); return; }
        }
        resolve({ status: res.statusCode, headers: res.headers, text, value });
      });
    });
    req.once('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(Error('The isolated HTTP request exceeded its deadline.')));
    req.end(encoded);
  });
}

function expect(response, status, label) {
  ensure(response.status === status, `${label}: expected HTTP ${status}, received ${response.status}.`);
  return response.value;
}

async function openStream({ port, host, token, signal }) {
  const frames = [], closed = deferred(); let response, buffer = '', ended = false, parseError = null;
  const req = http.request({ hostname: '127.0.0.1', port, path: '/api/agent/events', agent: false, signal,
    headers: { Host: host, Authorization: 'Bearer ' + token, Accept: 'text/event-stream' } });
  const finish = () => { if (!ended) { ended = true; closed.resolve(); } };
  req.on('error', finish);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(Error('The isolated event stream did not open.')); }, 10000);
    req.once('error', error => { clearTimeout(timer); reject(error); });
    req.once('response', res => {
      clearTimeout(timer); response = res;
      if (res.statusCode !== 200 || !String(res.headers['content-type']).startsWith('text/event-stream')) {
        res.destroy(); reject(Error('The authenticated compact event stream was unavailable.')); return;
      }
      res.setEncoding('utf8');
      res.on('data', text => {
        buffer += text;
        if (buffer.length > 128000 || frames.length > 2000) { parseError = 'The compact event stream exceeded its bound.'; req.destroy(); return; }
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          try { frames.push(JSON.parse(data)); } catch { parseError = 'The event stream contained invalid JSON.'; req.destroy(); }
        }
      });
      res.once('close', finish); res.once('end', finish); res.once('error', finish);
      resolve();
    });
    req.end();
  });
  return { frames, closed: closed.promise, get ended() { return ended; }, get error() { return parseError; }, close() { req.destroy(); response?.destroy(); finish(); } };
}

/** Runs no work on import so installers can safely read the contract constants. */
export async function runRemoteAgentRuntimeQA(options = {}) {
  const candidate = await fs.realpath(options.candidate || ROOT);
  const out = path.resolve(options.out || path.join(candidate, '..', 'qa-remote'));
  const timeoutMs = options.timeoutMs || 120000;
  ensure(Number.isSafeInteger(timeoutMs) && timeoutMs >= 30000 && timeoutMs <= 180000, 'The QA deadline must be between 30000 and 180000 ms.');
  const outputRelative = path.relative(candidate, out);
  ensure(outputRelative.startsWith('..' + path.sep) || path.isAbsolute(outputRelative), 'The QA report must be written outside the candidate source directory.');
  const reportFile = path.join(out, 'remote-agent-runtime-report.json');
  const report = { format: 1, product: 'BLACKICE', version: null, platform: process.platform, candidate,
    startedAt: new Date().toISOString(), finishedAt: null, appFingerprintBefore: null, appFingerprintAfter: null,
    unchangedDuringChecks: false, sourceHashesBefore: {}, sourceHashesAfter: {},
    checks: [], passed: false, errors: [], cleanup: false,
    inferenceCounts: { beforeAdmission: 0, afterConcurrentStart: 0, afterCompletedStartRetry: 0, afterRestartRetry: 0, afterConcurrentContinue: 0, afterContinuedRetry: 0, total: 0, native: 0 },
    contextChecks: [], cleanupDetails: { applicationClosed: false, modelServerClosed: false, profileRemoved: false, ownedRouteRemoved: false, existing443Preserved: false },
  };
  const secrets = new Set();
  const remember = value => { if (typeof value === 'string' && value.length >= 8) secrets.add(value); return value; };
  const redact = error => {
    let message = String(error?.message || error || 'Unknown isolated QA error.');
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) message = message.split(secret).join('[credential removed]');
    return message.replace(/blackice_agent_[A-Za-z0-9_-]{43}/g, '[credential removed]').replace(/(?:relay_session_\d+|__Host-blackice_remote)=[^;\s]+/g, '[cookie removed]');
  };
  const fail = (stage, error) => report.errors.push({ stage, message: redact(error) });
  const pass = (name, evidence = {}) => {
    ensure(REQUIRED_CHECKS.includes(name) && !report.checks.some(item => item.name === name), 'An unexpected or duplicate QA check was recorded.');
    report.checks.push({ name, passed: true, ...evidence });
    if (options.onProgress) options.onProgress(name);
  };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(Error('The isolated remote runtime QA reached its deadline.')), timeoutMs);
  deadline.unref();
  const poll = async (predicate, label, duration = 15000) => {
    const end = Date.now() + duration;
    while (Date.now() < end) {
      controller.signal.throwIfAborted(); const result = await predicate(); if (result) return result;
      await delay(20);
    }
    throw Error(label + ' did not reach the required state within the deadline.');
  };
  const continuationGate = deferred(), streams = [];
  let profile, app, manager, runtime, modelServer, fixture, before443, fingerprint;
  let localOrigin, localCookie, remoteOrigin, browserCookie, paired, reader, writer;
  const modelErrors = [];
  const importCandidate = relative => import(pathToFileURL(path.join(candidate, relative)).href);
  const scoped443 = () => ({ TCP: fixture.config.TCP?.['443'], Web: fixture.config.Web?.[fixture.hostname + ':443'], AllowFunnel: fixture.config.AllowFunnel?.[fixture.hostname + ':443'] });
  const preserves443 = () => equal(scoped443(), before443);
  const local = (route, value = {}) => request({ port: new URL(localOrigin).port, route, signal: controller.signal,
    ...value, headers: { Cookie: localCookie, ...value.headers } });
  const remote = (route, value = {}) => request({ port: manager.gateway.port, host: new URL(remoteOrigin).host, route, signal: controller.signal, ...value });
  const agent = (route, value = {}, client = writer) => remote(route, { ...value, headers: { Authorization: 'Bearer ' + client.token, ...value.headers } });
  const human = (route, value = {}) => remote(route, { ...value, headers: { Cookie: browserCookie, ...(value.method && value.method !== 'GET' ? { Origin: remoteOrigin } : {}), ...value.headers } });
  const checkCode = (response, status, code, label) => { const value = expect(response, status, label); ensure(value?.code === code, label + ': the expected error code was absent.'); return value; };
  const completed = runId => poll(async () => {
    const value = expect(await agent('/api/agent/runs/' + runId), 200, 'Read admitted run');
    if (!value.settled) return false;
    ensure(value.status === 'completed', 'The actual model run did not complete successfully.'); return value;
  }, 'The actual model run');
  const mcp = (method, params = {}, { client = writer, modern = true, id = 1, headers = {} } = {}) => {
    const metadata = { [`${META}protocolVersion`]: MODERN, [`${META}clientCapabilities`]: {}, [`${META}clientInfo`]: { name: 'Untrusted transport label', version: '1' } };
    return agent('/mcp', { method: 'POST', headers: { Accept: 'application/json, text/event-stream',
      ...(modern ? { 'Mcp-Protocol-Version': MODERN, 'Mcp-Method': method, ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}) } : method !== 'initialize' ? { 'Mcp-Protocol-Version': LEGACY } : {}), ...headers },
      body: { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params: { ...params, ...(modern ? { _meta: metadata } : {}) } } }, client);
  };

  try {
    report.version = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')).version;
    report.sourceHashesBefore = await sourceHashes(candidate);
    try {
      ({ appFingerprint: fingerprint } = await importCandidate('scripts/release-check.mjs'));
      report.appFingerprintBefore = await fingerprint(candidate);
    } catch (error) { fail('application-fingerprint-before', error); }

    const [{ createHarnessServer }, { ProviderRuntime }, { RemoteAccessManager }, { createRemoteTransportFixture }, { REMOTE_COOKIE }] = await Promise.all([
      importCandidate('server.mjs'), importCandidate('lib/providers.mjs'), importCandidate('lib/remote-access.mjs'),
      importCandidate('tests/fixtures/remote-transport.mjs'), importCandidate('lib/remote-access-gateway.mjs'),
    ]);
    profile = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-remote-runtime-'));
    const dataDir = path.join(profile, 'data'), workspace = path.join(profile, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    fixture = createRemoteTransportFixture(); before443 = scoped443();
    modelServer = http.createServer((req, res) => {
      void (async () => {
        ensure(req.method === 'POST' && req.url === '/v1/chat/completions', 'The deterministic model received an unexpected endpoint.');
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; ensure(size < 2 * 1024 * 1024, 'The deterministic model input exceeded its bound.'); chunks.push(chunk); }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const messages = value.messages || [], text = JSON.stringify(messages), ordinal = ++report.inferenceCounts.total;
        const observation = { ordinal, requestedModel: value.model === 'qa-deterministic', originalTask: text.includes(TASK),
          previousAssistantReply: messages.some(item => item.role === 'assistant' && JSON.stringify(item.content).includes('QA_REMOTE_FIRST_RESULT')),
          followup: text.includes(FOLLOWUP), latestHumanPlan: text.includes(HUMAN_NOTE) };
        report.contextChecks.push(observation);
        ensure(ordinal <= 2 && observation.requestedModel && observation.originalTask, 'The real provider made an unexpected model request.');
        if (ordinal === 2) {
          ensure(observation.previousAssistantReply && observation.followup && observation.latestHumanPlan, 'The continued provider request did not contain the saved conversation and latest human plan.');
          await continuationGate.promise;
        }
        if (res.destroyed) return;
        const body = JSON.stringify({ id: 'isolated-' + ordinal, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: ordinal === 1 ? FIRST : SECOND }, finish_reason: 'stop' }], usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 } });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }); res.end(body);
      })().catch(error => {
        modelErrors.push(redact(error));
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'The isolated model fixture rejected this request.' } })); }
        else res.destroy();
      });
    });
    await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(0, '127.0.0.1', resolve); });
    const modelOrigin = 'http://127.0.0.1:' + modelServer.address().port;
    const startApplication = async first => {
      controller.signal.throwIfAborted();
      const codex = new EventEmitter();
      codex.status = () => ({ connected: false, authenticated: false, activeTurns: 0, models: [] });
      const native = async () => { report.inferenceCounts.native++; throw Error('The fixture must never execute a native model.'); };
      codex.start = native; codex.runAgent = native; codex.close = async () => {};
      runtime = await new ProviderRuntime({ codex, dataDir, requestTimeoutMs: 10000,
        fetchImpl: (input, init) => { ensure(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).origin === modelOrigin, 'The isolated provider attempted a non-fixture network request.'); return fetch(input, init); } }).init();
      if (first) {
        await runtime.saveProvider({ id: 'qa-local', type: 'compatible', name: 'Isolated QA model', baseUrl: modelOrigin + '/v1', models: ['qa-deterministic'] });
        await runtime.setDefaultModel(MODEL);
      }
      manager = new RemoteAccessManager({ dataDir, transport: fixture.transport, defaultHttpsPort: 8443 });
      app = await createHarnessServer({ port: 0, dataDir, defaultCwd: workspace, runtime, remoteAccess: manager, autoAttachDesktop: false, ...disabledControllers() });
      await app.learning.updateSettings({ mode: 'manual' });
      localOrigin = await app.listen();
      const page = await request({ port: new URL(localOrigin).port, route: '/', signal: controller.signal });
      expect(page, 200, 'Read actual local application');
      const cookie = page.headers['set-cookie']?.find(value => value.startsWith('relay_session_'));
      ensure(cookie, 'The actual local application did not issue its session.'); localCookie = remember(cookie.split(';')[0]); remember(localCookie.split('=')[1]);
      ensure(runtime.status().defaultModel === MODEL && path.resolve(app.engine.defaultCwd) === workspace, 'The isolated model or workspace was not selected.');
      if (!first) remoteOrigin = manager.status().url;
    };

    await startApplication(true);
    ensure(!manager.status().enabled && fixture.calls.length === 0 && report.inferenceCounts.total === 0, 'An unused remote transport or model started during boot.');
    pass('isolated-real-server-and-local-model');

    const enabled = expect(await local('/api/remote-access/enable', { method: 'POST', body: { mode: 'private' } }), 200, 'Enable isolated remote access');
    ensure(enabled.state === 'ready' && enabled.enabled && new URL(enabled.url).port === '8443' && preserves443(), 'The dedicated remote route was not enabled without preserving port 443.');
    remoteOrigin = enabled.url;
    ensure(fixture.config.Web[fixture.hostname + ':8443']?.Handlers?.['/']?.Proxy === 'http://127.0.0.1:' + manager.gateway.port, 'The dedicated route did not target the actual owned gateway.');
    pass('dedicated-8443-preserves-existing-443');

    const pairingPage = await remote('/'); expect(pairingPage, 200, 'Unpaired remote root'); ensure(pairingPage.text.includes('Pair this device'), 'An unpaired visitor saw the application instead of pairing.');
    expect(await remote('/api/status'), 401, 'Unpaired API request');
    const code = expect(await local('/api/remote-access/pair', { method: 'POST', body: {} }), 200, 'Issue one-use browser code');
    remember(code.code); remember(code.code.replace(/-/g, ''));
    const pairResponse = await remote('/remote/pair', { method: 'POST', headers: { Origin: remoteOrigin }, body: { code: code.code, label: 'QA paired human' } });
    paired = expect(pairResponse, 200, 'Pair actual browser credential').device;
    const cookie = pairResponse.headers['set-cookie']?.[0];
    ensure(cookie && cookie.startsWith(REMOTE_COOKIE + '=') && /; Secure(?:;|$)/.test(cookie) && /; HttpOnly(?:;|$)/.test(cookie) && /; SameSite=Strict(?:;|$)/.test(cookie) && /; Path=\/(?:;|$)/.test(cookie) && !/; Domain=/i.test(cookie), 'The pairing cookie did not have the required host-only protections.');
    browserCookie = remember(cookie.split(';')[0]); remember(browserCookie.split('=')[1]);
    expect(await remote('/remote/pair', { method: 'POST', headers: { Origin: remoteOrigin }, body: { code: code.code, label: 'QA duplicate browser' } }), 401, 'Pairing code reuse');
    pass('one-use-browser-pairing-and-strict-cookie');

    ensure(expect(await human('/api/status'), 200, 'Paired human application status').version === report.version, 'The paired browser did not reach the candidate application.');
    expect(await human('/api/remote-access/pair', { method: 'POST', body: {} }), 403, 'Remote local-management denial');
    expect(await human('/api/tasks/qa-placeholder/plan/edit', { method: 'POST', headers: { Origin: 'https://untrusted.invalid' }, body: {} }), 403, 'Cross-origin browser write denial');
    expect(await remote('/api/tasks/qa-placeholder/plan/edit', { method: 'POST', headers: { Cookie: browserCookie }, body: {} }), 403, 'Browser write without exact Origin');
    expect(await remote('/api/status', { headers: { Cookie: browserCookie, Host: 'untrusted.invalid' } }), 403, 'Wrong remote Host');
    pass('paired-browser-origin-and-local-management-boundaries');

    reader = expect(await local('/api/remote-access/create-agent', { method: 'POST', body: { label: 'QA read-only outside agent', scopes: ['read'] } }), 200, 'Issue read-only credential');
    writer = expect(await local('/api/remote-access/create-agent', { method: 'POST', body: { label: 'QA outside agent', scopes: ['read', 'planning:write', 'tasks:write'] } }), 200, 'Issue task-and-plan credential');
    remember(reader.token); remember(writer.token);
    const status = expect(await agent('/api/agent/status'), 200, 'Outside agent status');
    ensure(status.client?.id === writer.device.id && status.client?.name === writer.device.label && status.client?.kind === 'agent', 'The outside client identity was not derived from its credential.');
    for (const route of ['/', '/api/runs', '/api/providers', '/api/tasks/qa-placeholder/plan/edit']) expect(await agent(route), 403, 'Agent legacy route denial');
    expect(await remote('/api/status', { headers: { Cookie: REMOTE_COOKIE + '=' + writer.token } }), 401, 'Agent token used as browser cookie');
    expect(await local('/api/agent/status', { headers: { Authorization: 'Bearer ' + writer.token, 'X-Blackice-Remote': '1', 'X-Blackice-Forward': 'A'.repeat(43) } }), 401, 'Direct local machine-route bypass');
    expect(await agent('/api/agent/status', { headers: { Origin: 'https://untrusted.invalid' } }), 403, 'Agent wrong Origin');
    pass('agent-route-and-token-kind-boundaries');

    const startBody = { task: TASK, requestId: 'qa-start-one', model: MODEL, planningMode: 'off' };
    checkCode(await agent('/api/agent/tasks', { method: 'POST', body: startBody }, reader), 403, 'REMOTE_SCOPE_REQUIRED', 'Read-only task admission');
    checkCode(await agent('/api/agent/tasks/qa-placeholder/plan', { method: 'POST', body: { expectedRevision: 1, operations: [{ type: 'metadata', patch: { goal: 'Not admitted' } }] } }, reader), 403, 'REMOTE_SCOPE_REQUIRED', 'Read-only plan write');
    ensure(report.inferenceCounts.total === 0, 'A rejected read-only write invoked a model.');
    pass('read-only-agent-scopes-enforced');

    const discovery = expect(await mcp('server/discover'), 200, 'Modern MCP discovery').result;
    ensure(discovery?.supportedVersions?.includes(MODERN) && discovery?.supportedVersions?.includes(LEGACY) && discovery?.resultType === 'complete' && discovery?._meta?.[META + 'serverInfo']?.version === report.version, 'Modern MCP discovery did not match the actual server.');
    const tools = expect(await mcp('tools/list', {}, { client: reader }), 200, 'Modern scoped tools').result.tools;
    ensure(tools.length >= 5 && tools.every(tool => tool.annotations?.readOnlyHint === true) && !tools.some(tool => tool.name === 'blackice_start_task' || tool.name === 'blackice_edit_plan'), 'The read-only MCP catalog exposed write tools.');
    const called = expect(await mcp('tools/call', { name: 'blackice_status', arguments: {} }), 200, 'Modern actual status call').result;
    ensure(called.isError === false && called.structuredContent.client.name === writer.device.label && called.structuredContent.client.id === writer.device.id, 'MCP clientInfo replaced the authenticated actor.');
    const mismatch = expect(await mcp('tools/call', { name: 'blackice_status', arguments: {} }, { headers: { 'Mcp-Name': 'blackice_start_task' } }), 400, 'Modern mirrored-header validation');
    ensure(mismatch.error?.code === -32020, 'Modern MCP accepted a mismatched tool header.');
    expect(await agent('/mcp'), 405, 'MCP method discovery');
    pass('modern-mcp-discovery-and-authenticated-identity');

    const initialization = await mcp('initialize', { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'QA legacy client', version: '1' } }, { modern: false });
    ensure(expect(initialization, 200, 'Legacy initialize').result.protocolVersion === LEGACY && !initialization.headers['mcp-session-id'], 'Legacy MCP did not negotiate its stateless protocol.');
    expect(await agent('/mcp', { method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': LEGACY }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } }), 202, 'Legacy initialized notification');
    const legacyTools = expect(await mcp('tools/list', {}, { modern: false, client: reader }), 200, 'Legacy scoped tools').result.tools;
    ensure(equal(legacyTools.map(tool => tool.name), tools.map(tool => tool.name)), 'Legacy and modern tool scopes diverged.');
    const legacyStatus = expect(await mcp('tools/call', { name: 'blackice_status', arguments: {} }, { modern: false, client: reader }), 200, 'Legacy actual status call').result;
    ensure(legacyStatus.structuredContent?.client?.id === reader.device.id && legacyStatus.isError === false, 'Legacy MCP did not execute with the actual credential.');
    pass('legacy-mcp-initialize-and-scoped-tools');

    const stream = await openStream({ port: manager.gateway.port, host: new URL(remoteOrigin).host, token: reader.token, signal: controller.signal }); streams.push(stream);
    await poll(() => stream.frames.some(item => item.type === 'ready'), 'Compact SSE ready frame');
    const starts = await Promise.all([agent('/api/agent/tasks', { method: 'POST', body: startBody }), agent('/api/agent/tasks', { method: 'POST', body: startBody })]);
    const firstAdmission = expect(starts[0], 202, 'First concurrent task admission'), duplicateAdmission = expect(starts[1], 202, 'Duplicate concurrent task admission');
    ensure(firstAdmission.runId && firstAdmission.runId === duplicateAdmission.runId && firstAdmission.taskId === duplicateAdmission.taskId, 'Concurrent identical starts admitted two runs.');
    const firstRun = await completed(firstAdmission.runId), taskId = firstRun.taskId;
    report.inferenceCounts.afterConcurrentStart = report.inferenceCounts.total;
    ensure(report.inferenceCounts.total === 1 && firstRun.remoteClient?.id === writer.device.id, 'One admitted start did not produce exactly one real inference and verified actor.');
    pass('concurrent-start-idempotency-one-inference', { inferenceCount: 1 });

    const expectedOutput = firstRun.output.text;
    const workerOutput = expect(await agent(`/api/agent/runs/${firstRun.runId}/output?nodeId=agent&limit=12000`), 200, 'Read exact provider result');
    ensure(workerOutput.text === FIRST && expectedOutput.includes(FIRST), 'The actual worker output did not retain the complete deterministic provider result.');
    let output = '', offset = 0, windows = 0;
    while (offset !== null) {
      const value = expect(await agent(`/api/agent/runs/${firstRun.runId}/output?offset=${offset}&limit=83`), 200, 'Read actual output window');
      ensure(value.offset === offset && value.limit === 83 && value.text.length <= 83 && value.totalCharacters === expectedOutput.length, 'The output window did not preserve its bound or total.');
      output += value.text; offset = value.nextOffset; windows++; ensure(windows < 30, 'Output pagination did not terminate.');
    }
    ensure(output === expectedOutput && windows > 1 && !Object.hasOwn(firstRun, 'workflow') && !Object.hasOwn(firstRun, 'events') && !JSON.stringify(firstRun).includes('provider_'), 'The compact run result leaked internal state or lost output.');
    pass('bounded-output-reconstructs-real-result', { windows, characters: output.length });

    const retry = expect(await agent('/api/agent/tasks', { method: 'POST', body: startBody }), 202, 'Retry completed admission');
    ensure(retry.runId === firstRun.runId, 'Retrying a completed request created another run.');
    checkCode(await agent('/api/agent/tasks', { method: 'POST', body: { ...startBody, task: TASK + ' Different request arguments.' } }), 409, 'RUN_REQUEST_CONFLICT', 'Start request argument conflict');
    report.inferenceCounts.afterCompletedStartRetry = report.inferenceCounts.total;
    ensure(report.inferenceCounts.total === 1, 'A completed retry or rejected conflict invoked another model.');
    pass('completed-start-retry-and-argument-conflict', { inferenceCount: 1 });

    let state = expect(await agent('/api/agent/tasks/' + taskId), 200, 'Read admitted shared task');
    const initialRevision = state.revision;
    state = expect(await agent(`/api/agent/tasks/${taskId}/plan`, { method: 'POST', body: { expectedRevision: initialRevision, operations: [
      { type: 'metadata', patch: { layout: 'sequence' } },
      { type: 'add', step: { id: 'remote-first', kind: 'action', title: 'Check the first actual provider response', status: 'pending', doneWhen: 'The actual first response is reconstructed from bounded API windows.' } },
      { type: 'add', step: { id: 'remote-context', kind: 'action', title: 'Check the saved provider context', status: 'pending', dependsOn: ['remote-first'], doneWhen: 'The next actual provider request contains the saved conversation and latest human plan.' } },
    ] } }), 200, 'Outside agent shared-plan edit');
    ensure(state.revision === initialRevision + 1 && state.provenance.source === 'agent' && equal(state.provenance.actor, { type: 'external-agent', id: writer.device.id, name: writer.device.label }) && state.provenance.runId === undefined, 'The external edit did not preserve distinct verified provenance.');
    ensure(state.availableWork?.ready?.includes('remote-first') && state.availableWork?.byId?.['remote-context']?.prerequisites?.some(item => item.id === 'remote-first' && item.satisfied === false), 'The actual shared plan did not derive its dependency readiness.');
    ensure(equal(expect(await human('/api/tasks/' + taskId), 200, 'Paired human shared-plan read'), state), 'The human and outside agent read different task documents.');
    pass('external-plan-edit-and-human-read-share-one-document');

    const stale = checkCode(await agent(`/api/agent/tasks/${taskId}/plan`, { method: 'POST', body: { expectedRevision: initialRevision, operations: [{ type: 'update', stepId: 'remote-first', patch: { title: 'Stale edit must not win' } }] } }), 409, 'TASK_STATE_CONFLICT', 'External stale plan revision');
    ensure(stale.currentRevision === state.revision && equal(expect(await agent('/api/agent/tasks/' + taskId), 200, 'Read after CAS conflict'), state), 'A conflicting external edit changed the shared document.');
    pass('planning-cas-conflict-preserves-current-document');

    state = expect(await human(`/api/tasks/${taskId}/plan/edit`, { method: 'POST', body: { expectedRevision: state.revision, operations: [
      { type: 'update', stepId: 'remote-first', patch: { status: 'done', evidence: 'The QA reconstructed and compared every byte of the actual first response.' } },
      { type: 'update', stepId: 'remote-context', patch: { note: HUMAN_NOTE } },
    ] } }), 200, 'Paired ordinary human plan edit');
    ensure(state.provenance.source === 'human' && equal(state.provenance.actor, { type: 'human-client', id: paired.id, name: paired.label }), 'The ordinary paired-browser plan edit lost its verified human-client actor.');
    ensure(equal(expect(await agent('/api/agent/tasks/' + taskId), 200, 'Outside read after human edit'), state) && state.availableWork.ready.includes('remote-context'), 'The outside agent did not receive the human edit and updated readiness.');
    const humanRevision = state.revision, humanState = structuredClone(state);
    pass('paired-human-edit-has-verified-client-provenance');

    const editBody = { expectedRevision: state.revision, operations: [{ type: 'update', stepId: 'remote-context', patch: { title: 'Untrusted attempt' } }] };
    checkCode(await agent(`/api/agent/tasks/${taskId}/plan`, { method: 'POST', body: { ...editBody, actor: { type: 'human-client', id: paired.id, name: 'Forged actor' } } }), 400, 'REMOTE_REQUEST_INVALID', 'Forged machine plan author');
    expect(await human(`/api/tasks/${taskId}/plan/edit`, { method: 'POST', body: { ...editBody, actor: { type: 'external-agent', id: writer.device.id, name: 'Forged actor' } } }), 400, 'Forged browser plan author');
    checkCode(await agent('/api/agent/tasks', { method: 'POST', body: { ...startBody, requestId: 'qa-untrusted-workspace', cwd: path.dirname(workspace) } }), 400, 'REMOTE_REQUEST_INVALID', 'Untrusted machine workspace');
    checkCode(await agent(`/api/agent/tasks/${taskId}/plan`, { method: 'POST', body: { expectedRevision: state.revision, operations: [{ type: 'update', stepId: 'remote-context', patch: { execution: { status: 'completed' } } }] } }), 400, 'REMOTE_REQUEST_INVALID', 'Forged runtime completion');
    ensure(equal(expect(await agent('/api/agent/tasks/' + taskId), 200, 'Read after rejected write fields'), state) && report.inferenceCounts.total === 1, 'An invalid author, workspace or runtime field changed admitted work.');
    pass('untrusted-author-and-runtime-fields-rejected');

    await poll(() => stream.frames.some(item => item.type === 'planning.updated' && item.taskId === taskId && item.revision === humanRevision), 'The paired human revision on compact SSE');
    const ready = stream.frames.find(item => item.type === 'ready');
    ensure(ready.replay === false && ready.refetchOnReconnect === true && !stream.error, 'The event stream did not advertise its refetch contract.');
    const keys = new Set(['type', 'runId', 'nodeId', 'taskId', 'revision', 'status', 'at']);
    ensure(stream.frames.filter(item => item.type !== 'ready').every(item => ['run.updated', 'node.updated', 'planning.updated'].includes(item.type) && Object.keys(item).every(key => keys.has(key))), 'A compact event contained an unapproved field or raw model event.');
    const streamText = JSON.stringify(stream.frames);
    ensure(![TASK, FIRST, HUMAN_NOTE].some(value => streamText.includes(value)), 'Compact SSE exposed a private task, output or plan payload.');
    pass('compact-sse-refetch-contract-and-revision-events', { frames: stream.frames.length });

    expect(await local('/api/remote-access/revoke', { method: 'POST', body: { id: reader.device.id } }), 200, 'Revoke stream client');
    await poll(() => stream.ended, 'Revocation of the existing event stream');
    expect(await agent('/api/agent/status', {}, reader), 401, 'Revoked credential request');
    expect(await agent('/api/agent/status'), 200, 'Other credential after revoke');
    pass('revocation-closes-existing-stream-and-denies-new-requests');

    const initialThread = Object.values(app.engine.getRun(firstRun.runId).nodes).find(node => node.threadId)?.threadId;
    ensure(initialThread?.startsWith('provider_'), 'The first run did not create a real persisted provider thread.');
    await app.close(); app = null;
    ensure(!fixture.config.TCP?.['8443'] && preserves443(), 'Graceful close left the owned route or changed port 443.');
    await startApplication(false);
    ensure(manager.status().enabled && preserves443(), 'The saved isolated remote configuration did not restart cleanly.');
    expect(await human('/api/status'), 200, 'Paired browser after restart');
    expect(await agent('/api/agent/status'), 200, 'Outside agent after restart');
    expect(await agent('/api/agent/status', {}, reader), 401, 'Revoked credential after restart');
    ensure(equal(expect(await human('/api/tasks/' + taskId), 200, 'Shared plan after restart'), humanState), 'The shared document or verified human provenance was not durable.');
    const restartRetry = expect(await agent('/api/agent/tasks', { method: 'POST', body: startBody }), 202, 'Original request after restart');
    report.inferenceCounts.afterRestartRetry = report.inferenceCounts.total;
    ensure(restartRetry.runId === firstRun.runId && report.inferenceCounts.total === 1, 'A restart retry did not recover the original admitted run without inference.');
    checkCode(await agent('/api/agent/tasks', { method: 'POST', body: { ...startBody, task: TASK + ' Changed after restart.' } }), 409, 'RUN_REQUEST_CONFLICT', 'Start argument conflict after restart');
    const deviceBytes = await fs.readFile(path.join(dataDir, 'remote-access-devices.json'), 'utf8');
    ensure(![writer.token, reader.token, browserCookie.split('=')[1]].some(secret => deviceBytes.includes(secret)), 'The durable remote profile stored a raw credential.');
    pass('restart-restores-credentials-plan-and-idempotency', { inferenceCount: 1, rawCredentialsAbsentOnDisk: true });

    const continuation = { message: FOLLOWUP, requestId: 'qa-continue-one', planningMode: 'off' };
    const replies = await Promise.all([agent(`/api/agent/runs/${firstRun.runId}/continue`, { method: 'POST', body: continuation }), agent(`/api/agent/runs/${firstRun.runId}/continue`, { method: 'POST', body: continuation })]);
    const admittedReply = expect(replies[0], 202, 'First continued request'), duplicateReply = expect(replies[1], 202, 'Duplicate continued request');
    ensure(admittedReply.runId !== firstRun.runId && admittedReply.runId === duplicateReply.runId && admittedReply.taskId === taskId, 'Continuation did not share one admitted run and saved task.');
    await poll(() => report.contextChecks.length === 2 || modelErrors.length, 'The actual continued model request');
    ensure(modelErrors.length === 0 && report.contextChecks[1].previousAssistantReply && report.contextChecks[1].followup && report.contextChecks[1].latestHumanPlan, 'The continued inference lost the saved provider context or current plan.');
    report.inferenceCounts.afterConcurrentContinue = report.inferenceCounts.total;
    const continuedThread = Object.values(app.engine.getRun(admittedReply.runId).nodes).find(node => node.threadId)?.threadId;
    ensure(continuedThread === initialThread && await runtime.savedThreadModel(continuedThread) === MODEL && report.inferenceCounts.total === 2, 'The actual continuation did not reuse its persisted provider thread and model exactly once.');
    pass('continued-run-reuses-persisted-provider-context', { inferenceCount: 2, persistedProviderThreadReused: true });

    state = expect(await human('/api/tasks/' + taskId), 200, 'Read shared plan during actual inference');
    state = expect(await human(`/api/tasks/${taskId}/plan/edit`, { method: 'POST', body: { expectedRevision: state.revision, operations: [{ type: 'update', stepId: 'remote-context', patch: { status: 'done', evidence: 'The QA observed the actual continued request containing the original message, saved reply, follow-up and latest human plan.' } }] } }), 200, 'Human completes observed plan work during inference');
    const stillRunning = expect(await agent('/api/agent/runs/' + admittedReply.runId), 200, 'Actual execution after human plan completion');
    ensure(state.steps.filter(step => step.kind === 'action').every(step => step.status === 'done') && stillRunning.status === 'running' && stillRunning.settled === false && stillRunning.output.text === '', 'Completing plan work falsely completed or fabricated the pending model response.');
    pass('human-plan-completion-does-not-complete-running-model');
    continuationGate.resolve();
    const finishedReply = await completed(admittedReply.runId);
    const continuedOutput = expect(await agent(`/api/agent/runs/${finishedReply.runId}/output?nodeId=agent&limit=12000`), 200, 'Read exact continued provider result');
    ensure(continuedOutput.text === SECOND && finishedReply.output.text.includes(SECOND), 'The real continued model response was not retained.');
    const replayReply = expect(await agent(`/api/agent/runs/${firstRun.runId}/continue`, { method: 'POST', body: continuation }), 202, 'Retry completed continuation');
    ensure(replayReply.runId === admittedReply.runId, 'A completed continuation retry admitted another run.');
    checkCode(await agent(`/api/agent/runs/${firstRun.runId}/continue`, { method: 'POST', body: { ...continuation, message: FOLLOWUP + ' Different follow-up.' } }), 409, 'RUN_REQUEST_CONFLICT', 'Continue argument conflict');
    report.inferenceCounts.afterContinuedRetry = report.inferenceCounts.total;
    ensure(report.inferenceCounts.total === 2, 'A continuation retry or rejected conflict caused another inference.');
    pass('continued-request-retry-and-argument-conflict', { inferenceCount: 2 });

    const disabled = expect(await local('/api/remote-access/disable', { method: 'POST', body: {} }), 200, 'Disable isolated remote access');
    ensure(disabled.enabled === false && disabled.state === 'disabled' && !fixture.config.TCP?.['8443'] && preserves443() && manager.sessions.status().devices.length === 0, 'Disabling did not remove only the owned route and revoke all client credentials.');
    pass('disable-revokes-clients-and-preserves-existing-443');
    ensure(report.inferenceCounts.total === 2 && report.inferenceCounts.native === 0 && modelErrors.length === 0 && fixture.calls.every(args => !args.includes('reset') && !args.some(arg => /--https=443(?:$|\s)/.test(arg))), 'The fixture invoked extra model work, a native runtime or a non-owned route operation.');
    pass('exact-inference-count-and-no-native-execution', { realHttpInferences: 2, nativeCalls: 0 });
  } catch (error) { fail('runtime-checks', error); }
  finally {
    continuationGate.resolve();
    for (const stream of streams) stream.close();
    try { if (app) { await app.close(); app = null; } else { await manager?.close(); await runtime?.close(); } report.cleanupDetails.applicationClosed = true; } catch (error) { fail('application-cleanup', error); }
    try {
      if (modelServer) { modelServer.closeAllConnections(); if (modelServer.listening) await new Promise((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve())); }
      report.cleanupDetails.modelServerClosed = true;
    } catch (error) { fail('model-cleanup', error); }
    try {
      if (profile) { await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); await fs.access(profile).then(() => { throw Error('The disposable profile still exists.'); }, error => { if (error.code !== 'ENOENT') throw error; }); }
      report.cleanupDetails.profileRemoved = true;
    } catch (error) { fail('profile-cleanup', error); }
    if (fixture) {
      report.cleanupDetails.ownedRouteRemoved = !fixture.config.TCP?.['8443'] && !fixture.config.Web?.[fixture.hostname + ':8443'];
      report.cleanupDetails.existing443Preserved = preserves443();
    }
    report.cleanup = Object.values(report.cleanupDetails).every(value => value === true);
    if (report.cleanup) pass('disposable-profile-and-listeners-cleaned-up');
    else fail('cleanup', 'Not every disposable resource was removed and verified.');
    try { report.sourceHashesAfter = await sourceHashes(candidate); } catch (error) { fail('source-fingerprint-after', error); }
    try { if (fingerprint) report.appFingerprintAfter = await fingerprint(candidate); } catch (error) { fail('application-fingerprint-after', error); }
    report.unchangedDuringChecks = /^[a-f0-9]{64}$/.test(report.appFingerprintBefore || '') && report.appFingerprintBefore === report.appFingerprintAfter && equal(report.sourceHashesBefore, report.sourceHashesAfter) && SOURCES.every(relative => /^[a-f0-9]{64}$/.test(report.sourceHashesBefore[relative] || ''));
    if (report.unchangedDuringChecks) pass('full-application-and-source-fingerprints-unchanged');
    else if (!report.errors.some(error => error.stage.startsWith('application-fingerprint'))) fail('source-integrity', 'The full application or required source fingerprints changed during the isolated checks.');
    clearTimeout(deadline); controller.abort();
  }

  report.finishedAt = new Date().toISOString();
  const serialized = JSON.stringify(report);
  const leakedSecret = [...secrets].some(secret => serialized.includes(secret));
  const leakedPayload = [TASK, FIRST, FOLLOWUP, HUMAN_NOTE, SECOND].some(value => serialized.includes(value));
  if (!leakedSecret && !leakedPayload) pass('report-excludes-credentials-and-private-payloads');
  else fail('report-redaction', 'The report contained a credential or private fixture payload and was redacted.');
  report.missingChecks = REQUIRED_CHECKS.filter(name => !report.checks.some(check => check.name === name && check.passed === true));
  report.passed = report.errors.length === 0 && report.missingChecks.length === 0 && report.cleanup && report.unchangedDuringChecks;
  await fs.mkdir(out, { recursive: true });
  const safeReport = JSON.parse(redact(JSON.stringify(report)));
  // Raw model payloads are never report fields. Fail closed if a future edit adds one.
  for (const value of [TASK, FIRST, FOLLOWUP, HUMAN_NOTE, SECOND]) ensure(!JSON.stringify(safeReport).includes(value), 'The report unexpectedly contained private fixture text.');
  await fs.writeFile(reportFile, JSON.stringify(safeReport, null, 2) + '\n');
  return { report: safeReport, reportFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/remote-agent-runtime-qa.mjs [--candidate directory] [--out directory] [--timeout-ms 120000]');
    else {
      const { report, reportFile } = await runRemoteAgentRuntimeQA({ ...options, onProgress: name => console.log('PASS ' + name) });
      console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, expectedChecks: REQUIRED_CHECKS.length, inferenceCounts: report.inferenceCounts, cleanup: report.cleanup, unchangedDuringChecks: report.unchangedDuringChecks, reportFile, errors: report.errors }, null, 2));
      if (!report.passed) process.exitCode = 1;
    }
  } catch (error) { console.error('Remote runtime QA could not finish: ' + String(error?.message || error).replace(/blackice_agent_[A-Za-z0-9_-]{43}/g, '[credential removed]')); process.exitCode = 1; }
}
