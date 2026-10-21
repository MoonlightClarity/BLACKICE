/** Actual Electron acceptance; all identities, addresses and credentials are disposable fixtures. */
import assert from 'node:assert/strict';
import { app, BrowserWindow, safeStorage } from 'electron';
import { EventEmitter } from 'node:events';
import { promises as fs, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHarnessServer } from '../../server.mjs';
import { RemoteAccessManager } from '../../lib/remote-access.mjs';
import { REMOTE_SCOPES } from '../../lib/remote-access-auth.mjs';
import { AgentEmailStore } from '../../lib/agent-email.mjs';
import { REMOTE_ACCESS_NATIVE_QA_CHECKS } from '../../scripts/remote-access-native-qa.mjs';
import { createRemoteTransportFixture } from './remote-transport.mjs';
import { createFixtureCertificate, createFixtureFetch, FIXTURE_HOSTNAME, FIXTURE_ORIGIN } from './remote-access-native-tls.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)), values = {}, args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--profile-dir', '--out', '--receipt', '--nonce'].includes(args[index]) && args[index + 1]);
  assert.equal(values[args[index]], undefined); values[args[index]] = args[index + 1];
}
const profile = values['--profile-dir'], out = values['--out'], receiptFile = values['--receipt'], nonce = values['--nonce'];
assert.equal(process.platform, 'win32'); assert.match(nonce || '', /^[a-f0-9-]{36}$/);
assert.ok([profile, out, receiptFile].every(value => path.isAbsolute(value || '')));
assert.equal(profile, path.join(out, 'owned-profile-' + nonce));
assert.equal(receiptFile, path.join(out, 'native-remote-access-result-' + nonce + '.json'));
const deadline = Number(process.env.BLACKICE_ACCESS_QA_DEADLINE);
assert.ok(Number.isFinite(deadline) && deadline > Date.now() && deadline <= Date.now() + 180000);
app.setPath('userData', profile); assert.equal(app.requestSingleInstanceLock(), true);
app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});

