import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { resolveWorkbenchNativeRuntime } from '../desktop/workbench-native-runtime.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = { sameConsolePixels: true, inputOwnership: true, noHostActivation: true, motionAndLatency: true, lifecycle: true };
const iconPaths = {
  svgSha256: 'desktop/workbench-icon.svg', pngSha256: 'desktop/workbench-icon.png',
  icoSha256: 'desktop/workbench-icon.ico', manifestSha256: 'desktop/workbench-icon.manifest.json',
  rcSha256: 'scripts/workbench-freerdp-client/workbench-icon.rc',
  buildScriptSha256: 'scripts/build-workbench-freerdp-client.ps1', iconBuilderSha256: 'desktop/build-icon.mjs',
  windresSha256: '.build/workbench-freerdp-compiler/msys64/ucrt64/bin/windres.exe',
};
async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
async function fixture(t, packaged = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-native-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appDirectory = path.join(root, 'app'), resourcesDirectory = path.join(root, 'resources');
  const folder = packaged ? path.join(resourcesDirectory, 'workbench-native') : path.join(appDirectory, '.build');
  const runtimeRoot = path.join(folder, 'runtime');
  const helperPath = path.join(folder, 'native.exe'), helperBytes = Buffer.from('fixture native bytes');
  const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
  const runtimeManifest = { schema: 1, files: [] }, runtimeLock = '{"fixture":"runtime-lock"}', compilerLock = '{"fixture":"compiler-lock"}';
  const source = path.join(appDirectory, 'scripts/workbench-freerdp-client/main.cpp');
  const runtimeLockPath = packaged ? path.join(folder, 'dependency-lock.json') : path.join(appDirectory, 'docs/workbench-freerdp-dependencies.lock.json');
  const compilerLockPath = path.join(appDirectory, 'docs/workbench-freerdp-compiler.lock.json');
  const acceptancePath = packaged ? path.join(folder, 'acceptance.json') : path.join(appDirectory, '.build/workbench-native-acceptance.json');
  const iconFiles = Object.fromEntries(Object.entries(iconPaths).map(([key, relative]) => [key, path.join(appDirectory, relative)]));
  const iconResource = { resourceId: 101 };
  if (!packaged) await Promise.all(Object.entries(iconFiles).map(async ([key, file]) => {
    const bytes = 'fixture ' + key; await write(file, bytes); iconResource[key] = sha(bytes);
  }));
  await Promise.all([
    write(helperPath, helperBytes), write(manifestPath, runtimeManifest), write(source, 'fixture source'),
    write(runtimeLockPath, runtimeLock), write(compilerLockPath, compilerLock),
    fs.mkdir(path.join(runtimeRoot, 'bin'), { recursive: true }), fs.mkdir(appDirectory, { recursive: true }),
  ]);
  const helperSha256 = sha(helperBytes), runtimeManifestSha256 = sha(JSON.stringify(runtimeManifest));
  const acceptance = { schema: 1, scope: 'local-preview', helperSha256, runtimeManifestSha256, timingBasis: 'decoded-surface', checks: { ...checks } };
  const receipt = {
    schema: 2, source, executable: helperPath, sha256: helperSha256, runtimeDirectory: runtimeRoot,
    freerdpVersion: '3.32.2', compilerVersion: '16.2.0', liveVmVerified: false,
    sourceSha256: sha('fixture source'), compilerLockSha256: sha(compilerLock), runtimeLockSha256: sha(runtimeLock), runtimeManifestSha256,
    selfTest: { selfTest: true, networkStarted: false, foregroundUnchanged: true, digestReady: true, vmConnectProtocolVerified: true,
      iconResourcePresent: true, iconResource },
  };
  const receiptPath = path.join(appDirectory, '.build/workbench-freerdp-client-build.json');
  const descriptorPath = path.join(folder, 'native-display.json');
  const descriptor = { schema: 1, helper: 'native.exe', helperSha256, runtime: 'runtime', runtimeManifestSha256, dependencyLock: 'dependency-lock.json', dependencyLockSha256: sha(runtimeLock), acceptance: 'acceptance.json' };
  await write(packaged ? descriptorPath : receiptPath, packaged ? descriptor : receipt);
  const calls = [];
  const options = { appDirectory, resourcesDirectory, isPackaged: packaged,
    env: { SystemRoot: path.join(root, 'Windows') },
    verifyRuntime: async value => { calls.push(value); return runtimeManifest; },
  };
  return { root, options, calls, folder, helperPath, helperSha256, runtimeRoot, manifestPath, source, receipt, receiptPath, descriptor, descriptorPath, acceptance, acceptancePath, runtimeLockPath, compilerLockPath, iconFiles };
}

