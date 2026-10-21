import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { RemoteSessionStore } from '../lib/remote-access-auth.mjs';
import { desktopRemoteAccessArgs, parseRemoteAccessArgs, createAccessCode, runRemoteAccessCLI, redeemAccessCode, readAccessCode, validateRuntimeOwnership } from '../lib/remote-access-cli.mjs';

const localUrl = 'http://127.0.0.1:21345', publicUrl = 'https://blackice.example.test:8443';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function output() { let text = ''; return { stream: new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } }), get text() { return text; } }; }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-access-cli-')), profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  const startedAt = new Date().toISOString(), now = Date.now(), executable = path.join(root, 'BLACKICE');
  const runtime = { pid: 43210, executable, startedAt, version: '2.30.0', url: localUrl, profileMode: 'custom', capabilities: { electron: true } };
  const runtimeFile = path.join(profile, 'desktop-runtime.json'); await fs.writeFile(runtimeFile, JSON.stringify(runtime));
  const sessions = await new RemoteSessionStore({ dataDir: path.join(root, 'server-owned-data'), now: () => now }).init();
  t.after(async () => { await sessions.close(); await fs.rm(root, { recursive: true, force: true }); });
  const calls = [], observed = { pid: runtime.pid, executable, startedAt, listeners: [{ address: '127.0.0.1', pid: runtime.pid }] };
  const status = { app: 'relay-agent-harness', version: runtime.version, desktopApp: true, installPath: path.dirname(executable), remoteAccess: { client: 'local', localManagement: true, enabled: true, state: 'ready', url: publicUrl }, desktopLifecycle: { available: true, localManagement: true, mode: 'headless' } };
  const context = {
    platform: process.platform, defaultProfile: profile, expectedExecutable: executable, now: () => now,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'client-config'), APPDATA: path.join(root, 'client-config') }, home: root,
    inspectRuntime: async () => observed,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === localUrl + '/health') return json({ app: 'relay-agent-harness', ok: true });
      if (url === localUrl + '/') return new Response('<!doctype html><title>BLACKICE</title>', { headers: { 'set-cookie': 'relay_session_21345=' + 'a'.repeat(64) + '; HttpOnly; SameSite=Strict; Path=/' } });
      if (url === localUrl + '/api/status') return json(status);
      if (url === localUrl + '/api/remote-access/pair') {
        const grant = sessions.issuePairing(JSON.parse(options.body));
        return json({ ...grant, ...(grant.kind === 'agent' ? { redeemUrl: publicUrl + '/remote/agent/pair' } : { pairUrl: publicUrl + '/#code=' + encodeURIComponent(grant.code) }), status: status.remoteAccess });
      }
      if (url === publicUrl + '/remote/agent/pair') {
        const value = JSON.parse(options.body);
        try {
          const result = await sessions.pairAgent(value.code, value.label);
          return json({ paired: true, kind: 'agent', ...result, url: publicUrl, endpoints: { mcp: publicUrl + '/mcp', api: publicUrl + '/api/agent' } });
        } catch (cause) { return json({ code: cause.code, error: cause.message }, cause.status || 503); }
      }
      throw Error('Unexpected fixture request');
    },
  };
  return { root, profile, runtime, runtimeFile, sessions, calls, observed, status, context };
}
async function invoke(argv, context, code = '') {
  const stdout = output(), stderr = output();
  const exitCode = await runRemoteAccessCLI(argv, { ...context, stdin: Readable.from([code]), stdout: stdout.stream, stderr: stderr.stream });
  return { exitCode, stdout: stdout.text, stderr: stderr.text, value: stdout.text.startsWith('{') ? JSON.parse(stdout.text) : null };
}

