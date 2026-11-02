import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyFreeRdpRuntime } from '../scripts/package-workbench-freerdp.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const CHECKS = ['sameConsolePixels', 'inputOwnership', 'noHostActivation', 'motionAndLatency', 'lifecycle'];
const ICON_BINDINGS = {
  svgSha256: 'desktop/workbench-icon.svg',
  pngSha256: 'desktop/workbench-icon.png',
  icoSha256: 'desktop/workbench-icon.ico',
  manifestSha256: 'desktop/workbench-icon.manifest.json',
  rcSha256: 'scripts/workbench-freerdp-client/workbench-icon.rc',
  buildScriptSha256: 'scripts/build-workbench-freerdp-client.ps1',
  iconBuilderSha256: 'desktop/build-icon.mjs',
  windresSha256: '.build/workbench-freerdp-compiler/msys64/ucrt64/bin/windres.exe',
};
const JSON_LIMIT = 1024 * 1024;
const messages = {
  WORKBENCH_NATIVE_BUILD: 'The native display build could not be verified. Rebuild or reinstall its verified components.',
  WORKBENCH_NATIVE_ACCEPTANCE: 'The native display verification record does not match this build.',
  WORKBENCH_NATIVE_UNAVAILABLE: 'The verified native display is not available in this installation.',
};
const fail = code => Object.assign(new Error(messages[code]), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const absolute = value => typeof value === 'string' && value.length <= 32768 && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);

function relativePath(root, value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f:]/.test(value) || path.isAbsolute(value) || path.win32.isAbsolute(value)) throw fail('WORKBENCH_NATIVE_BUILD');
  const parts = value.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..')) throw fail('WORKBENCH_NATIVE_BUILD');
  const target = path.resolve(root, ...parts), relative = path.relative(root, target);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fail('WORKBENCH_NATIVE_BUILD');
  return target;
}

