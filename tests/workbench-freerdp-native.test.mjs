import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(repo, '.build', 'workbench-freerdp-client.exe');
const runtime = path.join(repo, '.build', 'workbench-freerdp-runtime-openssl');
const supported = process.platform === 'win32' && existsSync(executable) && existsSync(path.join(runtime, 'runtime-manifest.json'));
const native = (args, input) => {
  const result = spawnSync(executable, args, {
    windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, input,
    env: { ...process.env, PATH: [path.join(runtime, 'bin'), path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(path.delimiter), OPENSSL_CONF: path.join(runtime, 'etc/ssl/openssl.cnf'), OPENSSL_MODULES: path.join(runtime, 'lib/ossl-modules') },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
};
const request = (action, extra = {}) => JSON.stringify({ requestId: action, action, ...extra });

test('native hidden viewport exercises pixels, ownership and auth rejection without network or foreground activation', { skip: !supported }, () => {
  const [reply] = native(['--self-test']);
  assert.equal(reply.ok, true);
  assert.equal(reply.result.selfTest, true);
  assert.equal(reply.result.networkStarted, false);
  assert.equal(reply.result.foregroundUnchanged, true);
  assert.equal(reply.result.connected, false);
  assert.equal(reply.result.digestReady, true);
  assert.equal(reply.result.diagnosticCallbacksVerified, true);
  assert.equal(reply.result.vmConnectProtocolVerified, true);
  assert.equal(reply.result.classicGraphicsVerified, true);
  assert.equal(reply.result.sampleVerified, true);
  assert.equal(reply.result.ownershipReleaseVerified, true);
  assert.equal(reply.result.presentationVerified, true);
  assert.equal(reply.result.detachedVerified,true);
  assert.equal(reply.result.clipboardVerified,true);
  assert.equal(reply.result.bufferedPresentationVerified,true);
  assert.equal(reply.result.iconResourcePresent,true);
  assert.equal(reply.result.windowForeground,false);
  assert.equal(reply.result.clipboard.pendingPaste,0);
  assert.equal(reply.result.clipboard.enabled,false);
  assert.ok(Number.isSafeInteger(reply.result.viewport.revision));
  assert.equal(reply.result.wakeVerified,true);assert.equal(reply.result.frameHealthVerified,true);
  assert.equal(reply.result.frameHealth.available,true);assert.equal(reply.result.frameHealth.dark,false);
  assert.equal(reply.result.presentationReady,false);
  assert.ok(reply.result.presentation.siblingRaiseCount>=1);
  assert.equal(reply.result.presentation.styleLeaseCount,0);
  assert.equal(reply.result.presentation.hostPaintingProtected,false);
  assert.ok(reply.result.presentation.printCount>=3);
  assert.equal(reply.result.perMonitorV2, true);
  assert.equal(reply.result.connectionProgress.state, 'CONNECTION_STATE_INITIAL');
  assert.equal(reply.result.connectionProgress.readBytes, 0);
  assert.equal(reply.result.connectionProgress.writeBytes, 0);
  assert.equal(reply.result.inputOwner, 'agent');
  assert.equal(reply.result.decodedFrames, 1);
  assert.equal(reply.result.surface.width, 16);
  assert.equal(reply.result.surface.height, 16);
});

test('native protocol rejects connection, input and viewport mutations before preparation', { skip: !supported }, () => {
  const actions = ['connect', 'bounds', 'visible', 'input', 'capture', 'sample','wake','clipboard'];
  const replies = native(['--stream'], actions.map(action => request(action, { enabled: true })).concat(request('status'), request('close')).join('\n') + '\n');
  for (const action of actions) {
    const reply = replies.find(value => value.requestId === action);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'NOT_PREPARED');
  }
  const status = replies.find(value => value.requestId === 'status');
  assert.equal(status.ok, true);
  assert.equal(status.result.prepared, false);
  assert.equal(status.result.connected, false);
  assert.equal(status.result.decodedFrames, 0);
  assert.equal(replies.find(value => value.requestId === 'close').ok, true);
});

test('native protocol rejects malformed, trailing and oversized JSON and invalid parent identities', { skip: !supported }, () => {
  const input = ['{invalid', request('status') + ' trailing', JSON.stringify({ requestId: 1, action: 'status' }), request('prepare', { parent: '0' }), 'x'.repeat(65537), request('close')].join('\n') + '\n';
  const replies = native(['--stream'], input);
  assert.deepEqual(replies.filter(value => !value.ok).map(value => value.code), ['JSON_INVALID', 'JSON_INVALID', 'ARGUMENTS', 'PARENT_INVALID', 'REQUEST_TOO_LARGE']);
  assert.equal(replies.find(value => value.requestId === 'close').ok, true);
});

test('isolated stream parent supports child lifecycle and rejects unpinned or remote connections without network', { skip: !supported }, () => {
  const replies = native(['--stream-test-parent'], [
    request('prepare', { parent: 'self', x: 0, y: 0, width: 640, height: 480 }),
    request('bounds', { x: 4, y: 8, width: 320, height: 240 }),
    request('visible', { visible: true }),
    request('input', { enabled: true }),
    request('input', { requestId: 'cede', enabled: false }),
    request('connect', { vmId: '11111111-1111-4111-8111-111111111111', certificateSha256: 'invalid' }),
    request('connect', { requestId: 'remote', vmId: '11111111-1111-4111-8111-111111111111', host: 'remote.example', certificateSha256: 'a'.repeat(64) }),
    request('status'), request('close'),
  ].join('\n') + '\n');
  for (const id of ['prepare', 'bounds', 'visible', 'input', 'cede']) assert.equal(replies.find(value => value.requestId === id).ok, true);
  assert.equal(replies.find(value => value.requestId === 'connect').code, 'CONNECT_ARGUMENTS');
  assert.equal(replies.find(value => value.requestId === 'remote').code, 'CONNECT_ARGUMENTS');
  const status = replies.find(value => value.requestId === 'status').result;
  assert.equal(status.prepared, true);
  assert.equal(status.connected, false);
  assert.equal(status.certificateVerified, false);
  assert.equal(status.inputOwner, 'agent');
  assert.equal(status.decodedFrames, 0);
});

test('native runtime rejects a missing legacy provider before any connection or guest surface', { skip: !supported }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-native-digest-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const config = path.join(temporary, 'openssl.cnf');
  await fs.writeFile(config, 'openssl_conf = init\n[init]\nproviders = providers\n[providers]\ndefault = default\n[default]\nactivate = 1\n');
  const result = spawnSync(executable, ['--self-test'], {
    windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PATH: [path.join(runtime, 'bin'), path.join(process.env.SystemRoot, 'System32'), process.env.SystemRoot].join(path.delimiter), OPENSSL_CONF: config, OPENSSL_MODULES: path.join(temporary, 'missing') },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const reply = JSON.parse(result.stdout.trim());
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'SELF_TEST_FAILED');
  assert.equal(reply.result.digestReady, false);
  assert.equal(reply.result.connected, false);
  assert.equal(reply.result.networkStarted, false);
  assert.equal(reply.result.decodedFrames, 0);
});
test('native shown child protects owned sibling painting and hiding releases its style lease', {skip:!supported},()=>{
  const replies=native(['--stream-test-parent'],[
    request('prepare',{parent:'self',x:0,y:0,width:640,height:480}),
    request('visible',{visible:true}),request('status',{requestId:'shown'}),
    request('visible',{visible:false}),request('status',{requestId:'hidden'}),request('close')
  ].join('\n')+'\n');
  const shown=replies.find(reply=>reply.requestId==='shown').result;
  assert.equal(shown.visible,true);assert.equal(shown.presentation.hostPaintingProtected,true);
  assert.equal(shown.presentation.childFirstSibling,true);assert.equal(shown.presentation.error,0);
  assert.equal(shown.presentation.styleLeaseCount,1);
  const hidden=replies.find(reply=>reply.requestId==='hidden').result;
  assert.equal(hidden.visible,false);assert.equal(hidden.presentation.hostPaintingProtected,false);
  assert.equal(hidden.presentation.styleLeaseCount,0);assert.equal(hidden.foregroundUnchanged,true);
});