test('native dispatch recognizes explicit access commands without reinterpreting normal startup', () => {
  assert.deepEqual(desktopRemoteAccessArgs(['BLACKICE.exe', '--access-code', '--json']), ['--access-code', '--json']);
  assert.deepEqual(desktopRemoteAccessArgs(['electron', '.', 'remote', 'code'], { packaged: false }), ['remote', 'code']);
  assert.deepEqual(desktopRemoteAccessArgs(['BLACKICE.exe', '--profile-dir=C:\\Temp\\profile', '--access-code']), ['--profile-dir=C:\\Temp\\profile', '--access-code']);
  assert.equal(desktopRemoteAccessArgs(['BLACKICE.exe', '--headless']), null);
  assert.equal(desktopRemoteAccessArgs(['BLACKICE.exe', '--quit']), null);
  assert.equal(parseRemoteAccessArgs(['--access-code']).kind, 'browser');
  assert.deepEqual(parseRemoteAccessArgs(['remote', 'code', '--kind', 'agent']).scopes, ['read']);
  assert.deepEqual(parseRemoteAccessArgs(['remote', 'code', '--kind=agent', '--scope', 'tasks:write', '--scope', 'read']).scopes, ['read', 'tasks:write']);
  assert.deepEqual(parseRemoteAccessArgs(['remote', 'code', '--kind=agent', '--scope=read', '--scope=tasks:write']).scopes, ['read', 'tasks:write']);
  assert.equal(parseRemoteAccessArgs(['remote', 'pair', '--url=' + publicUrl, '--code-stdin', '--name=App: builder']).name, 'App: builder');
});

test('command arguments cannot carry a code, broaden permissions at redemption, or choose an arbitrary credential file', () => {
  for (const args of [
    ['code', '--scope', 'read'], ['code', '--kind', 'agent', '--scope', '*'], ['code', '--kind', 'agent', '--scope', 'read', '--scope', 'read'],
    ['--access-code=true'], ['code', '--json=true'], ['code', '--profile-dir', 'relative'], ['code', '--profile-dir', '/', '--json'],
    ['pair', '--url', publicUrl, '--code', 'secret'], ['pair', '--url', publicUrl, '--code-stdin', '--scope', 'tasks:write'],
    ['pair', '--url', 'http://example.test', '--code-stdin'], ['pair', '--url', publicUrl + '/remote/agent/pair', '--code-stdin'],
    ['pair', '--url', publicUrl, '--code-stdin', '--output', '../project/credential.json'], ['pair', '--url', publicUrl, '--code-stdin', '--output', '/tmp/credential.json'],
  ]) assert.throws(() => parseRemoteAccessArgs(args));
  assert.equal(parseRemoteAccessArgs(['remote', '--help']).command, 'help');
});

test('host issuance and stdin redemption complete one authenticated scoped handoff with no exposure request', async t => {
  const f = await fixture(t), before = await fs.readFile(f.runtimeFile, 'utf8');
  const issued = await invoke(['remote', 'code', '--kind', 'agent', '--scope=read', '--scope=tasks:write', '--json'], f.context);
  assert.equal(issued.exitCode, 0, issued.stdout + issued.stderr); assert.equal(issued.value.host.mode, 'headless');
  assert.deepEqual(issued.value.scopes, ['read', 'tasks:write']);
  const paired = await invoke(['remote', 'pair', '--url=' + publicUrl, '--code-stdin', '--name=App: builder', '--json'], f.context, issued.value.code + '\n');
  assert.equal(paired.exitCode, 0, paired.stdout + paired.stderr);
  assert.deepEqual(f.sessions.authenticate(paired.value.token, 'agent').scopes, ['read', 'tasks:write']);
  assert.equal(paired.value.device.label, 'App: builder');
  assert.equal(paired.value.device.expiresAt, issued.value.sessionExpiresAt); assert.equal(issued.stderr + paired.stderr, '');
  const posts = f.calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[0].url, localUrl + '/api/remote-access/pair'); assert.equal(posts[1].url, publicUrl + '/remote/agent/pair');
  assert.equal(posts[0].options.headers.Origin, localUrl); assert.equal(posts[0].options.headers.Cookie, 'relay_session_21345=' + 'a'.repeat(64));
  assert.equal(posts[1].options.headers.Origin, publicUrl); assert.equal(posts[1].options.headers.Cookie, undefined); assert.equal(posts[1].options.headers.Authorization, undefined);
  assert.deepEqual(Object.keys(JSON.parse(posts[1].options.body)).sort(), ['code', 'label']);
  assert.equal(posts[1].options.redirect, 'error');
  assert.equal(await fs.readFile(f.runtimeFile, 'utf8'), before);
  const replay = await invoke(['remote', 'pair', '--url', publicUrl, '--code-stdin', '--json'], f.context, issued.value.code);
  assert.equal(replay.exitCode, 1); assert.equal(replay.value.error.code, 'REMOTE_PAIRING_INVALID'); assert.ok(!replay.stdout.includes(issued.value.code)); assert.ok(!replay.stdout.includes(paired.value.token));
});