/** Resolve verified bytes and acceptance evidence only. This function never starts a viewer. */
export async function resolveWorkbenchNativeRuntime({
  appDirectory, resourcesDirectory, isPackaged = false, env = process.env,
  verifyRuntime = verifyFreeRdpRuntime, fs = fsPromises,
} = {}) {
  if (!absolute(appDirectory) || isPackaged && !absolute(resourcesDirectory)) throw fail('WORKBENCH_NATIVE_UNAVAILABLE');
  const appRoot = path.resolve(appDirectory);
  const initialBuildCode = 'WORKBENCH_NATIVE_BUILD';

  async function ordinary(file, kind, code = initialBuildCode) {
    if (!absolute(file)) throw fail(code);
    const chain = [];
    for (let cursor = path.resolve(file); ; cursor = path.dirname(cursor)) {
      chain.push(cursor); if (cursor === path.dirname(cursor)) break;
    }
    for (let index = chain.length - 1; index >= 0; index--) {
      let stat; try { stat = await fs.lstat(chain[index]); } catch (error) { if (error.code === 'ENOENT') throw error; throw fail(code); }
      if (stat.isSymbolicLink() || (index === 0 ? kind === 'file' ? !stat.isFile() : !stat.isDirectory() : !stat.isDirectory())) throw fail(code);
    }
    return fs.lstat(file);
  }
  const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
  async function fileOperation(file, { json = false, code = initialBuildCode } = {}) {
    let handle;
    try {
      const before = await ordinary(file, 'file', code);
      if (json && before.size > JSON_LIMIT || !json && before.size > 256 * 1024 * 1024) throw fail(code);
      handle = await fs.open(file, 'r');
      const opened = await handle.stat(); if (!opened.isFile() || !identity(before, opened)) throw fail(code);
      let result;
      if (json) {
        const chunks = [], buffer = Buffer.alloc(64 * 1024); let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, JSON_LIMIT + 1 - position), position);
          if (!bytesRead) break;
          position += bytesRead; if (position > JSON_LIMIT) throw fail(code);
          chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!object(result)) throw fail(code);
      } else {
        const hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024);
        let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          position += bytesRead; if (position > 256 * 1024 * 1024) throw fail(code);
          hash.update(buffer.subarray(0, bytesRead));
        }
        result = hash.digest('hex');
      }
      const after = await fs.lstat(file);
      if (after.isSymbolicLink() || !after.isFile() || !identity(opened, await handle.stat()) || !identity(opened, after)) throw fail(code);
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      throw fail(code);
    } finally { try { await handle?.close(); } catch {} }
  }
  async function json(file, code, optional = false) {
    try { return await fileOperation(file, { json: true, code }); }
    catch (error) { if (error.code === 'ENOENT' && optional) return null; throw error.code === 'ENOENT' ? fail(code) : error; }
  }
  async function hash(file, expected, code = initialBuildCode) {
    if (!SHA256.test(expected ?? '')) throw fail(code);
    let actual; try { actual = await fileOperation(file, { code }); } catch { throw fail(code); }
    if (actual !== expected) throw fail(code);
    return actual;
  }
  async function ordinaryTree(root) {
    let count = 0;
    async function visit(directory, depth) {
      if (depth > 24 || ++count > 10000) throw fail(initialBuildCode);
      await ordinary(directory, 'directory');
      const names = await fs.readdir(directory);
      for (const name of names) {
        if (++count > 10000) throw fail(initialBuildCode);
        const target = path.join(directory, name), stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) throw fail(initialBuildCode);
        if (stat.isDirectory()) await visit(target, depth + 1);
        else if (!stat.isFile()) throw fail(initialBuildCode);
      }
    }
    try { await visit(root, 0); } catch { throw fail(initialBuildCode); }
  }

  let helperPath, helperSha256, runtimeRoot, runtimeManifestSha256, lockPath, acceptancePath, mode;
  const bindings = [];
  if (isPackaged) {
    mode = 'packaged';
    const folder = path.resolve(resourcesDirectory, 'workbench-native');
    const descriptorPath = path.join(folder, 'native-display.json');
    const descriptor = await json(descriptorPath, 'WORKBENCH_NATIVE_BUILD', true);
    if (!descriptor) throw fail('WORKBENCH_NATIVE_UNAVAILABLE');
    if (descriptor.schema !== 1 || Object.keys(descriptor).some(key => !['schema', 'helper', 'helperSha256', 'runtime', 'runtimeManifestSha256', 'dependencyLock', 'dependencyLockSha256', 'acceptance'].includes(key))) throw fail(initialBuildCode);
    helperPath = relativePath(folder, descriptor.helper);
    runtimeRoot = relativePath(folder, descriptor.runtime);
    lockPath = relativePath(folder, descriptor.dependencyLock);
    acceptancePath = relativePath(folder, descriptor.acceptance);
    helperSha256 = descriptor.helperSha256; runtimeManifestSha256 = descriptor.runtimeManifestSha256;
    bindings.push([lockPath, descriptor.dependencyLockSha256]);
  } else {
    mode = 'development';
    const explicit = env.BLACKICE_WORKBENCH_NATIVE_BUILD_RECEIPT;
    if (explicit !== undefined && !absolute(explicit)) throw fail(initialBuildCode);
    const receiptPath = explicit ? path.resolve(explicit) : path.join(appRoot, '.build/workbench-freerdp-client-build.json');
    const receipt = await json(receiptPath, initialBuildCode, true);
    if (!receipt) throw fail('WORKBENCH_NATIVE_UNAVAILABLE');
    const allowed = ['schema', 'source', 'executable', 'sha256', 'runtimeDirectory', 'freerdpVersion', 'compilerVersion', 'selfTest', 'liveVmVerified', 'sourceSha256', 'compilerLockSha256', 'runtimeLockSha256', 'runtimeManifestSha256'];
    const source = path.join(appRoot, 'scripts/workbench-freerdp-client/main.cpp');
    const selfTest = receipt.selfTest;
    if (receipt.schema !== 2 || Object.keys(receipt).some(key => !allowed.includes(key)) || !absolute(receipt.source) || !samePath(receipt.source, source) || !absolute(receipt.executable) || !absolute(receipt.runtimeDirectory) || receipt.freerdpVersion !== '3.32.2' || !/^\d+\.\d+\.\d+$/.test(receipt.compilerVersion ?? '') || !object(selfTest) || selfTest.selfTest !== true || selfTest.networkStarted !== false || selfTest.foregroundUnchanged !== true || selfTest.digestReady !== true || selfTest.vmConnectProtocolVerified !== true || 'ok' in selfTest && selfTest.ok !== true) throw fail(initialBuildCode);
    const icon = selfTest.iconResource;
    if (selfTest.iconResourcePresent !== true || !object(icon) || icon.resourceId !== 101 ||
      Object.keys(icon).length !== Object.keys(ICON_BINDINGS).length + 1 ||
      Object.keys(icon).some(key => key !== 'resourceId' && !Object.hasOwn(ICON_BINDINGS, key)) ||
      Object.keys(ICON_BINDINGS).some(key => !SHA256.test(icon[key] ?? ''))) throw fail(initialBuildCode);
    helperPath = path.resolve(receipt.executable); helperSha256 = receipt.sha256;
    runtimeRoot = path.resolve(receipt.runtimeDirectory); runtimeManifestSha256 = receipt.runtimeManifestSha256;
    lockPath = path.join(appRoot, 'docs/workbench-freerdp-dependencies.lock.json');
    bindings.push([source, receipt.sourceSha256], [path.join(appRoot, 'docs/workbench-freerdp-compiler.lock.json'), receipt.compilerLockSha256], [lockPath, receipt.runtimeLockSha256]);
    for (const [key, relative] of Object.entries(ICON_BINDINGS)) bindings.push([path.join(appRoot, relative), icon[key]]);
    const explicitAcceptance = env.BLACKICE_WORKBENCH_NATIVE_ACCEPTANCE;
    if (explicitAcceptance !== undefined && !absolute(explicitAcceptance)) throw fail('WORKBENCH_NATIVE_ACCEPTANCE');
    acceptancePath = explicitAcceptance ? path.resolve(explicitAcceptance) : path.join(appRoot, '.build/workbench-native-acceptance.json');
  }

  await hash(helperPath, helperSha256);
  const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
  await json(manifestPath, initialBuildCode);
  await hash(manifestPath, runtimeManifestSha256);
  for (const [file, expected] of bindings) await hash(file, expected);
  await ordinaryTree(runtimeRoot);
  try { await ordinary(path.join(runtimeRoot, 'bin'), 'directory'); } catch { throw fail(initialBuildCode); }
  const windows = env.SystemRoot || env.WINDIR;
  if (!absolute(windows)) throw fail('WORKBENCH_NATIVE_UNAVAILABLE');
  try { if (await verifyRuntime({ outputDirectory: runtimeRoot, lockPath, systemDirectory: path.join(windows, 'System32') }) === false) throw fail(initialBuildCode); }
  catch { throw fail(initialBuildCode); }
  // Refuse bindings that changed while the dependency verifier was running.
  await hash(helperPath, helperSha256); await hash(manifestPath, runtimeManifestSha256);
  for (const [file, expected] of bindings) await hash(file, expected);

  const acceptance = await json(acceptancePath, 'WORKBENCH_NATIVE_ACCEPTANCE', true);
  const acceptanceChecks = Object.fromEntries(CHECKS.map(key => [key, false]));
  let timingBasis = null;
  if (acceptance) {
    if (acceptance.schema !== 1 || acceptance.scope !== 'local-preview' || acceptance.helperSha256 !== helperSha256 || acceptance.runtimeManifestSha256 !== runtimeManifestSha256) throw fail('WORKBENCH_NATIVE_ACCEPTANCE');
    for (const key of CHECKS) acceptanceChecks[key] = object(acceptance.checks) && acceptance.checks[key] === true;
    timingBasis = acceptance.timingBasis === 'decoded-surface' ? 'decoded-surface' : null;
  }
  const accepted = CHECKS.every(key => acceptanceChecks[key]) && timingBasis === 'decoded-surface';
  return {
    helperPath, helperSha256, runtimeDirectory: path.join(runtimeRoot, 'bin'), runtimeRoot,
    runtimeManifestSha256, accepted, detachedControls: accepted && acceptance?.detachedControls === true,
    acceptanceChecks, timingBasis, mode, acceptanceScope: 'local-preview', preview: true, fullAcceptance: false,
  };
}
