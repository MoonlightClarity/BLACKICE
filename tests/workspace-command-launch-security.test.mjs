import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import vm from 'node:vm';

// Evaluate the exact implementation with inert dependencies. No real subprocess,
// filesystem mutation, provider, network, or blocked incident payload can run.
const source = await readFile(new URL('../lib/workspace-tools.mjs', import.meta.url), 'utf8');
function fixture({ platform = 'win32', failure, observed = false, synchronous = false, output = 'ok' } = {}) {
  const launches = [];
  const spawn = (executable, args, options) => {
    launches.push({ executable, args, options });
    if (synchronous) throw Object.assign(new Error('launch refused'), { code: failure });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    if (observed || !failure) child.pid = 123;
    queueMicrotask(() => {
      if (observed || !failure) child.emit('spawn');
      if (failure) child.emit('error', Object.assign(new Error('launch refused'), { code: failure }));
      else { child.stdout.emit('data', Buffer.from(output)); child.stderr.emit('data', Buffer.from('diagnostic')); }
      child.emit('close', failure ? null : 0, null);
    });
    return child;
  };
  const sandbox = { spawn, fs: { stat: async () => ({ isDirectory: () => true }), readdir: async () => [] }, path, StringDecoder,
    process: { platform, env: { BLACKICE_RESTART_ORIGIN: 'stale', KEEP: 'value' } },
    DESKTOP_RESTART_ORIGIN_ENV: 'BLACKICE_RESTART_ORIGIN', setTimeout, clearTimeout, AbortSignal, Buffer, TextDecoder };
  const transformed = source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInNewContext(transformed + '\nthis.api = { createWorkspaceToolHandler, WORKSPACE_INSTRUCTIONS, processFailure };', sandbox);
  const handler = sandbox.api.createWorkspaceToolHandler({ cwd: '/fixture' });
  const run = async (command = 'Write-Output "plain text"') => {
    const result = await handler({ name: 'relay_workspace', arguments: { action: 'run', command } });
    return { success: result.success, ...JSON.parse(result.contentItems[0].text) };
  };
  const search = async () => {
    const result = await handler({ name: 'relay_workspace', arguments: { action: 'search', query: 'fixture' } });
    return { success: result.success, ...JSON.parse(result.contentItems[0].text) };
  };
  return { launches, run, search, instructions: sandbox.api.WORKSPACE_INSTRUCTIONS, processFailure: sandbox.api.processFailure };
}

test('PowerShell receives ordinary inline command without hidden/policy switches', async () => {
  const f = fixture(); const r = await f.run('Write-Output "quotes; $literal"');
  assert.equal(r.success, true); assert.equal(f.launches.length, 1);
  const launch = f.launches[0]; assert.equal(launch.executable, 'powershell.exe');
  assert.deepEqual(Array.from(launch.args.slice(0, 4)), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(launch.args.length, 5); assert.ok(launch.args[4].endsWith('\nWrite-Output "quotes; $literal"'));
  assert.ok(!launch.args.some(arg => /Bypass|EncodedCommand|WindowStyle|ExecutionPolicy/i.test(arg)));
  assert.equal(launch.options.windowsHide, true); // Only suppress console-window creation; captured output is retained.
  assert.equal(launch.options.env.BLACKICE_RESTART_ORIGIN, undefined);
  assert.equal(launch.options.env.KEEP, 'value'); assert.equal(r.stdout, 'ok'); assert.equal(r.stderr, 'diagnostic');
});
test('POSIX shell receives original command and Unicode output is retained', async () => {
  const f = fixture({ platform: 'linux', output: 'café ☃' }); const command = 'printf "%s" "a b" | cat';
  const r = await f.run(command); assert.equal(r.stdout, 'café ☃');
  assert.equal(f.launches[0].executable, '/bin/sh'); assert.deepEqual(Array.from(f.launches[0].args), ['-c', command]);
});
for (const failure of ['EPERM', 'EACCES', 'ENOENT']) {
  for (const synchronous of [false, true]) test(`${failure} ${synchronous ? 'throw' : 'error event'} is one launch, not a retry`, async () => {
    const f = fixture({ failure, synchronous }); const r = await f.run();
    assert.equal(r.success, false); assert.equal(r.code, failure); assert.equal(f.launches.length, 1);
    assert.equal(r.launch.stage, 'process_start_not_observed'); assert.equal(r.launch.processStartObserved, false);
    assert.equal(r.launch.executionOutcome, 'unknown'); assert.equal(r.launch.automaticRetry, false);
    assert.equal(r.launch.securityBlockConfirmed, false); assert.equal(r.launch.securityBlockPossible, failure !== 'ENOENT');
    assert.equal(r.launch.pid, null); assert.equal(r.actionDispatched, undefined);
    assert.ok(!JSON.stringify(r).includes('Write-Output'));
    if (failure !== 'ENOENT') assert.match(r.recovery, /Do not retry through another shell/);
  });
}
test('error after observed process start preserves uncertain outcome and known PID', async () => {
  const f = fixture({ failure: 'EPERM', observed: true }); const r = await f.run();
  assert.equal(r.launch.stage, 'process_started'); assert.equal(r.launch.processStartObserved, true);
  assert.equal(r.launch.pid, 123); assert.equal(r.launch.executionOutcome, 'unknown'); assert.equal(f.launches.length, 1);
});
test('guidance distinguishes confirmed blocks and uncertain receipt recovery', () => {
  const f = fixture(); assert.match(f.instructions, /After a confirmed security block, stop the action/);
  assert.match(f.instructions, /same requestId and identical arguments under the same connection/);
  assert.match(f.instructions, /do not disable protection or add exclusions/);
  assert.match(f.instructions, /For direct connector calls, transport recovery/);
});
test('added launch metadata is bounded without exposing arguments', () => {
  const f = fixture(); const error = f.processFailure(Object.assign(new Error('denied'), { code: 'EPERM' }),
    { executable: 'x'.repeat(10000), cwd: 'y'.repeat(10000) });
  assert.equal(error.launch.executable.length, 240); assert.equal(error.launch.cwd.length, 1024);
  assert.equal(error.launch.executionOutcome, 'unknown'); assert.ok(JSON.stringify(error.launch).length < 1800);
});
test('search keeps the ENOENT-only filesystem fallback, never on permission denial', async () => {
  const absent = fixture({ failure: 'ENOENT' }); const fallback = await absent.search();
  assert.equal(fallback.success, true); assert.equal(fallback.engine, 'filesystem'); assert.equal(absent.launches.length, 1);
  const denied = fixture({ failure: 'EPERM' }); const refusal = await denied.search();
  assert.equal(refusal.success, false); assert.equal(refusal.code, 'EPERM'); assert.equal(refusal.engine, undefined);
  assert.equal(denied.launches.length, 1);
});