test('development resolver verifies bytes and dependencies before reporting missing or complete acceptance', async t => {
  const f = await fixture(t);
  const unavailable = await resolveWorkbenchNativeRuntime(f.options);
  assert.equal(unavailable.mode, 'development');
  assert.equal(unavailable.accepted, false);
  assert.equal(unavailable.detachedControls, false);
  assert.equal(unavailable.acceptanceScope, 'local-preview');
  assert.equal(unavailable.preview, true);assert.equal(unavailable.fullAcceptance, false);
  assert.equal(unavailable.timingBasis, null);
  assert.deepEqual(unavailable.acceptanceChecks, Object.fromEntries(Object.keys(checks).map(key => [key, false])));
  assert.equal(unavailable.runtimeDirectory, path.join(f.runtimeRoot, 'bin'));
  assert.deepEqual(f.calls, [{ outputDirectory: f.runtimeRoot, lockPath: f.runtimeLockPath, systemDirectory: path.join(f.root, 'Windows/System32') }]);
  await write(f.acceptancePath, f.acceptance);
  const accepted = await resolveWorkbenchNativeRuntime(f.options);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.detachedControls, false);
  assert.equal(accepted.acceptanceScope, 'local-preview');
  assert.equal(accepted.preview, true);assert.equal(accepted.fullAcceptance, false);
  assert.equal(accepted.timingBasis, 'decoded-surface');
  assert.equal(accepted.helperSha256, f.helperSha256);
  assert.deepEqual(accepted.acceptanceChecks, checks);
});

test('toolbar capability requires an explicit exact-build acceptance flag in both development and packaged mode', async t => {
  for (const packaged of [false, true]) {
    const f = await fixture(t, packaged);
    await write(f.acceptancePath, f.acceptance);
    assert.equal((await resolveWorkbenchNativeRuntime(f.options)).detachedControls, false);
    await write(f.acceptancePath, { ...f.acceptance, detachedControls: true });
    assert.equal((await resolveWorkbenchNativeRuntime(f.options)).detachedControls, true);
    await write(f.acceptancePath, { ...f.acceptance, detachedControls: 'true' });
    assert.equal((await resolveWorkbenchNativeRuntime(f.options)).detachedControls, false);
    await write(f.acceptancePath, { ...f.acceptance, detachedControls: true, checks: { ...checks, lifecycle: false } });
    assert.equal((await resolveWorkbenchNativeRuntime(f.options)).detachedControls, false);
    await write(f.acceptancePath, { ...f.acceptance, detachedControls: true, helperSha256: 'c'.repeat(64) });
    await assert.rejects(resolveWorkbenchNativeRuntime(f.options), { code: 'WORKBENCH_NATIVE_ACCEPTANCE' });
  }
});

test('acceptance cannot authorize different bytes, incomplete checks, or physical-photon timing claims', async t => {
  const f = await fixture(t);
  await write(f.acceptancePath, { ...f.acceptance, helperSha256: 'a'.repeat(64) });
  await assert.rejects(resolveWorkbenchNativeRuntime(f.options), { code: 'WORKBENCH_NATIVE_ACCEPTANCE' });
  await write(f.acceptancePath, { ...f.acceptance, runtimeManifestSha256: 'b'.repeat(64) });
  await assert.rejects(resolveWorkbenchNativeRuntime(f.options), { code: 'WORKBENCH_NATIVE_ACCEPTANCE' });
  await write(f.acceptancePath, { ...f.acceptance, scope: 'full-native' });
  await assert.rejects(resolveWorkbenchNativeRuntime(f.options), { code: 'WORKBENCH_NATIVE_ACCEPTANCE' });
  await write(f.acceptancePath, { ...f.acceptance, checks: { ...checks, lifecycle: false } });
  assert.equal((await resolveWorkbenchNativeRuntime(f.options)).accepted, false);
  await write(f.acceptancePath, { ...f.acceptance, timingBasis: 'physical-photon' });
  const result = await resolveWorkbenchNativeRuntime(f.options);
  assert.equal(result.accepted, false); assert.equal(result.timingBasis, null);
});

test('development build rejects helper, source and lock tampering and failed runtime verification', async t => {
  for (const member of ['helperPath', 'source', 'runtimeLockPath', 'compilerLockPath', 'manifestPath']) {
    const f = await fixture(t); await fs.appendFile(f[member], 'changed');
    await assert.rejects(resolveWorkbenchNativeRuntime(f.options), error => error.code === 'WORKBENCH_NATIVE_BUILD' && !error.message.includes(f.root));
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t);
  await assert.rejects(resolveWorkbenchNativeRuntime({ ...f.options, verifyRuntime: async () => { throw new Error('private dependency path ' + f.root); } }), error => error.code === 'WORKBENCH_NATIVE_BUILD' && !error.message.includes(f.root));
});

test('verification refuses files changed during the dependency check', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveWorkbenchNativeRuntime({ ...f.options, verifyRuntime: async () => { await fs.appendFile(f.helperPath, 'race'); } }), { code: 'WORKBENCH_NATIVE_BUILD' });
});