test('default browser code includes the existing pairing link and works in a visible host', async t => {
  const f = await fixture(t); f.status.desktopLifecycle.mode = 'window';
  const result = await invoke(['--access-code', '--json'], f.context);
  assert.equal(result.exitCode, 0); assert.equal(result.value.kind, 'browser');
  assert.equal(result.value.pairUrl, publicUrl + '/#code=' + encodeURIComponent(result.value.code));
  const paired = await f.sessions.pair(result.value.code, 'Browser');
  assert.equal(paired.device.kind, 'browser');
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('a stale, public, or differently owned listener is rejected before a local request', async t => {
  const f = await fixture(t);
  for (const observed of [
    { ...f.observed, pid: 44444 },
    { ...f.observed, executable: path.join(f.root, 'other-app') },
    { ...f.observed, startedAt: '2000-01-01T00:00:00Z' },
    { ...f.observed, listeners: [{ address: '0.0.0.0', pid: f.runtime.pid }] },
    { ...f.observed, listeners: [{ address: '127.0.0.1', pid: 44444 }] },
    { ...f.observed, listeners: [] },
  ]) {
    const result = await invoke(['--access-code', '--json'], { ...f.context, inspectRuntime: async () => observed });
    assert.equal(result.exitCode, 1); assert.equal(result.value.error.code, 'ACCESS_RUNTIME_OWNERSHIP');
  }
  assert.equal(f.calls.length, 0);
  assert.throws(() => validateRuntimeOwnership(f.runtime, { ...f.observed, startedAt: 'invalid' }));
});

test('remote disabled or a host restart prevents code issuance and never enables exposure', async t => {
  const f = await fixture(t); f.status.remoteAccess.enabled = false;
  const disabled = await invoke(['--access-code', '--json'], f.context);
  assert.equal(disabled.value.error.code, 'REMOTE_NOT_ENABLED'); assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
  f.status.remoteAccess.enabled = true;
  const fetchImpl = f.context.fetchImpl;
  const changed = await invoke(['--access-code', '--json'], { ...f.context, fetchImpl: async (url, options) => {
    const response = await fetchImpl(url, options);
    if (url.endsWith('/api/status')) await fs.writeFile(f.runtimeFile, JSON.stringify({ ...f.runtime, pid: 54321 }));
    return response;
  } });
  assert.equal(changed.value.error.code, 'ACCESS_RUNTIME_CHANGED');
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('missing or redirected profiles are not initialized by the access command', async t => {
  const f = await fixture(t), missing = path.join(f.root, 'missing-profile');
  const result = await invoke(['--access-code', '--profile-dir', missing, '--json'], f.context);
  assert.equal(result.value.error.code, 'ACCESS_HOST_NOT_RUNNING');
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  const link = path.join(f.root, 'profile-link'); await fs.symlink(f.profile, link, process.platform === 'win32' ? 'junction' : 'dir');
  const redirected = await invoke(['--access-code', '--profile-dir', link, '--json'], f.context);
  assert.equal(redirected.value.error.code, 'ACCESS_RUNTIME_INVALID');
  assert.equal(f.calls.length, 0);
});

test('connection output is private and exclusive and never returns the saved bearer in its receipt', async t => {
  const f = await fixture(t), grant = f.sessions.issuePairing({ kind: 'agent' });
  const client = f.context;
  const result = await invoke(['remote', 'pair', '--url', publicUrl, '--code-stdin', '--name', 'Saved agent', '--output', 'saved-agent.json', '--json'], client, grant.code);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.equal(result.value.credentialSaved, true); assert.equal(result.value.token, undefined);
  assert.equal(result.value.connectionFile, process.platform === 'darwin' ? path.join(f.root, 'Library', 'Application Support', 'BLACKICE', 'connections', 'saved-agent.json') : path.join(f.root, 'client-config', process.platform === 'win32' ? 'BLACKICE' : 'blackice', 'connections', 'saved-agent.json'));
  const saved = JSON.parse(await fs.readFile(result.value.connectionFile, 'utf8'));
  assert.equal(saved.schema, 1); assert.equal(saved.product, 'BLACKICE'); assert.ok(f.sessions.authenticate(saved.token, 'agent'));
  assert.ok(!result.stdout.includes(saved.token)); assert.equal(result.stderr, '');
  if (process.platform !== 'win32') assert.equal((await fs.stat(result.value.connectionFile)).mode & 0o777, 0o600);
  const before = await fs.readFile(result.value.connectionFile, 'utf8'), second = f.sessions.issuePairing({ kind: 'agent' }), count = f.calls.length;
  const repeat = await invoke(['remote', 'pair', '--url', publicUrl, '--code-stdin', '--output', 'saved-agent.json', '--json'], client, second.code);
  assert.equal(repeat.value.error.code, 'ACCESS_OUTPUT_EXISTS'); assert.equal(f.calls.length, count); assert.equal(await fs.readFile(result.value.connectionFile, 'utf8'), before);
  assert.equal((await f.sessions.pairAgent(second.code)).device.kind, 'agent');
  const third = f.sessions.issuePairing({ kind: 'agent' });
  const next = await invoke(['remote', 'pair', '--url', publicUrl, '--code-stdin', '--output', 'second-agent.json', '--json'], client, third.code);
  assert.equal(next.exitCode, 0, next.stdout + next.stderr);
  const nextSaved = JSON.parse(await fs.readFile(next.value.connectionFile, 'utf8'));
  assert.ok(f.sessions.authenticate(nextSaved.token, 'agent'));
  assert.equal(await fs.readFile(result.value.connectionFile, 'utf8'), before);
  assert.ok(!next.stdout.includes(nextSaved.token));
});

test('invalid, oversized, or timed-out stdin does not produce an access request', async t => {
  const f = await fixture(t);
  for (const code of ['wrong', 'A'.repeat(129), '1234-5678']) {
    const result = await invoke(['remote', 'pair', '--url', publicUrl, '--code-stdin', '--json'], f.context, code);
    assert.equal(result.value.error.code, 'ACCESS_CODE_STDIN');
    assert.ok(!result.stdout.includes(code));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readAccessCode(new Readable({ read() {} }), { signal: controller.signal }), { code: 'ACCESS_CODE_STDIN' });
  assert.equal(f.calls.length, 0);
});

test('a lost redemption response is never retried and never prints request secrets or transport errors', async t => {
  const f = await fixture(t), grant = f.sessions.issuePairing({ kind: 'agent' }); let requests = 0;
  const result = await invoke(['remote', 'pair', '--url', publicUrl, '--code-stdin', '--json'], { ...f.context, fetchImpl: async () => { requests++; throw Error('untrusted transport text ' + grant.code); } }, grant.code);
  assert.equal(requests, 1); assert.equal(result.value.error.code, 'ACCESS_REQUEST_UNCERTAIN'); assert.equal(result.value.error.uncertain, true);
  assert.ok(!result.stdout.includes(grant.code)); assert.ok(!result.stdout.includes('untrusted transport text'));
  assert.equal(result.stderr, '');
});

test('a remote receipt cannot substitute a browser token, foreign endpoint, or unbounded expiry', async t => {
  const f = await fixture(t), grant = f.sessions.issuePairing({ kind: 'agent' });
  const paired = await f.sessions.pairAgent(grant.code, 'Agent'), good = { paired: true, kind: 'agent', ...paired, url: publicUrl, endpoints: { mcp: publicUrl + '/mcp', api: publicUrl + '/api/agent' } };
  for (const invalid of [
    { ...good, token: 'a'.repeat(43) },
    { ...good, endpoints: { ...good.endpoints, mcp: 'https://other.example/mcp' } },
    { ...good, device: { ...good.device, kind: 'browser' } },
    { ...good, device: { ...good.device, scopes: ['*'] } },
    { ...good, device: { ...good.device, expiresAt: '2100-01-01T00:00:00Z' } },
  ]) await assert.rejects(redeemAccessCode({ url: publicUrl, name: 'Agent' }, grant.code, { ...f.context, fetchImpl: async () => json(invalid) }), { code: 'ACCESS_RESPONSE_INVALID', uncertain: true });
});

test('help has no profile, listener, or transport side effects', async () => {
  let calls = 0;
  const result = await invoke(['remote', '--help'], { fetchImpl: async () => { calls++; throw Error(); }, inspectRuntime: async () => { calls++; throw Error(); } });
  assert.equal(result.exitCode, 0); assert.match(result.stdout, /--code-stdin/); assert.match(result.stdout, /--scope=tasks:write/); assert.match(result.stdout, /--url=HTTPS_ORIGIN/); assert.match(result.stdout, /--name=NAME/); assert.equal(calls, 0);
});


test('private output pins the Windows Security module despite incompatible inherited module paths', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), modules = path.join(f.root, 'foreign-modules'), foreign = path.join(modules, 'Microsoft.PowerShell.Security');
  await fs.mkdir(foreign, { recursive: true });
  await fs.writeFile(path.join(foreign, 'Microsoft.PowerShell.Security.psd1'), "@{RootModule='incompatible.psm1';ModuleVersion='99.0.0';GUID='11111111-1111-4111-8111-111111111111';FunctionsToExport=@('Get-Acl','Set-Acl');CmdletsToExport=@();AliasesToExport=@()}\n");
  await fs.writeFile(path.join(foreign, 'incompatible.psm1'), "function Get-Acl { throw 'An incompatible security module was selected.' }; function Set-Acl { throw 'An incompatible security module was selected.' }; Export-ModuleMember -Function Get-Acl,Set-Acl\n");
  const grant = f.sessions.issuePairing({ kind: 'agent' }), inherited = process.env.PSModulePath;
  const context = { ...f.context, env: { ...f.context.env, PSModulePath: [modules, f.context.env.PSModulePath].filter(Boolean).join(path.delimiter) } };
  const result = await invoke(['remote', 'pair', '--url', publicUrl, '--code-stdin', '--output', 'isolated-module.json', '--json'], context, grant.code);
  assert.equal(result.exitCode, 0, result.stdout + result.stderr); assert.equal(result.value.credentialSaved, true); assert.equal(result.value.token, undefined);
  const saved = JSON.parse(await fs.readFile(result.value.connectionFile, 'utf8'));
  assert.ok(f.sessions.authenticate(saved.token, 'agent')); assert.equal(result.stdout.includes(saved.token), false); assert.equal(result.stderr, '');
  assert.equal(process.env.PSModulePath, inherited, 'only the child environment is supplied; parent module paths are unchanged');
});
