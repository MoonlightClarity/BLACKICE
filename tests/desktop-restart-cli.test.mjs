import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopRestartController } from '../desktop/restart.mjs';
import { DESKTOP_RESTART_ORIGIN_ENV } from '../lib/desktop-restart-origin.mjs';
import { desktopRestartArgs, executeDesktopRestartCLI, parseDesktopRestartArgs, runDesktopRestartCLI } from '../lib/desktop-restart-cli.mjs';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function held() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function acknowledgement(requestId, status = 'scheduled', extra = {}) {
  return { protocol: 1, acknowledged: true, receipt: { id: 'restart-receipt', ownerId: 'local', jobId: null, requestId, status, durable: true }, ...extra };
}
async function invoke(args, context = {}) {
  let stdout = '', stderr = '';
  const code = await runDesktopRestartCLI(args, { env: {}, ...context, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
  return { code, stdout, stderr, result: stdout.startsWith('{') ? JSON.parse(stdout) : null, error: stderr ? JSON.parse(stderr) : null };
}
async function localSession(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-restart-cli-'));
  const profile = path.join(root, 'profile'); await fs.mkdir(profile);
  const executable = path.join(root, 'BLACKICE'), url = 'http://127.0.0.1:21567', session = 'a'.repeat(64);
  const runtime = { pid: 34567, executable, startedAt: '2026-10-22T02:00:00.000Z', version: '2.30.0', url, profileMode: 'custom', capabilities: { electron: true } };
  const runtimeFile = path.join(profile, 'desktop-runtime.json'); await fs.writeFile(runtimeFile, JSON.stringify(runtime));
  const calls = [], state = { inspectCount: 0, restart: async (_route, input) => json(acknowledgement(input.requestId)) };
  const context = {
    defaultProfile: profile, expectedExecutable: executable, env: {},
    inspectRuntime: async () => { state.inspectCount++; return { pid: runtime.pid, executable, startedAt: runtime.startedAt, listeners: [{ address: '127.0.0.1', pid: runtime.pid }] }; },
    fetchImpl: async (target, options) => {
      calls.push({ target, options });
      if (target === url + '/') return new Response('<!doctype html><title>BLACKICE</title>', { headers: { 'set-cookie': `relay_session_21567=${session}; HttpOnly; SameSite=Strict; Path=/` } });
      if (target === url + '/api/status') return json({ app: 'relay-agent-harness', version: runtime.version, desktopApp: true, remoteAccess: { client: 'local' } });
      if (target.startsWith(url + '/api/desktop/restart')) return state.restart(target.slice(url.length), JSON.parse(options.body));
      throw new Error('Unexpected local-session fixture request.');
    },
  };
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { profile, runtimeFile, runtime, context, calls, state, session, url };
}

test('native dispatch recognizes only restart actions before ordinary desktop startup', () => {
  assert.deepEqual(desktopRestartArgs(['BLACKICE.exe', '--restart', '--request-id=restart-1']), ['--restart', '--request-id=restart-1']);
  assert.deepEqual(desktopRestartArgs(['electron', '.', '--profile-dir=/profile', '--restart-status', '--request-id=restart-1'], { packaged: false }), ['--profile-dir=/profile', '--restart-status', '--request-id=restart-1']);
  assert.deepEqual(desktopRestartArgs(['BLACKICE.exe', '--cancel-restart', '--request-id=restart-1']), ['--cancel-restart', '--request-id=restart-1']);
  assert.deepEqual(desktopRestartArgs(['BLACKICE.exe', '--restart=true']), ['--restart=true']);
  for (const args of [['BLACKICE.exe'], ['BLACKICE.exe', '--headless'], ['BLACKICE.exe', '--background'], ['BLACKICE.exe', '--quit'], ['BLACKICE.exe', 'browser', 'profiles']]) assert.equal(desktopRestartArgs(args), null);
});

test('restart arguments preserve exact request and profile identities while rejecting conflicting options', () => {
  assert.deepEqual(parseDesktopRestartArgs(['--restart', '--force', '--request-id=forced']), { action: 'restart', force: true, 'request-id': 'forced' });
  assert.deepEqual(parseDesktopRestartArgs(['--restart', '--request-id', 'restart:exact_1.2-3', '--profile', '/chosen profile']), { action: 'restart', 'request-id': 'restart:exact_1.2-3', 'profile-dir': '/chosen profile' });
  assert.deepEqual(parseDesktopRestartArgs(['--restart-status', '--request-id=saved']), { action: 'status', 'request-id': 'saved' });
  assert.deepEqual(parseDesktopRestartArgs(['--cancel-restart', '--request-id=saved']), { action: 'cancel', 'request-id': 'saved' });
  assert.equal(parseDesktopRestartArgs(['--restart', '--request-id=' + 'a'.repeat(120)])['request-id'].length, 120);
  for (const args of [
    [], ['--restart=true'], ['--restart', '--restart'], ['--restart', '--restart-status'], ['--restart-status'], ['--cancel-restart'],
    ['--restart', '--headless'], ['--restart', '--background'], ['--restart', '--quit'], ['--restart', '--request-id'],
    ['--restart', '--request-id=one', '--request-id=two'], ['--restart', '--profile=/one', '--profile-dir=/two'],
    ['--restart', '--request-id=-invalid'], ['--restart', '--request-id=has space'], ['--restart', '--request-id=' + 'a'.repeat(121)],
    ['--restart', '--request-id=bad\nvalue'], ['--restart', '--request-id= padded '], ['--restart', '--origin-token=' + 'b'.repeat(64)],
    ['--restart', '--job-id=someone-else'], ['--restart', '--owner-id=another-owner'], ['--restart', '--unknown'],
    ['--force'], ['--restart-status', '--request-id=saved', '--force'], ['--cancel-restart', '--request-id=saved', '--force'],
    ['--restart', '--force=true'], ['--restart', '--force', '--force'], ['--restart', '--force', '--legacy-native-handoff'],
  ]) assert.throws(() => parseDesktopRestartArgs(args), { code: 'DESKTOP_RESTART_ARGUMENTS' }, JSON.stringify(args));
});

test('native force is explicit in the authenticated request and must match the durable acknowledgement', async () => {
  const calls = [];
  const context = { connect: async () => ({ request: async (route, input) => { calls.push({ route, input }); const result = acknowledgement(input.requestId); result.receipt.force = true; return result; } }) };
  const result = await invoke(['--restart', '--force', '--request-id=force-exact'], context);
  assert.equal(result.code, 0); assert.equal(result.result.receipt.force, true);
  assert.deepEqual(calls, [{ route: '/api/desktop/restart', input: { requestId: 'force-exact', force: true } }]);
  const uncertain = await invoke(['--restart', '--force', '--request-id=force-exact'], { connect: async () => ({ request: async () => acknowledgement('force-exact') }) });
  assert.equal(uncertain.code, 1); assert.equal(uncertain.error.code, 'DESKTOP_RESTART_ACK_UNCERTAIN');
  const invalidReceipt = acknowledgement('force-exact'); invalidReceipt.receipt.force = 'true';
  const invalid = await invoke(['--restart', '--force', '--request-id=force-exact'], { connect: async () => ({ request: async () => invalidReceipt }) });
  assert.equal(invalid.code, 1); assert.equal(invalid.error.code, 'DESKTOP_RESTART_ACK_UNCERTAIN');
});

test('help makes no connection and never creates or forwards a restart request', async () => {
  let connections = 0, legacyCalls = 0;
  const result = await invoke(['--restart', '--help'], { connect: async () => { connections++; throw new Error('Help must be offline.'); }, legacyHandoff: () => { legacyCalls++; } });
  assert.equal(result.code, 0); assert.match(result.stdout, /durable scheduling, not completed restart/);
  assert.match(result.stdout, /same ID/); assert.equal(result.stderr, ''); assert.equal(connections, 0); assert.equal(legacyCalls, 0);
});

test('native CLI uses the ordinary local session and prints the actual durable scheduling receipt before relaunch', async t => {
  const f = await localSession(t), ack = held(), events = [], before = await fs.readFile(f.runtimeFile);
  const controller = new DesktopRestartController({
    profileDir: f.profile, getIdentity: () => ({ ...f.runtime, profileDir: f.profile, mode: 'background' }),
    getLaunchOptions: () => ({ execPath: process.execPath, args: [], profileDir: f.profile, mode: 'background' }),
    relaunch: () => events.push('relaunch'), quit: () => events.push('quit'),
  });
  t.after(async () => { controller.cancelPending(); ack.resolve(); await controller.waitForHandoff(); });
  f.state.restart = async (route, input) => {
    assert.equal(route, '/api/desktop/restart'); assert.deepEqual(input, { requestId: 'actual-receipt' });
    const receipt = await controller.request({ requestId: input.requestId, waitForAcknowledgement: () => ack.promise });
    return json({ protocol: 1, acknowledged: true, receipt });
  };
  const result = await invoke(['--restart', '--request-id=actual-receipt'], f.context);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.result.receipt.status, 'scheduled'); assert.equal(result.result.receipt.durable, true);
  const saved = JSON.parse(await fs.readFile(path.join(f.profile, 'desktop-restart.json'), 'utf8'));
  assert.deepEqual(result.result.receipt, saved.receipts[0]); assert.deepEqual(events, []);
  assert.equal(f.state.inspectCount, 2); assert.equal(f.calls.length, 3);
  const mutation = f.calls[2]; assert.equal(mutation.options.method, 'POST'); assert.equal(mutation.options.headers.Origin, f.url);
  assert.equal(mutation.options.headers.Cookie, `relay_session_21567=${f.session}`); assert.equal(mutation.options.redirect, 'error');
  assert.deepEqual(await fs.readFile(f.runtimeFile), before);
  ack.resolve(); assert.equal((await controller.waitForHandoff()).status, 'restarting'); assert.deepEqual(events, ['relaunch', 'quit']);
});

test('an inherited origin is sent only in the exact request body and is never printed as a receipt', async () => {
  const token = 'b'.repeat(64), calls = [], signal = new AbortController().signal;
  const result = await invoke(['--restart', '--request-id=bound-command'], {
    env: { [DESKTOP_RESTART_ORIGIN_ENV]: token }, signal,
    connect: async (_options, context) => { assert.equal(context.signal, signal); return { request: async (route, input) => { calls.push({ route, input }); return acknowledgement(input.requestId); } }; },
  });
  assert.equal(result.code, 0); assert.deepEqual(calls, [{ route: '/api/desktop/restart', input: { requestId: 'bound-command', originToken: token } }]);
  assert.equal((result.stdout + result.stderr).includes(token), false);
  for (const value of ['', 'c'.repeat(63), 'g'.repeat(64), null]) {
    let requests = 0;
    const invalid = await invoke(['--restart', '--request-id=bad-origin'], { env: { [DESKTOP_RESTART_ORIGIN_ENV]: value }, connect: async () => ({ request: async () => { requests++; } }) });
    assert.equal(invalid.code, 1); assert.equal(invalid.error.code, 'DESKTOP_RESTART_ORIGIN_INVALID'); assert.equal(requests, 0);
  }
});

test('lost acknowledgement reports the generated stable ID and only an explicit same-ID retry sends another request', async t => {
  const f = await localSession(t), admitted = []; let legacyCalls = 0;
  f.state.restart = async (_route, input) => { admitted.push(input); throw new TypeError('Connection closed before a response.'); };
  const first = await invoke(['--restart'], { ...f.context, legacyHandoff: () => { legacyCalls++; } });
  assert.equal(first.code, 1); assert.equal(first.error.code, 'DESKTOP_RESTART_ACK_UNCERTAIN');
  assert.match(first.error.requestId, /^native-restart-[a-f0-9-]{36}$/); assert.match(first.error.error, /identical restart request ID/);
  assert.deepEqual(admitted, [{ requestId: first.error.requestId }]); assert.equal(legacyCalls, 0);
  f.state.restart = async (_route, input) => { admitted.push(input); return json(acknowledgement(input.requestId)); };
  const retry = await invoke(['--restart', '--request-id=' + first.error.requestId], { ...f.context, legacyHandoff: () => { legacyCalls++; } });
  assert.equal(retry.code, 0); assert.equal(retry.result.receipt.requestId, first.error.requestId);
  assert.deepEqual(admitted[1], admitted[0]); assert.equal(admitted.length, 2); assert.equal(legacyCalls, 0);
});

test('an old endpoint or explicit refusal never falls back to the native legacy handoff', async t => {
  const f = await localSession(t); let legacyCalls = 0, requests = 0;
  for (const [status, body, code] of [
    [404, { error: 'Endpoint not found.' }, 'BROWSER_CLI_REJECTED'],
    [503, { error: 'Native restart is unavailable in this runtime.', code: 'DESKTOP_RESTART_UNAVAILABLE' }, 'DESKTOP_RESTART_UNAVAILABLE'],
    [409, { error: 'The originating connection is no longer authorized.', code: 'DESKTOP_RESTART_ORIGIN_UNAUTHORIZED' }, 'DESKTOP_RESTART_ORIGIN_UNAUTHORIZED'],
  ]) {
    f.state.restart = async () => { requests++; return json(body, status); };
    const result = await invoke(['--restart', '--request-id=refused-' + status], { ...f.context, legacyHandoff: () => { legacyCalls++; } });
    assert.equal(result.code, 1); assert.equal(result.error.code, code); assert.equal(result.error.requestId, 'refused-' + status); assert.equal(result.stdout, '');
  }
  assert.equal(requests, 3); assert.equal(legacyCalls, 0);
});

test('acknowledgements must name the exact request and assert a durable recognized receipt', async () => {
  const good = acknowledgement('same-id');
  for (const value of [
    null, {}, { ...good, protocol: 2 }, { ...good, acknowledged: false }, { ...good, receipt: undefined },
    { ...good, receipt: { ...good.receipt, requestId: 'another-id' } },
    { ...good, receipt: { ...good.receipt, status: 'running' } },
    { ...good, receipt: { ...good.receipt, durable: false } },
    { ...good, receipt: { ...good.receipt, durable: undefined } },
  ]) {
    let requests = 0, legacyCalls = 0;
    const result = await invoke(['--restart', '--request-id=same-id'], { connect: async () => ({ request: async () => { requests++; return value; } }), legacyHandoff: () => { legacyCalls++; } });
    assert.equal(result.code, 1); assert.equal(result.error.code, 'DESKTOP_RESTART_ACK_UNCERTAIN'); assert.equal(result.error.requestId, 'same-id');
    assert.equal(result.stdout, ''); assert.equal(requests, 1); assert.equal(legacyCalls, 0);
  }
});

test('status and cancellation address the exact saved request without submitting a restart', async () => {
  const calls = [], context = { env: {}, connect: async () => ({ request: async (route, input) => {
    calls.push({ route, input }); return acknowledgement(input.requestId, route.endsWith('/cancel') ? 'cancelled' : 'completed', route.endsWith('/cancel') ? { cancellationRequested: true } : {});
  } }) };
  const status = await invoke(['--restart-status', '--request-id=inspect-saved'], context);
  const cancelled = await invoke(['--cancel-restart', '--request-id=inspect-saved'], context);
  assert.equal(status.code, 0); assert.equal(status.result.receipt.status, 'completed'); assert.equal(cancelled.code, 0); assert.equal(cancelled.result.cancellationRequested, true);
  assert.deepEqual(calls, [
    { route: '/api/desktop/restart/status', input: { requestId: 'inspect-saved' } },
    { route: '/api/desktop/restart/cancel', input: { requestId: 'inspect-saved' } },
  ]);
});

test('CLI exit status reports saved refusal and cancellation without rewriting the receipt as success', async () => {
  for (const status of ['scheduled', 'restarting', 'completed', 'failed', 'cancelled', 'interrupted']) {
    const reply = acknowledgement('status-' + status, status);
    if (status === 'failed') reply.receipt.error = { code: 'DESKTOP_RESTART_BROWSER_BUSY', message: 'Finish the pending browser interaction.' };
    const result = await invoke(['--restart', '--request-id=status-' + status], { connect: async () => ({ request: async () => reply }) });
    assert.equal(result.code, ['failed', 'cancelled', 'interrupted'].includes(status) ? 1 : 0);
    assert.deepEqual(result.result, reply); assert.equal(result.stderr, '');
  }
});

test('legacy handoff is explicit, cannot claim a caller ID, and invokes only the verified native callback', async () => {
  assert.deepEqual(parseDesktopRestartArgs(['--restart', '--legacy-native-handoff']), { action: 'restart', legacy: true });
  for (const args of [
    ['--restart', '--legacy-native-handoff', '--request-id=unsupported'],
    ['--restart-status', '--legacy-native-handoff', '--request-id=saved'],
    ['--cancel-restart', '--legacy-native-handoff', '--request-id=saved'],
    ['--restart', '--legacy-native-handoff', '--legacy-native-handoff'],
  ]) assert.throws(() => parseDesktopRestartArgs(args), { code: 'DESKTOP_RESTART_ARGUMENTS' });
  const runtime = { pid: 34567, startedAt: '2026-10-22T02:00:00.000Z', profile: '/verified-profile' }, events = [];
  const result = await invoke(['--restart', '--legacy-native-handoff'], {
    connect: async () => { events.push('verified-session'); return { runtime, request: async () => { events.push('http-restart'); throw new Error('Legacy must not submit the new protocol.'); } }; },
    legacyHandoff: async observed => { assert.equal(observed, runtime); events.push('native-forward'); },
  });
  assert.equal(result.code, 0); assert.equal(result.result.protocol, 'legacy-single-instance'); assert.equal(result.result.acknowledged, false);
  assert.equal(result.result.status, 'forwarded'); assert.equal(result.result.receipt, undefined); assert.deepEqual(result.result.primary, { pid: runtime.pid, startedAt: runtime.startedAt });
  assert.match(result.result.message, /do not infer success/); assert.deepEqual(events, ['verified-session', 'native-forward']);
});

test('legacy dispatch requires a verified connection and an actual native callback', async () => {
  let calls = 0;
  const blocked = await invoke(['--restart', '--legacy-native-handoff'], {
    connect: async () => { throw Object.assign(new Error('The runtime owner differs.'), { code: 'ACCESS_RUNTIME_OWNERSHIP' }); }, legacyHandoff: () => { calls++; },
  });
  assert.equal(blocked.code, 1); assert.equal(blocked.error.code, 'ACCESS_RUNTIME_OWNERSHIP'); assert.equal(calls, 0);
  await assert.rejects(executeDesktopRestartCLI(parseDesktopRestartArgs(['--restart', '--legacy-native-handoff']), { env: {}, connect: async () => ({ runtime: {}, request: async () => {} }) }), { code: 'DESKTOP_RESTART_LEGACY_UNAVAILABLE' });
  const failed = await invoke(['--restart', '--legacy-native-handoff'], { connect: async () => ({ runtime: {}, request: async () => {} }), legacyHandoff: () => { calls++; throw Object.assign(new Error('The primary exited before forwarding.'), { code: 'DESKTOP_RESTART_LEGACY_UNAVAILABLE' }); } });
  assert.equal(failed.code, 1); assert.equal(failed.error.code, 'DESKTOP_RESTART_LEGACY_UNAVAILABLE'); assert.equal(failed.stdout, ''); assert.equal(calls, 1);
});