const report = {
  schema: 1, nonce, pid: process.pid, profile, platform: process.platform, fixtureOnly: true,
  runtime: { executable: process.execPath, electronVersion: process.versions.electron, browserWindows: 0 },
  transport: { fixtureOnly: true, tlsValidated: false, dnsMappedToOwnedLoopback: true, trustStoreChanged: false, requests: 0, unexpected: 0, tailscaleCommandsEmulated: true },
  commands: [], checks: [], errors: [], cleanup: false, forcedCleanup: false,
  providerTurnsRequested: 0, realRemoteExposure: false, realCredentialIssued: false,
};
const progressFile = path.join(out, 'native-remote-access-progress-' + nonce + '.json');
const markerFile = path.join(profile, 'desktop-runtime.json'), tlsContextFile = path.join(profile, 'tls-context-' + nonce + '.json');
const children = [], secrets = new Set(), tlsSockets = new Set(), hostActions = [];
const environment = { ...process.env, APPDATA: path.join(profile, 'client-roaming'), LOCALAPPDATA: path.join(profile, 'client-local'), XDG_CONFIG_HOME: path.join(profile, 'client-config'), XDG_CACHE_HOME: path.join(profile, 'client-cache'), XDG_DATA_HOME: path.join(profile, 'client-data') };
for (const name of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'BLACKICE_EMAIL_ACCESS_TOKEN', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']) delete environment[name];
let harness, tlsServer, manager, remoteFetch, localUrl, localCookie, tlsPort, gatewayPort, fixtureNow = Date.now(), finished = false;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const secret = value => { if (typeof value === 'string' && value.length) secrets.add(value); return value; };
function safeText() {
  const encoded = JSON.stringify(report, null, 2);
  assert.ok([...secrets].every(value => !encoded.includes(value)), 'Native acceptance reports contain no code or credential.');
  assert.doesNotMatch(encoded, /blackice_agent_[A-Za-z0-9_-]{43}|(?:[A-F0-9]{4}-){7}[A-F0-9]{4}|-----BEGIN (?:RSA )?PRIVATE KEY-----/);
  return encoded + '\n';
}
function checkpoint(stage) {
  report.stage = stage; report.updatedAt = new Date().toISOString();
  writeFileSync(progressFile, safeText());
  process.stdout.write(JSON.stringify({ stage, checks: report.checks.length, commands: report.commands.length }) + '\n');
  assert.ok(Date.now() < deadline, 'The native access fixture remains within its bounded lifetime.');
}
async function bounded(stage, operation, timeoutMs = 5000) {
  checkpoint(stage); let timer;
  try {
    return await Promise.race([operation, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Error('Owned native access operation timed out.')), Math.max(1, Math.min(timeoutMs, deadline - Date.now())));
    })]);
  } finally { clearTimeout(timer); }
}
function check(index, value) {
  assert.equal(report.checks.length, index); assert.ok(value, REMOTE_ACCESS_NATIVE_QA_CHECKS[index]);
  report.checks.push({ name: REMOTE_ACCESS_NATIVE_QA_CHECKS[index], passed: true });
  checkpoint('passed: ' + REMOTE_ACCESS_NATIVE_QA_CHECKS[index]);
}
class Runtime extends EventEmitter {
  status() { return { connected: true, authenticated: true, models: [], defaultModel: null }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { report.providerTurnsRequested++; throw Error('Native access acceptance must never start model work.'); }
}
class Desktop extends EventEmitter {
  status() { return { available: false, enabled: false }; }
  async setEnabled() { return this.status(); }
}
async function command(label, mode, commandArgs, { code = '', expectedExitCode = 0, json = true } = {}) {
  checkpoint(label);
  const helper = path.join(ROOT, 'scripts', 'remote-access-cli.mjs');
  const actualArgs = mode === 'native' ? [ROOT, ...commandArgs] : [mode === 'helper' ? helper : path.join(ROOT, 'tests', 'fixtures', 'remote-access-native-client.mjs'), ...commandArgs];
  const env = { ...environment };
  if (mode !== 'native') env.ELECTRON_RUN_AS_NODE = '1';
  if (mode === 'tls-helper') { env.BLACKICE_ACCESS_QA_CONTEXT = tlsContextFile; env.BLACKICE_ACCESS_QA_NONCE = nonce; }
  const child = spawn(process.execPath, actualArgs, { cwd: profile, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);
  // These fixed fixture arguments contain no code or credential. Keep the
  // launch shape and exit signal visible without persisting command output.
  const commandStarted = Date.now();
  const entry = { label, mode, pid: child.pid, executable: process.execPath, args: [...commandArgs], expectedExitCode, exited: false, exitCode: null, signal: null, spawnErrorCode: null, durationMs: null, stdinLogged: false, stdoutLogged: false, stdoutBytes: 0, stderrBytes: 0 };
  report.commands.push(entry); const owned = { child, entry }; children.push(owned);
  const chunks = [];
  child.stdout.on('data', chunk => { entry.stdoutBytes += chunk.length; if (entry.stdoutBytes <= 65536) chunks.push(chunk); else { report.forcedCleanup = true; child.kill(); } });
  child.stderr.on('data', chunk => { entry.stderrBytes += chunk.length; });
  owned.done = new Promise(resolve => {
    child.once('close', (exitCode, signal) => { entry.exited = true; entry.exitCode = exitCode; entry.signal = signal; entry.durationMs = Date.now() - commandStarted; resolve(); });
    child.once('error', cause => { entry.exited = true; entry.exitCode = null; entry.spawnErrorCode = /^E[A-Z0-9_]+$/.test(cause.code || '') ? cause.code : 'UNKNOWN'; entry.durationMs = Date.now() - commandStarted; resolve(); });
  });
  child.stdin.on('error', () => {}); child.stdin.end(code);
  const timeout = Math.max(1, Math.min(35000, deadline - Date.now()));
  await Promise.race([owned.done, sleep(timeout)]);
  if (!entry.exited) {
    report.forcedCleanup = true;
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    await Promise.race([new Promise(resolve => { killer.once('close', resolve); killer.once('error', resolve); }), sleep(3000)]);
    await Promise.race([owned.done, sleep(2000)]);
  }
  assert.equal(entry.exited, true, 'The owned CLI command exits.');
  assert.equal(entry.exitCode, expectedExitCode, 'The native CLI returns its expected exit code for ' + label + '.');
  const text = Buffer.concat(chunks).toString('utf8');
  if (!json) return text;
  let result; try { result = JSON.parse(text); } catch { throw Error('The native CLI did not return a single JSON receipt.'); }
  secret(result.code); secret(result.token);
  return result;
}
// Electron's native Windows launch guard treats a bare tasks:write value as
// a URL; equals-form application options keep it an option value.
const issue = (kind = 'agent', scopes = ['read'], mode = 'native') => command('issue ' + kind + ' code using ' + mode, mode, ['remote', 'code', '--kind', kind, ...(kind === 'agent' ? scopes.map(scope => '--scope=' + scope) : []), '--profile-dir', profile, '--json']);
const pair = (grant, { output, name = 'Native fixture agent', expectedExitCode = 0 } = {}) => command('redeem agent code' + (output ? ' to private file' : ''), 'tls-helper', ['remote', 'pair', '--url=' + FIXTURE_ORIGIN, '--code-stdin', '--name=' + name, ...(output ? ['--output', output] : []), '--json'], { code: grant.code + '\n', expectedExitCode });
async function local(route, method = 'GET', body) {
  const response = await fetch(localUrl + route, { method, headers: { Cookie: localCookie, Origin: localUrl, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert.equal(response.status, 200, 'The owned local API accepts ' + route); return response.json();
}
async function remote(route, { token, method = 'GET', body } = {}) {
  const response = await remoteFetch(FIXTURE_ORIGIN + route, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), Origin: FIXTURE_ORIGIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  let value; try { value = await response.json(); } catch {}
  return { status: response.status, headers: response.headers, value };
}
async function listenerClosed(port) {
  if (!port) return true;
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(false)); socket.once('error', cause => finish(cause.code === 'ECONNREFUSED')); socket.setTimeout(2000, () => finish(false));
  });
}
async function run() {
  checkpoint('initialize owned runtime');
  assert.equal(app.getPath('userData'), profile); assert.equal(safeStorage.isEncryptionAvailable(), true);
  const dataDir = path.join(profile, 'data'), transport = createRemoteTransportFixture({ hostname: FIXTURE_HOSTNAME, config: {} });
  manager = new RemoteAccessManager({ dataDir, transport: transport.transport, now: () => fixtureNow, defaultHttpsPort: 8443 });
  const email = await new AgentEmailStore({ dataDir, runner: async () => { throw Error('No mailbox is available in this fixture.'); } }).init();
  const lifecycle = { status: () => ({ available: true, mode: 'headless', windowVisible: false, localManagement: true, sameProfile: true }) };
  harness = await createHarnessServer({ port: 0, dataDir, defaultCwd: path.join(profile, 'workspace'), runtime: new Runtime(), desktop: new Desktop(), email, emailExecutableHint: '', remoteAccess: manager, installPath: path.dirname(process.execPath), desktopLifecycle: lifecycle, autoAttachDesktop: false });
  harness.server.prependListener('request', request => { if (request.method === 'POST') hostActions.push(new URL(request.url, 'http://127.0.0.1').pathname); });
  await harness.learning.updateSettings({ mode: 'manual' });
  localUrl = await harness.listen();
  const version = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  const marker = { pid: process.pid, executable: process.execPath, url: localUrl, version, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), profileMode: 'custom', capabilities: { electron: true, encryptedSecretsAvailable: true }, lifecycle: lifecycle.status() };
  await fs.writeFile(markerFile, JSON.stringify(marker));
  const initialMarker = await fs.readFile(markerFile, 'utf8');
  const page = await fetch(localUrl + '/'); await page.arrayBuffer();
  localCookie = secret((page.headers.getSetCookie?.() || [page.headers.get('set-cookie')]).map(value => value.split(';')[0]).find(value => /^relay_session_\d+=[a-f0-9]{64}$/.test(value)));
  assert.ok(localCookie);
  check(0, BrowserWindow.getAllWindows().length === 0 && manager.status().enabled === false && (await local('/api/runs')).length === 0);
  const help = await command('native help', 'native', ['remote', '--help'], { json: false });
  check(1, help.includes('--code-stdin') && await fs.readFile(markerFile, 'utf8') === initialMarker && BrowserWindow.getAllWindows().length === 0 && hostActions.length === 0);
  await manager.enable(); gatewayPort = manager.gateway.port; assert.equal(manager.status().url, FIXTURE_ORIGIN);
  const tls = createFixtureCertificate(); secret(tls.key);
  tlsServer = https.createServer({ cert: tls.certificate, key: tls.key }, (request, response) => {
    report.transport.requests++;
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || request.headers.host !== new URL(FIXTURE_ORIGIN).host) { report.transport.unexpected++; response.writeHead(403); response.end(); return; }
    const forwarded = http.request({ host: '127.0.0.1', port: gatewayPort, method: request.method, path: request.url, headers: request.headers, agent: false }, upstream => {
      response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response);
    });
    forwarded.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('aborted', () => forwarded.destroy()); request.pipe(forwarded);
  });
  tlsServer.on('connection', socket => { tlsSockets.add(socket); socket.once('close', () => tlsSockets.delete(socket)); });
  await new Promise((resolve, reject) => { tlsServer.once('error', reject); tlsServer.listen(0, '127.0.0.1', resolve); });
  tlsPort = tlsServer.address().port;
  const tlsContext = { nonce, pid: process.pid, origin: FIXTURE_ORIGIN, port: tlsPort, certificate: tls.certificate };
  await fs.writeFile(tlsContextFile, JSON.stringify(tlsContext));
  remoteFetch = createFixtureFetch(tlsContext);
  const browserGrant = await issue('browser');
  check(2, browserGrant.ok && browserGrant.kind === 'browser' && JSON.stringify(browserGrant.scopes) === JSON.stringify(REMOTE_SCOPES) && browserGrant.pairUrl === FIXTURE_ORIGIN + '/#code=' + encodeURIComponent(browserGrant.code) && Date.parse(browserGrant.expiresAt) === fixtureNow + 300000 && Date.parse(browserGrant.sessionExpiresAt) === fixtureNow + 30 * 86400000);
  const wrongKind = await pair(browserGrant, { expectedExitCode: 1 });
  const browserPair = await remote('/remote/pair', { method: 'POST', body: { code: browserGrant.code, label: 'Owned browser fixture' } });
  const browserCookie = secret(browserPair.headers.get('set-cookie') || '');
  check(3, wrongKind.error?.code === 'REMOTE_PAIRING_INVALID' && browserPair.status === 200 && browserPair.value.device.kind === 'browser' && browserCookie.includes('Secure') && browserCookie.includes('HttpOnly'));
  const agentGrant = await issue('agent', ['read', 'tasks:write']);
  check(4, agentGrant.ok && JSON.stringify(agentGrant.scopes) === JSON.stringify(['read', 'tasks:write']) && agentGrant.redeemUrl === FIXTURE_ORIGIN + '/remote/agent/pair');
  const agent = await pair(agentGrant);
  report.transport.tlsValidated = true;
  check(5, agent.ok && agent.kind === 'agent' && agent.device.expiresAt === agentGrant.sessionExpiresAt && JSON.stringify(agent.device.scopes) === JSON.stringify(agentGrant.scopes) && report.commands.at(-1).mode === 'tls-helper');
  const authenticated = await remote('/api/agent/status', { token: agent.token }), catalog = await remote('/api/agent', { token: agent.token });
  const hostDenied = await remote('/api/remote-access/create-agent', { token: agent.token, method: 'POST', body: {} });
  check(6, authenticated.status === 200 && authenticated.value.client.id === agent.device.id && JSON.stringify(authenticated.value.client.scopes) === JSON.stringify(['read', 'tasks:write']) && catalog.value.tools.some(tool => tool.name === 'blackice_start_task') && !catalog.value.tools.some(tool => tool.name === 'blackice_edit_plan') && hostDenied.status === 403);
  const replay = await pair(agentGrant, { expectedExitCode: 1 }), readGrant = await issue('agent', ['read'], 'helper');
  const widening = await remote('/remote/agent/pair', { method: 'POST', body: { code: readGrant.code, label: 'No widening', scopes: REMOTE_SCOPES } });
  check(7, replay.error?.code === 'REMOTE_PAIRING_INVALID' && widening.status === 400 && manager.sessions.status().pairing.active === true);
  const reader = await pair(readGrant), taskDenied = await remote('/api/agent/tasks', { token: reader.token, method: 'POST', body: {} });
  const planDenied = await remote('/api/agent/tasks/fixture/plan', { token: reader.token, method: 'POST', body: { expectedRevision: 0, operations: [] } });
  check(8, JSON.stringify(reader.device.scopes) === JSON.stringify(['read']) && taskDenied.status === 403 && taskDenied.value.requiredScope === 'tasks:write' && planDenied.status === 403 && planDenied.value.requiredScope === 'planning:write' && report.providerTurnsRequested === 0);
  const fileGrant = await issue(), saved = await pair(fileGrant, { output: 'first.json' });
  assert.equal(saved.credentialSaved, true); assert.equal(saved.token, undefined);
  assert.equal(saved.connectionFile, path.join(environment.APPDATA, 'BLACKICE', 'connections', 'first.json'));
  const firstBytes = await fs.readFile(saved.connectionFile, 'utf8'), firstCredential = JSON.parse(firstBytes); secret(firstCredential.token);
  const duplicateGrant = await issue(), beforeDuplicate = report.transport.requests;
  const duplicate = await pair(duplicateGrant, { output: 'first.json', expectedExitCode: 1 });
  assert.equal(report.transport.requests, beforeDuplicate, 'An existing filename is rejected before redemption.');
  const secondFile = await pair(duplicateGrant, { output: 'second.json' });
  const secondCredential = JSON.parse(await fs.readFile(secondFile.connectionFile, 'utf8')); secret(secondCredential.token);
  const firstAuthenticated = await remote('/api/agent/status', { token: firstCredential.token }), secondAuthenticated = await remote('/api/agent/status', { token: secondCredential.token });
  check(9, duplicate.error?.code === 'ACCESS_OUTPUT_EXISTS' && await fs.readFile(saved.connectionFile, 'utf8') === firstBytes && firstAuthenticated.status === 200 && secondAuthenticated.status === 200 && saved.device.id !== secondFile.device.id && secondFile.token === undefined);
  await local('/api/remote-access/revoke', 'POST', { id: reader.device.id });
  const revoked = await remote('/api/agent/status', { token: reader.token });
  const expires = await issue(); fixtureNow += 300001;
  const codeExpired = await pair(expires, { expectedExitCode: 1 });
  fixtureNow = Date.parse(agent.device.expiresAt) + 1;
  const credentialExpired = await remote('/api/agent/status', { token: agent.token });
  check(10, revoked.status === 401 && codeExpired.error?.code === 'REMOTE_PAIRING_INVALID' && credentialExpired.status === 401);
  await manager.disable();
  const actionCount = hostActions.length, disabled = await command('disabled host code request', 'native', ['remote', 'code', '--kind', 'agent', '--profile-dir', profile, '--json'], { expectedExitCode: 1 });
  check(11, disabled.error?.code === 'REMOTE_NOT_ENABLED' && manager.status().enabled === false && hostActions.length === actionCount && BrowserWindow.getAllWindows().length === 0 && await fs.readFile(markerFile, 'utf8') === initialMarker);
  report.runtime.browserWindows = BrowserWindow.getAllWindows().length;
  report.transport.commands = transport.calls.map(commandArgs => [...commandArgs]);
  report.hostRequests = { code: hostActions.filter(value => value === '/api/remote-access/pair').length, enable: hostActions.filter(value => value === '/api/remote-access/enable').length, task: hostActions.filter(value => value === '/api/agent/tasks').length };
  const storedDevices = await fs.readFile(path.join(dataDir, 'remote-access-devices.json'), 'utf8');
  check(12, report.providerTurnsRequested === 0 && report.transport.unexpected === 0 && report.hostRequests.enable === 0 && (await local('/api/runs')).length === 0 && [...secrets].every(value => !storedDevices.includes(value)) && !safeText().includes(firstCredential.token));
}
function finish() {
  report.completedAt = new Date().toISOString();
  try { writeFileSync(receiptFile, safeText()); finished = true; } catch {}
  app.releaseSingleInstanceLock();
  if (finished && report.errors.length === 0 && report.cleanup && !report.forcedCleanup) app.quit(); else app.exit(1);
}
async function runAndCleanup() {
  try { await run(); }
  catch { report.errors.push('Native access acceptance failed at: ' + (report.stage || 'startup')); }
  finally {
    report.cleanupEvidence = { tlsClosed: !tlsServer, socketsRemaining: tlsSockets.size, runtimeClosed: !harness, childrenExited: children.every(child => child.entry.exited) };
    try {
      if (tlsServer) {
        if (tlsServer.listening) {
          const closed = new Promise((resolve, reject) => tlsServer.close(error => error ? reject(error) : resolve()));
          tlsServer.closeIdleConnections?.();
          await bounded('closing owned TLS fixture', closed);
        }
        // close() can complete before individual socket close events are emitted.
        // Await those events; a successful acceptance never destroys its peers.
        await bounded('waiting for owned TLS close events', Promise.all([...tlsSockets].map(socket => new Promise(resolve => socket.once('close', resolve)))));
        assert.equal(tlsSockets.size, 0); report.cleanupEvidence.tlsClosed = !tlsServer.listening;
      }
      harness?.server.closeIdleConnections?.();
      await bounded('closing owned runtime', harness?.close() || Promise.resolve(), 15000);
      report.cleanupEvidence.runtimeClosed = true;
      await fs.rm(markerFile, { force: true });
      const closed = await Promise.all([listenerClosed(tlsPort), listenerClosed(gatewayPort), listenerClosed(localUrl ? Number(new URL(localUrl).port) : 0)]);
      report.cleanupEvidence.socketsRemaining = tlsSockets.size;
      report.cleanupEvidence.childrenExited = children.every(child => child.entry.exited);
      report.cleanup = report.cleanupEvidence.childrenExited && closed.every(Boolean) && tlsSockets.size === 0 && BrowserWindow.getAllWindows().length === 0;
      assert.equal(report.cleanup, true);
      if (!report.errors.length) check(13, !report.forcedCleanup);
    } catch {
      report.cleanup = false; report.forcedCleanup = true;
      for (const socket of tlsSockets) socket.destroy();
      try { tlsServer?.closeAllConnections?.(); tlsServer?.close(); } catch {}
      try { harness?.server.closeAllConnections?.(); void harness?.close()?.catch(() => {}); } catch {}
      for (const owned of children.filter(child => !child.entry.exited)) {
        const killer = spawn('taskkill.exe', ['/PID', String(owned.child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        await Promise.race([new Promise(resolve => { killer.once('close', resolve); killer.once('error', resolve); }), sleep(2000)]);
        await Promise.race([owned.done, sleep(1000)]);
      }
      report.errors.push('Owned native access fixture cleanup failed.');
    }
    finish();
  }
}
checkpoint('waiting for Electron ready');
const readyDeadline = setTimeout(() => {
  report.forcedCleanup = true; report.errors.push('Owned native access fixture did not become ready within 15 seconds.'); finish();
}, Math.max(1, Math.min(15000, deadline - Date.now())));
// Electron emits ready only after its entry module finishes evaluation.
// Do not await this promise at module scope.
void app.whenReady().then(() => { clearTimeout(readyDeadline); return runAndCleanup(); }).catch(() => {
  clearTimeout(readyDeadline); report.forcedCleanup = true; report.errors.push('Owned native access fixture could not start or finish.'); finish();
});
