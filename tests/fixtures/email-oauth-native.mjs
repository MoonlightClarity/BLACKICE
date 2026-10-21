/** Native acceptance only. Provider transport is replaced by an owned loopback fixture. */
import assert from 'node:assert/strict';
import { app, BrowserWindow, safeStorage } from 'electron';
import { promises as fs, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EmailOAuthManager } from '../../lib/email-oauth.mjs';
import { AgentEmailStore, runEmailCli } from '../../lib/agent-email.mjs';
import { EMAIL_OAUTH_NATIVE_QA_CHECKS } from '../../scripts/email-oauth-native-qa.mjs';

const args = process.argv.slice(2), values = {};
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--profile-dir', '--out', '--receipt', '--nonce', '--himalaya'].includes(args[index]) && args[index + 1]);
  assert.equal(values[args[index]], undefined); values[args[index]] = args[index + 1];
}
const profile = values['--profile-dir'], out = values['--out'], receipt = values['--receipt'], nonce = values['--nonce'], executable = values['--himalaya'];
assert.equal(process.platform, 'win32'); assert.ok([profile, out, receipt, executable].every(value => path.isAbsolute(value)));
assert.match(nonce, /^[a-f0-9-]{36}$/); assert.equal(profile, path.join(out, 'owned-profile-' + nonce)); assert.equal(receipt, path.join(out, 'native-email-result-' + nonce + '.json'));
app.setPath('userData', profile); assert.equal(app.requestSingleInstanceLock(), true);
app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
const report = {
  schema: 1, nonce, pid: process.pid, profile, platform: process.platform, electronVersion: process.versions.electron,
  checks: [], errors: [], providerTurnsRequested: 0, providerMailboxConnected: false, providerNetworkTested: false,
  realAccountLogin: false, messageDeliveryAttempted: false, cleanup: false, forcedCleanup: false,
  cli: { executable, version: null, commands: [] },
  runtime: { executable: process.execPath, helper: fileURLToPath(new URL('../../scripts/email-oauth-token.mjs', import.meta.url)), helperCommands: [], browserWindows: 0 },
  fixtureRequests: { token: 0, profile: 0, unexpected: 0, authorizationCode: 0, refreshToken: 0 },
  limitations: ['Gmail and Graph network backends are not contacted.', 'Encrypted storage is reopened inside one native Electron process; a full desktop process restart is outside this check.'],
};
const progressFile = path.join(out, 'native-email-progress-' + nonce + '.json');
const opened = [], managers = [], sockets = new Set(), peers = new Set();
const CLIENT = '123456-owned-blackice-native-fixture.apps.googleusercontent.com', SECRET = 'blackice-native-fixture-client-secret';
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
let server, origin, store, latestAccessToken, flowURL, callbackPort;
function checkpoint(stage) {
  report.stage = stage; report.updatedAt = new Date().toISOString();
  writeFileSync(progressFile, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ stage, checks: report.checks.length, cliCommands: report.cli.commands.length }) + '\n');
}
const check = (index, value) => { assert.equal(report.checks.length, index); assert.ok(value, EMAIL_OAUTH_NATIVE_QA_CHECKS[index]); report.checks.push({ name: EMAIL_OAUTH_NATIVE_QA_CHECKS[index], passed: true }); checkpoint('passed: ' + EMAIL_OAUTH_NATIVE_QA_CHECKS[index]); };
async function bounded(label, operation, milliseconds = 25000) {
  checkpoint(label); let timer;
  try { return await Promise.race([operation, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Native email acceptance timed out during ' + label + '.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function callbackListenerClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
    socket.setTimeout(2000, () => { socket.removeAllListeners(); socket.destroy(); reject(new Error('Owned callback listener verification timed out.')); });
  });
}
const ownedEnvironment = {
  XDG_CONFIG_HOME: path.join(profile, 'xdg-config'), XDG_CACHE_HOME: path.join(profile, 'xdg-cache'),
  XDG_DATA_HOME: path.join(profile, 'xdg-data'), XDG_STATE_HOME: path.join(profile, 'xdg-state'),
  APPDATA: path.join(profile, 'roaming'), LOCALAPPDATA: path.join(profile, 'local'),
  ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, BLACKICE_EMAIL_ACCESS_TOKEN: undefined,
};
const configPaths = new Set();
async function actualCli(input) {
  assert.equal(path.resolve(input.executable), executable);
  const inspection = input.args.includes('--help') || input.args.length === 1 && input.args[0] === '--version';
  if (!inspection) {
    const relative = input.args.find(arg => arg.startsWith('--config=./'));
    assert.ok(relative && input.cwd);
    assert.equal(configPaths.has(path.resolve(input.cwd, relative.slice('--config='.length))), true, 'Only owned configuration files reach the native CLI.');
    const configurationOnly = input.args.includes('account') && input.args.includes('list');
    const localRead = input.args.includes('--account=fixture') && (input.args.includes('envelope') || input.args.includes('message') && input.args.includes('read'));
    assert.ok(configurationOnly || localRead);
    assert.equal(input.args.some(arg => ['send', 'add', 'compose', 'configure', 'smtp', 'imap', 'jmap', 'msgraph', 'gmail', '--seen'].includes(arg)), false);
  }
  const result = await runEmailCli({ ...input, timeoutMs: Math.min(input.timeoutMs || 15000, 15000), maxOutputBytes: 2097152,
    environment: { ...ownedEnvironment, ...input.environment } });
  report.cli.commands.push({ args: [...input.args], ...(input.cwd ? { cwd: input.cwd } : {}), exitCode: result.exitCode, outputBytes: Buffer.byteLength(result.stdout), providerRequest: false });
  return result;
}
function includesAccount(value, account) {
  if (Array.isArray(value)) return value.some(item => includesAccount(item, account));
  if (value && typeof value === 'object') return Object.hasOwn(value, account) || Object.values(value).some(item => includesAccount(item, account));
  return value === account;
}
async function parseManagedConfig(manager) {
  const config = await manager.ensureManagedConfig(); configPaths.add(config.configPath);
  const output = await actualCli({ executable, args: [`--config=./${path.basename(config.configPath)}`, '--json', 'account', 'list'], cwd: path.dirname(config.configPath) });
  assert.ok(includesAccount(JSON.parse(output.stdout), 'blackice'));
  assert.equal(report.fixtureRequests.token, 0); assert.equal(report.fixtureRequests.profile, 0);
  assert.equal(process.env.BLACKICE_EMAIL_ACCESS_TOKEN, undefined);
}
async function allMessageFiles(roots) {
  const result = {};
  for (let index = 0; index < roots.length; index++) for (const folder of ['cur', 'new', 'tmp']) {
    const directory = path.join(roots[index], folder);
    for (const name of (await fs.readdir(directory)).sort()) {
      const filename = path.join(directory, name);
      result[`${index}/${folder}/${name}`] = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    }
  }
  return result;
}
async function assertNoPlaintext(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await assertNoPlaintext(filename);
    else if (entry.isFile()) {
      const value = await fs.readFile(filename);
      assert.equal(value.includes(Buffer.from(SECRET)), false);
      assert.equal(value.includes(Buffer.from('blackice-native-fixture-access-')), false);
      assert.equal(value.includes(Buffer.from('blackice-native-fixture-refresh-')), false);
    }
  }
}
async function runNativeEmailAcceptance() {
  try {
    checkpoint('native Electron ready');
    const stat = await fs.lstat(profile); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    assert.equal(safeStorage.isEncryptionAvailable(), true); assert.equal(BrowserWindow.getAllWindows().length, 0);
    report.storage = { available: true, mechanism: 'Electron safeStorage on Windows', plaintextFallback: false };
    check(0, true);
    const version = await actualCli({ executable, args: ['--version'] });
    report.cli.version = /\bhimalaya\s+v?(\d+\.\d+\.\d+)(?:[\s+\-]|$)/i.exec(version.stdout)?.[1];
    assert.equal(report.cli.version, '2.2.1');
    for (const backend of ['gmail', 'msgraph']) assert.match((await actualCli({ executable, args: [backend, '--help'] })).stdout, /profile/i);
    const listHelp = (await actualCli({ executable, args: ['envelope', 'list', '--help'] })).stdout;
    const searchHelp = (await actualCli({ executable, args: ['envelope', 'search', '--help'] })).stdout;
    const readHelp = (await actualCli({ executable, args: ['message', 'read', '--help'] })).stdout;
    for (const option of ['--json', '--page-size', '--page', '--mailbox', '--account']) { assert.ok(listHelp.includes(option)); assert.ok(searchHelp.includes(option)); }
    for (const option of ['--json', '--raw', '--seen', '--mailbox', '--account']) assert.ok(readHelp.includes(option));
    assert.match(readHelp, /leaving\s+its\s+flags\s+alone\s+otherwise/i); check(1, true);

    server = http.createServer(async (req, res) => {
      peers.add(req.socket.remoteAddress); res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
      try {
        if (req.url === '/token' && req.method === 'POST') {
          let body = ''; for await (const chunk of req) { body += chunk; assert.ok(body.length < 16000); }
          const fields = new URLSearchParams(body); assert.equal(fields.get('client_id'), CLIENT); assert.equal(fields.get('client_secret'), SECRET);
          const grant = fields.get('grant_type');
          if (grant === 'authorization_code') {
            assert.equal(fields.get('code'), 'blackice-owned-fixture-code'); assert.equal(fields.get('redirect_uri'), flowURL.searchParams.get('redirect_uri'));
            assert.equal(createHash('sha256').update(fields.get('code_verifier')).digest('base64url'), flowURL.searchParams.get('code_challenge'));
            report.fixtureRequests.authorizationCode++;
          } else {
            assert.equal(grant, 'refresh_token'); assert.equal(fields.get('refresh_token'), 'blackice-native-fixture-refresh-' + report.fixtureRequests.token); report.fixtureRequests.refreshToken++;
          }
          report.fixtureRequests.token++; latestAccessToken = 'blackice-native-fixture-access-' + report.fixtureRequests.token;
          res.writeHead(200); return res.end(JSON.stringify({ access_token: latestAccessToken, refresh_token: 'blackice-native-fixture-refresh-' + report.fixtureRequests.token, token_type: 'Bearer', expires_in: 3600, scope: READ_SCOPE }));
        }
        if (req.url === '/profile' && req.method === 'GET') {
          assert.equal(req.headers.authorization, 'Bearer ' + latestAccessToken); report.fixtureRequests.profile++;
          res.writeHead(200); return res.end(JSON.stringify({ emailAddress: 'owned-native-fixture@example.invalid' }));
        }
        report.fixtureRequests.unexpected++; res.writeHead(400); res.end('{}');
      } catch { report.fixtureRequests.unexpected++; if (!res.headersSent) res.writeHead(400); res.end('{}'); }
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await bounded('starting owned token fixture', new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), 5000);
    origin = 'http://127.0.0.1:' + server.address().port;
    const options = {
      dataDir: path.join(profile, 'email'), tokenRuntimeExecutable: process.execPath,
      encryptSecret: value => safeStorage.encryptString(value).toString('base64'),
      decryptSecret: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
      openExternal: async url => { opened.push(new URL(url)); },
      fetchImpl: (url, init) => {
        if (url === 'https://oauth2.googleapis.com/token') return fetch(origin + '/token', init);
        if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return fetch(origin + '/profile', init);
        report.fixtureRequests.unexpected++; throw new Error('Native email acceptance blocked a non-fixture endpoint.');
      },
    };
    let manager = await new EmailOAuthManager(options).init(); managers.push(manager);
    await manager.configure({ provider: 'gmail', clientId: CLIENT, clientSecret: SECRET });
    await parseManagedConfig(manager); check(2, true);
    await manager.configure({ provider: 'microsoft', clientId: '12345678-1234-1234-1234-123456789abc' });
    await parseManagedConfig(manager); check(3, true);
    await manager.configure({ provider: 'gmail', clientId: CLIENT, clientSecret: SECRET }); await manager.begin();
    flowURL = opened.at(-1); assert.equal(flowURL.origin, 'https://accounts.google.com'); assert.equal(flowURL.searchParams.get('scope'), READ_SCOPE); assert.equal(flowURL.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(flowURL.searchParams.get('redirect_uri')); callbackPort = Number(callback.port); callback.searchParams.set('state', flowURL.searchParams.get('state')); callback.searchParams.set('code', 'blackice-owned-fixture-code');
    const completion = await bounded('completing owned loopback authorization', fetch(callback)); await completion.text(); assert.equal(completion.status, 200);
    assert.equal(manager.status().connected, true); assert.equal(manager.status().identity.email, 'owned-native-fixture@example.invalid');
    assert.equal(report.fixtureRequests.authorizationCode, 1); assert.equal(report.fixtureRequests.profile, 1); check(4, true);

    const context = await manager.commandContext(); const helperArgs = [report.runtime.helper];
    const helperResult = await runEmailCli({ executable: process.execPath, args: helperArgs, cwd: profile, timeoutMs: 15000, maxOutputBytes: 65536, environment: { ...ownedEnvironment, ...context.environment } });
    assert.equal(helperResult.stdout, latestAccessToken); assert.equal(helperResult.exitCode, 0);
    report.runtime.helperCommands.push({ executable: process.execPath, args: helperArgs, exitCode: 0, tokenMatched: true, childOnlyEnvironment: true, shell: false, windowsHide: true });
    await assert.rejects(runEmailCli({ executable: process.execPath, args: helperArgs, cwd: profile, timeoutMs: 15000, maxOutputBytes: 65536,
      environment: { ...ownedEnvironment, ELECTRON_RUN_AS_NODE: '1' } }), { code: 'EMAIL_CLIENT_FAILED' });
    report.runtime.helperCommands.push({ executable: process.execPath, args: helperArgs, failedClosed: true, tokenPresent: false, shell: false, windowsHide: true });
    assert.equal(process.env.BLACKICE_EMAIL_ACCESS_TOKEN, undefined); assert.equal(BrowserWindow.getAllWindows().length, 0); check(5, true);

    await manager.close(); manager = await new EmailOAuthManager(options).init(); managers.push(manager);
    assert.equal(manager.status().connected, true); assert.equal(manager.status().identity.email, 'owned-native-fixture@example.invalid');
    const refreshed = await Promise.all(Array.from({ length: 8 }, () => manager.getAccessToken()));
    assert.ok(refreshed.every(token => token === latestAccessToken)); assert.equal(report.fixtureRequests.refreshToken, 1); assert.equal(opened.length, 1);
    assert.equal(report.fixtureRequests.token, 2); await assertNoPlaintext(path.join(profile, 'email')); check(6, true);

    const localRoot = path.join(profile, 'local-mail'), maildir = path.join(localRoot, 'maildir'), configPath = path.join(localRoot, 'fixture.toml');
    const mailboxRoots = [maildir, path.join(maildir, 'INBOX'), path.join(maildir, '.INBOX')];
    const messageName = '1720000000.M123456P1.blackice';
    const message = ['From: fixture@example.invalid', 'To: reader@example.invalid', 'Subject: Blackice offline fixture', 'Date: Tue, 01 Oct 2024 12:00:00 +0000', 'Message-ID: <blackice-native-local-fixture@example.invalid>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', '', 'This is a disposable local email fixture. No provider was contacted.', ''].join('\r\n');
    for (const root of mailboxRoots) {
      for (const child of ['cur', 'new', 'tmp']) await fs.mkdir(path.join(root, child), { recursive: true });
      await fs.writeFile(path.join(root, 'new', messageName), message, { mode: 0o600 });
    }
    const config = `[accounts.fixture]\ndefault = true\nemail = "fixture@example.invalid"\nmaildir.root = ${JSON.stringify(maildir)}\nmailbox.alias.inbox = "INBOX"\n`;
    await fs.writeFile(configPath, config, { mode: 0o600 }); configPaths.add(configPath);
    store = await new AgentEmailStore({ dataDir: localRoot, runner: actualCli }).init();
    await store.configure({ connection: 'external', enabled: true, executable, configPath, account: 'fixture', timeoutMs: 15000 }); await store.check();
    assert.equal(store.status().account.observed, false);
    const listed = await store.list({ folder: 'INBOX', limit: 20 });
    const envelope = listed.messages.find(item => item.subject === 'Blackice offline fixture'); assert.ok(envelope, 'The owned local message must be listed.'); check(7, true);
    const filesBeforeRead = await allMessageFiles(mailboxRoots);
    const searched = await store.list({ folder: 'INBOX', query: 'subject Blackice', limit: 20 }); assert.ok(searched.messages.some(item => String(item.id) === String(envelope.id)));
    const read = await store.read({ folder: 'INBOX', id: envelope.id }); assert.equal(read.preview, true); assert.match(read.message, /This is a disposable local email fixture/);
    const after = await store.list({ folder: 'INBOX', limit: 20 }); assert.deepEqual(after.messages.find(item => String(item.id) === String(envelope.id))?.flags, envelope.flags);
    assert.deepEqual(await allMessageFiles(mailboxRoots), filesBeforeRead);
    assert.equal(await fs.readFile(configPath, 'utf8'), config); check(8, true);
    const commandCount = report.cli.commands.length;
    const draft = await store.draft({ requestId: 'native-owned-draft', to: ['recipient@example.invalid'], subject: 'Owned local draft', body: 'No delivery is requested.' });
    assert.equal(draft.sent, false); assert.match(await fs.readFile(draft.path, 'utf8'), /X-Unsent: 1/); assert.equal(report.cli.commands.length, commandCount); check(9, true);

    assert.equal(report.fixtureRequests.unexpected, 0); assert.ok([...peers].every(peer => ['127.0.0.1', '::ffff:127.0.0.1'].includes(peer)));
    await assertNoPlaintext(path.join(profile, 'email'));
    for (const value of [JSON.stringify(manager.status()), JSON.stringify(store.snapshot()), JSON.stringify(report)]) assert.doesNotMatch(value, /blackice-native-fixture-(?:access|refresh|client-secret)/);
    assert.equal(BrowserWindow.getAllWindows().length, 0); report.runtime.browserWindows = 0; report.fixtureRequests.browserOpenCalls = opened.length; check(10, true);
  } catch (error) {
    // Never serialize raw provider diagnostics, tokens, callback URLs or command output.
    report.errors.push({ code: error.code || 'EMAIL_NATIVE_ACCEPTANCE_FAILED', message: 'Native email acceptance failed during ' + (report.stage || 'initialization') + '.' });
    checkpoint('failed');
  } finally {
    report.cleanupEvidence = { stage: 'stores', storesClosed: false, callbackListenerClosed: callbackPort ? false : null, fixtureServerClosed: !server, socketsRemaining: sockets.size, windowsRemaining: BrowserWindow.getAllWindows().length };
    try {
      await bounded('closing owned email stores', Promise.all([store?.close(), ...managers.map(manager => manager.close())]), 20000);
      report.cleanupEvidence.managers = managers.map(manager => ({ activeRequests: manager.requests.size, callbackOperations: manager.callbackOperations.size, pending: manager.status().authorization.pending }));
      assert.ok(managers.every(manager => manager.requests.size === 0 && manager.callbackOperations.size === 0 && !manager.status().authorization.pending));
      report.cleanupEvidence.storesClosed = true; report.cleanupEvidence.stage = 'callback';
      if (callbackPort) { report.cleanupEvidence.callbackListenerClosed = await callbackListenerClosed(callbackPort); assert.equal(report.cleanupEvidence.callbackListenerClosed, true); }
      report.cleanupEvidence.stage = 'fixture-server';
      if (server) {
        server.closeIdleConnections?.();
        await bounded('closing owned token fixture', new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000);
        report.cleanupEvidence.fixtureServerClosed = !server.listening;
        // Server close completion can precede the individual socket close
        // events. Wait for those owned events; never force them on a pass path.
        report.cleanupEvidence.stage = 'socket-close-events';
        await bounded('waiting for owned socket close events', Promise.all([...sockets].map(socket => new Promise(resolve => socket.once('close', resolve)))), 5000);
      }
      report.cleanupEvidence.socketsRemaining = sockets.size; report.cleanupEvidence.windowsRemaining = BrowserWindow.getAllWindows().length;
      assert.equal(sockets.size, 0); assert.equal(BrowserWindow.getAllWindows().length, 0); report.cleanup = true; report.cleanupEvidence.stage = 'complete';
      if (!report.errors.length) check(11, true);
    } catch (error) {
      report.cleanupEvidence.socketsRemaining = sockets.size; report.cleanupEvidence.windowsRemaining = BrowserWindow.getAllWindows().length;
      report.cleanupEvidence.errorCode = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'OWNED_CLEANUP_ERROR';
      report.cleanup = false; report.forcedCleanup = true; for (const socket of sockets) socket.destroy(); try { server?.close(); } catch {}
      report.errors.push({ code: 'EMAIL_NATIVE_CLEANUP_FAILED', message: 'Owned native email resources did not stop normally.' });
    }
    report.completedAt = new Date().toISOString(); report.passed = report.errors.length === 0 && report.checks.length === EMAIL_OAUTH_NATIVE_QA_CHECKS.length && report.cleanup && !report.forcedCleanup;
    await fs.writeFile(receipt, JSON.stringify(report, null, 2) + '\n');
    if (report.passed) app.quit(); else app.exit(1);
  }
}
checkpoint('waiting for Electron ready');
const readyDeadline = setTimeout(() => { report.forcedCleanup = true; report.errors.push({ code: 'EMAIL_NATIVE_START_TIMEOUT', message: 'Owned Electron email fixture did not become ready.' }); writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n'); app.exit(1); }, 15000);
void app.whenReady().then(() => { clearTimeout(readyDeadline); return runNativeEmailAcceptance(); }).catch(() => { clearTimeout(readyDeadline); report.forcedCleanup = true; report.errors.push({ code: 'EMAIL_NATIVE_START_FAILED', message: 'Owned Electron email fixture could not start.' }); writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n'); app.exit(1); });