test('development receipt requires the native icon self-test and the exact complete icon binding schema', async t => {
  const variants = [
    selfTest => { delete selfTest.iconResourcePresent; },
    selfTest => { selfTest.iconResourcePresent = false; },
    selfTest => { delete selfTest.iconResource; },
    selfTest => { selfTest.iconResource.resourceId = 102; },
    selfTest => { delete selfTest.iconResource.svgSha256; },
    selfTest => { selfTest.iconResource.svgSha256 = 'not-a-hash'; },
    selfTest => { selfTest.iconResource.unboundFileSha256 = 'a'.repeat(64); },
  ];
  for (const change of variants) {
    const f = await fixture(t); change(f.receipt.selfTest); await write(f.receiptPath, f.receipt);
    await assert.rejects(resolveWorkbenchNativeRuntime(f.options), { code: 'WORKBENCH_NATIVE_BUILD' });
    assert.equal(f.calls.length, 0);
  }
});

test('development rejects changed icon assets, resource source, build tools and windres before verification', async t => {
  for (const key of Object.keys(iconPaths)) {
    const f = await fixture(t); await fs.appendFile(f.iconFiles[key], 'tampered');
    await assert.rejects(resolveWorkbenchNativeRuntime(f.options), error => error.code === 'WORKBENCH_NATIVE_BUILD' && !error.message.includes(f.root), key);
    assert.equal(f.calls.length, 0, key);
  }
});

test('all icon bindings are rechecked after dependency verification', async t => {
  for (const key of Object.keys(iconPaths)) {
    const f = await fixture(t); let verified = false;
    await assert.rejects(resolveWorkbenchNativeRuntime({ ...f.options, verifyRuntime: async () => {
      verified = true; await fs.appendFile(f.iconFiles[key], 'changed-during-verification'); return true;
    } }), { code: 'WORKBENCH_NATIVE_BUILD' }, key);
    assert.equal(verified, true, key);
  }
});

test('packaged resolver uses only confined descriptor paths and bound packaged acceptance', async t => {
  const f = await fixture(t, true); await write(f.acceptancePath, f.acceptance);
  await assert.rejects(fs.stat(f.iconFiles.svgSha256), { code: 'ENOENT' });
  const resolved = await resolveWorkbenchNativeRuntime(f.options);
  assert.equal(resolved.mode, 'packaged'); assert.equal(resolved.accepted, true);
  assert.equal(resolved.helperPath, f.helperPath);
  for (const bad of ['../native.exe', 'runtime/../../native.exe', 'C:\\foreign\\native.exe', '/foreign/native.exe', 'native.exe:stream']) {
    await write(f.descriptorPath, { ...f.descriptor, helper: bad });
    await assert.rejects(resolveWorkbenchNativeRuntime(f.options), { code: 'WORKBENCH_NATIVE_BUILD' });
  }
});

test('packaged mode never falls back to development or explicit development environment receipts', async t => {
  const f = await fixture(t);
  await assert.rejects(resolveWorkbenchNativeRuntime({ ...f.options, isPackaged: true,
    env: { ...f.options.env, BLACKICE_WORKBENCH_NATIVE_BUILD_RECEIPT: f.receiptPath, BLACKICE_WORKBENCH_NATIVE_ACCEPTANCE: f.acceptancePath },
  }), { code: 'WORKBENCH_NATIVE_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});

test('ordinary-path checks reject runtime directory junctions and bounded malformed records', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'foreign-bin'); await fs.mkdir(target);
  await fs.rmdir(path.join(f.runtimeRoot, 'bin'));
  await fs.symlink(target, path.join(f.runtimeRoot, 'bin'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveWorkbenchNativeRuntime(f.options), { code: 'WORKBENCH_NATIVE_BUILD' });
  assert.equal(f.calls.length, 0);
  const other = await fixture(t); await fs.writeFile(other.receiptPath, 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(resolveWorkbenchNativeRuntime(other.options), { code: 'WORKBENCH_NATIVE_BUILD' });
});

test('explicit development receipt and acceptance paths remain subject to the same hashes', async t => {
  const f = await fixture(t), record = path.join(f.root, 'explicit-build.json'), acceptance = path.join(f.root, 'explicit-acceptance.json');
  await fs.rename(f.receiptPath, record); await write(acceptance, f.acceptance);
  const result = await resolveWorkbenchNativeRuntime({ ...f.options, env: { ...f.options.env, BLACKICE_WORKBENCH_NATIVE_BUILD_RECEIPT: record, BLACKICE_WORKBENCH_NATIVE_ACCEPTANCE: acceptance } });
  assert.equal(result.accepted, true);
  await fs.appendFile(f.helperPath, 'tamper');
  await assert.rejects(resolveWorkbenchNativeRuntime({ ...f.options, env: { ...f.options.env, BLACKICE_WORKBENCH_NATIVE_BUILD_RECEIPT: record } }), { code: 'WORKBENCH_NATIVE_BUILD' });
});
