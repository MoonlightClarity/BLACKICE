#!/usr/bin/env node
// Deliberate live verification, separate from the product's fenced native API.
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const repo = fileURLToPath(new URL('../', import.meta.url));
const executeFile = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = message => Object.assign(new Error(message), {code: 'WORKBENCH_NATIVE_MEASUREMENT'});
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sha = /^[a-f0-9]{64}$/;
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export const HELP = `Measure an existing running Workbench guest (Windows x64, Node.js 22+).

  node verification/measure-workbench-native-session.mjs --live
    [--source-dir ABSOLUTE_PATH] [--app-dir ABSOLUTE_PATH]
    [--profile-dir ABSOLUTE_PATH] [--workspace ABSOLUTE_PATH]
    [--output-dir ABSOLUTE_PATH] [--build-receipt ABSOLUTE_PATH]
    [--run-id UNIQUE_ID] [--frame-interval-ms 8..100]

--live is required. This launches one guest-only 30-second fixture and a hidden
native helper, measures 5 seconds of unique guest paints and 30 marker clicks,
then requires the fixture's closed receipt. It never takes/cedes control or
starts, recreates, configures, or stops a VM. Agent ownership must already hold.
Source defaults to this repository, profile to BLACKICE's Relay user-data folder,
app to the running profile's executable/resources/app, workspace to Workbench's
configured primary share, and output to <source>/.build/native-verification/<id>.
The standalone helper polls ownership and stops on any change; this has a
check-to-send race. Product input must use /api/workbench/native/input instead.
Timing is host submission to changed decoded pixels, not physical photons.
The guest frame interval defaults to 33 ms. Sampling awaits back-to-back native
receipts for at most five seconds or 100000 samples; no timer adds observer delay.
`;

export function parseOptions(argv, {sourceDirectory = repo, env = process.env, home = os.homedir(), platform = process.platform} = {}) {
  const options = {}, seen = new Set();
  const values = new Set(['source-dir', 'app-dir', 'profile-dir', 'workspace', 'output-dir', 'build-receipt', 'run-id', 'frame-interval-ms']);
  for (let index = 0; index < argv.length; index++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[index]);
    if (!match || seen.has(match[1])) throw fail('Use each supported option once. See --help.');
    const key = match[1]; seen.add(key);
    if (key === 'help' || key === 'live') {
      if (match[2] !== undefined) throw fail(`Use --${key} without a value.`);
      options[key] = true; continue;
    }
    if (!values.has(key)) throw fail('Unsupported measurement option. See --help.');
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) throw fail(`Supply a value for --${key}.`);
    if (key === 'frame-interval-ms') {
      if (!/^(?:[8-9]|[1-9]\d|100)$/.test(value)) throw fail('Frame interval must be an integer from 8 to 100 milliseconds.');
      options[key] = Number(value); continue;
    }
    if (key !== 'run-id' && !path.isAbsolute(value)) throw fail(`Use an absolute path for --${key}.`);
    options[key] = value;
  }
  if (options.help) return {help: true};
  if (options.live !== true) throw fail('Live guest execution is disabled. Read --help, then supply --live deliberately.');
  options['run-id'] ??= `native_${randomUUID().replaceAll('-', '')}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options['run-id'])) throw fail('Choose a unique RunId of 1–64 letters, digits, underscores or hyphens.');
  options['source-dir'] ??= sourceDirectory;
  options['profile-dir'] ??= platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Relay') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Relay') : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Relay');
  options['build-receipt'] ??= path.join(options['source-dir'], '.build', 'workbench-freerdp-client-build.json');
  options['output-dir'] ??= path.join(options['source-dir'], '.build', 'native-verification', options['run-id']);
  options['frame-interval-ms'] ??= 33;
  return options;
}

/** Reject a stale build before any native process or guest action. Paths are
 * bound by the local build receipt, while source/locks come from this checkout. */
export async function verifyBuild(options) {
  const source = options['source-dir'];
  const receiptBytes = await fs.readFile(options['build-receipt']);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  const expectedSource = path.join(source, 'scripts', 'workbench-freerdp-client', 'main.cpp');
  if (receipt.schema !== 2 || !path.isAbsolute(receipt.executable || '') || !path.isAbsolute(receipt.runtimeDirectory || '') ||
      !path.isAbsolute(receipt.source || '') || !samePath(receipt.source, expectedSource) ||
      receipt.selfTest?.selfTest !== true || receipt.selfTest.networkStarted !== false ||
      receipt.selfTest.digestReady !== true || receipt.selfTest.foregroundUnchanged !== true ||
      receipt.selfTest.vmConnectProtocolVerified !== true) throw fail('A current successful schema-2 native build/self-test receipt is required. Rebuild the helper.');
  const bindings = {
    helperSha256: [receipt.executable, receipt.sha256], sourceSha256: [expectedSource, receipt.sourceSha256],
    compilerLockSha256: [path.join(source, 'docs', 'workbench-freerdp-compiler.lock.json'), receipt.compilerLockSha256],
    runtimeLockSha256: [path.join(source, 'docs', 'workbench-freerdp-dependencies.lock.json'), receipt.runtimeLockSha256],
    runtimeManifestSha256: [path.join(receipt.runtimeDirectory, 'runtime-manifest.json'), receipt.runtimeManifestSha256],
  };
  const hashes = {buildReceiptSha256: sha256(receiptBytes)};
  for (const [key, [file, expected]] of Object.entries(bindings)) {
    if (!sha.test(expected || '') || sha256(await fs.readFile(file)) !== expected) throw fail(`Build binding changed: ${key}. Rebuild before measuring.`);
    hashes[key] = expected;
  }
  return {receipt, hashes};
}

export function validatePreflight(value, vmName, now = Date.now()) {
  if (value?.version !== 1 || value.readyForBoundedProbe !== true || value.vmName !== vmName || value.vmState !== 'Running' ||
      value.host !== '127.0.0.1' || value.port !== 2179 || value.listenerOwnedByVmms !== true ||
      !guid.test(value.vmId || '') || !sha.test(value.certificateSha256 || '') || !value.certificates?.some(c =>
        c.sha256 === value.certificateSha256 && c.source === 'local-vmms-service-certificate-store' && Date.parse(c.notAfter) > now))
    throw fail('The existing running VM, VMMS listener and independent public certificate pin could not be verified.');
  return {vmId: value.vmId, host: value.host, port: value.port, certificateSha256: value.certificateSha256};
}

/** Sticky fail-stop guard: even Take followed by Cede cancels this run. This
 * monitoring is intentionally not represented as the production input fence. */
export class OwnershipGuard {
  constructor(request, onLost = () => {}, intervalMs = 100) {
    this.request = request; this.onLost = onLost; this.intervalMs = intervalMs;
    this.revision = null; this.lost = null; this.stopped = true; this.timer = null; this.inFlight = null;
  }
  assert() { if (this.lost) throw this.lost; }
  async check() {
    this.assert();
    try {
      const state = await this.request('/api/workbench');
      this.assert();
      const control = state.consoleControl;
      if (control?.owner !== 'agent' || !Number.isSafeInteger(control.revision) || control.revision < 0 ||
          this.revision !== null && control.revision !== this.revision) throw fail('Guest input ownership changed or is unavailable. This measurement is cancelled; no automatic Take/Cede occurs.');
      this.revision ??= control.revision;
      return state;
    } catch (error) {
      if (!this.lost) { this.lost = fail('Guest input ownership could not be preserved. Measurement stopped.'); this.lost.cause = error; await this.onLost(this.lost); }
      throw this.lost;
    }
  }
  async start() {
    await this.check(); this.stopped = false;
    const poll = () => {
      if (this.stopped || this.lost) return;
      this.inFlight = this.check().catch(() => {}).finally(() => { if (!this.stopped && !this.lost) this.timer = setTimeout(poll, this.intervalMs); });
    };
    this.timer = setTimeout(poll, this.intervalMs);
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.inFlight; }
}

export function counterCrc32(counter) {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > 0xffffffff) throw fail('A uint32 counter is required.');
  let crc=0xffffffff;
  for (let index=0;index<4;index++) {
    crc^=(counter >>> (index*8)) & 0xff;
    for (let bit=0;bit<8;bit++) crc=(crc >>> 1)^((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function decodeFrameCounter(points,{requireChecksum=false}={}) {
  if (!Array.isArray(points) || (requireChecksum ? points.length !== 64 : ![32,64].includes(points.length)) || points.some(pixel => !pixel ||
      ![24, 245].some(value => ['r', 'g', 'b'].every(channel => Number.isFinite(pixel[channel]) && Math.abs(pixel[channel] - value) < 12)))) return null;
  const decode = row => row.reduce((value, pixel, bit) => value + (pixel.r >= 128 ? 2 ** bit : 0), 0);
  const counter=decode(points.slice(0,32));
  return points.length===64&&decode(points.slice(32))!==counterCrc32(counter) ? null : counter;
}
export function hasIntegrityCounter(metadata) {
  const counter=metadata?.binaryFrameCounter,checksum=counter?.checksum;
  return counter?.bits===32&&counter.bitOrder==='least-significant-first'&&counter.valueType==='uint32'&&
    checksum?.algorithm==='crc32-ieee'&&checksum.inputEncoding==='uint32-little-endian'&&checksum.bits===32&&checksum.pointOffset===32&&
    checksum.polynomial==='0xEDB88320'&&checksum.initial==='0xFFFFFFFF'&&checksum.xorOut==='0xFFFFFFFF'&&checksum.bitOrder==='least-significant-first'&&
    Array.isArray(counter.samplePoints)&&counter.samplePoints.length===64&&counter.samplePoints.every((point,index)=>
      point?.role===(index<32?'counter':'checksum')&&point.bit===index%32&&
      Number.isSafeInteger(point.screenPoint?.x)&&point.screenPoint.x>=0&&Number.isSafeInteger(point.screenPoint?.y)&&point.screenPoint.y>=0);
}
export function summarizeClicks(clicks) {
  const latencies = clicks.filter(c => c.observed && Number.isFinite(c.latencyMs)).map(c => c.latencyMs).sort((a, b) => a - b);
  const percentile = fraction => latencies.length ? latencies[Math.ceil(latencies.length * fraction) - 1] : null;
  return {attempts: clicks.length, verified: latencies.length, p50Ms: percentile(.5), p95Ms: percentile(.95),
    timing: 'host submission to changed pixel in decoded RDP surface', timingBasis: 'decoded-surface', physicalInputToPhoton: false};
}

/** CRC32(0xFFFFFFFF) is also 0xFFFFFFFF: white startup pixels can therefore
 * satisfy the checksum. Require this 30-second fixture's bounded counter and
 * both untouched amber panels from the same native frame before measuring. */
export function assessFixtureStartupSample(receipt,{frameIntervalMs}={}) {
  if(!Number.isSafeInteger(frameIntervalMs)||frameIntervalMs<8||frameIntervalMs>100)throw fail('Fixture readiness requires its validated frame interval.');
  const maximumCounter=Math.ceil(30000/frameIntervalMs)+1;
  if(!Array.isArray(receipt?.points)||receipt.points.length!==66)return {ready:false,reason:'sample-shape',maximumCounter};
  if(!Number.isSafeInteger(receipt.counterSequence)||receipt.counterSequence<0||receipt.counterSequence!==receipt.markerSequence||receipt.sequence!==receipt.counterSequence)
    return {ready:false,reason:'native-frame-changed',maximumCounter};
  const counter=decodeFrameCounter(receipt.points.slice(0,64),{requireChecksum:true});
  if(counter===null)return {ready:false,reason:'counter-integrity',maximumCounter};
  if(counter>maximumCounter)return {ready:false,reason:'counter-out-of-fixture-range',maximumCounter};
  const amber={r:255,g:176,b:0};
  if(!receipt.points.slice(64).every(pixel=>pixel&&['r','g','b'].every(key=>Number.isFinite(pixel[key])&&Math.abs(pixel[key]-amber[key])<12)))
    return {ready:false,reason:'fixture-marker-colors',maximumCounter};
  return {ready:true,counter,maximumCounter,nativeSequence:receipt.sequence};
}
/** The protocol permits 64 points: read the two panels, then 64 CRC points.
 * Equal native sequence binds both locked reads to the same decoded bitmap. */
export async function sampleFixtureStartup({sample,points,markerPoints,timeoutMs=500,assertCurrent=()=>{}}={}) {
  if(typeof sample!=='function'||!Array.isArray(points)||points.length!==64||!Array.isArray(markerPoints)||markerPoints.length!==2||
    typeof assertCurrent!=='function')throw fail('Startup sampling requires64 counter and2 marker points.');
  assertCurrent();const markers=await sample(markerPoints,timeoutMs);assertCurrent();
  const counter=await sample(points,timeoutMs);assertCurrent();
  return {sequence:counter?.sequence,counterSequence:counter?.sequence,markerSequence:markers?.sequence,
    points:[...(Array.isArray(counter?.points)?counter.points:[]),...(Array.isArray(markers?.points)?markers.points:[])]};
}
export async function waitForFixtureStartup({sample,frameIntervalMs,assertCurrent=()=>{},now=()=>performance.now(),timeoutMs=3000,maxSamples=10000}={}) {
  if(typeof sample!=='function'||typeof assertCurrent!=='function'||typeof now!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>3000||
    !Number.isSafeInteger(maxSamples)||maxSamples<1||maxSamples>10000)throw fail('Fixture readiness requires bounded native samples.');
  assessFixtureStartupSample(null,{frameIntervalMs});
  const start=now(),rejections={};let samples=0,last;
  while(now()-start<timeoutMs&&samples<maxSamples){
    assertCurrent();const receipt=await sample(Math.max(100,Math.min(500,Math.ceil(timeoutMs-(now()-start)))));assertCurrent();samples++;
    last=assessFixtureStartupSample(receipt,{frameIntervalMs});
    if(last.ready)return {...last,durationMs:now()-start,samples,rejections,checksumRequired:true,markerColors:['#FFB000','#FFB000'],
      sampling:'2 marker points then64 counter points, identical native frame sequence required',requestedTimeoutMs:timeoutMs};
    rejections[last.reason]=(rejections[last.reason]||0)+1;
  }
  return {ready:false,durationMs:now()-start,samples,rejections,maximumCounter:last?.maximumCounter,
    checksumRequired:true,requestedTimeoutMs:timeoutMs,sampleBoundReached:samples>=maxSamples};
}

/** Count distinct decoded guest counters, not repeated bitmap transactions.
 * A single awaited request is outstanding; the native receipt supplies pacing. */
export async function observeMotion({sample, assertCurrent = () => {}, now = () => performance.now(), durationMs = 5000, maxSamples = 100000}) {
  if (typeof sample !== 'function' || typeof assertCurrent !== 'function' || typeof now !== 'function' ||
      !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 5000 ||
      !Number.isSafeInteger(maxSamples) || maxSamples < 1 || maxSamples > 100000) throw fail('Motion observation requires bounded sample receipts.');
  const start = now(), observations = [], intervals = [];
  let last = -1, previousAt = null, invalidSamples = 0, totalSamples = 0, counterRegressions = 0;
  while (now() - start < durationMs && totalSamples < maxSamples) {
    assertCurrent();
    const remainingMs = Math.max(1, Math.ceil(durationMs - (now() - start)));
    // A tiny final remaining interval must not manufacture a pipe timeout for
    // an otherwise healthy local reply; no new sample starts after the window.
    const receipt = await sample(Math.max(100, remainingMs)), at = now();
    assertCurrent(); totalSamples++;
    if (previousAt !== null) intervals.push(at - previousAt);
    previousAt = at;
    const value = decodeFrameCounter(receipt?.points,{requireChecksum:true});
    if (value === null) invalidSamples++;
    else if (value > last) { observations.push({frame: value, atMs: at - start, nativeSequence: receipt.sequence}); last = value; }
    else if (value < last) {counterRegressions++;invalidSamples++;}
  }
  const elapsedMs = now() - start, sorted = intervals.sort((a, b) => a - b);
  const percentile = fraction => sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
  const firstCounter = observations[0]?.frame, lastCounter = observations.at(-1)?.frame;
  const counterSpan = observations.length ? lastCounter - firstCounter + 1 : 0;
  return {durationMs: elapsedMs, totalSamples, invalidSamples, samplesPerSecond: elapsedMs > 0 ? totalSamples / (elapsedMs / 1000) : 0,
    metric: 'checksum-valid decoded markers', integrity: {valid: counterRegressions === 0, checksumRequired: true,
      algorithm: 'crc32-ieee-uint32-le', wholeDesktopAtomicityProven: false},
    sampleIntervals: {count: sorted.length, minMs: sorted[0] ?? null, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.at(-1) ?? null},
    observer: {strategy: 'back-to-back native sample receipts',integrity: 'crc32-ieee-uint32-le',requestedDurationMs: durationMs,maxSamples,sampleBoundReached: totalSamples >= maxSamples && elapsedMs < durationMs},
    uniqueGuestFrames: observations.length, observedFramesPerSecond: elapsedMs > 0 ? observations.length / (elapsedMs / 1000) : 0,
    firstCounter, lastCounter, counterSpan, unobservedCounterValues: counterSpan - observations.length, counterRegressions, observations};
}

function nativeClient(helper, runtime, runId, windows) {
  const bin = path.join(runtime, 'bin');
  // No inherited credential/token/provider variables, compiler or toolchain PATH.
  const env = {SystemRoot: windows, WINDIR: windows, PATH: [bin, path.join(windows, 'System32'), windows].join(path.delimiter),
    TEMP: os.tmpdir(), TMP: os.tmpdir(), WINPR_NATIVE_SSPI: '1',
    OPENSSL_CONF: path.join(runtime, 'etc', 'ssl', 'openssl.cnf'), OPENSSL_MODULES: path.join(runtime, 'lib', 'ossl-modules')};
  const child = spawn(helper, ['--stream-test-parent'], {cwd: bin, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env});
  let buffer = '', sequence = 0, ended = false, stderrBytes = 0;
  const pending = new Map(), stderrHash = createHash('sha256');
  const rejectAll = error => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error); } pending.clear(); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1_000_000) { rejectAll(fail('The helper exceeded its protocol output bound.')); child.kill(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
      let reply; try { reply = JSON.parse(line); } catch { rejectAll(fail('The helper returned invalid NDJSON.')); child.kill(); return; }
      const value = pending.get(reply.requestId);
      if (value) { pending.delete(reply.requestId); clearTimeout(value.timer); value.resolve(reply); }
    }
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; stderrHash.update(chunk); });
  child.stdin.on('error', () => rejectAll(fail('The native helper input stream closed.')));
  child.on('error', () => rejectAll(fail('The verified native helper could not be started.')));
  child.on('exit', () => { ended = true; rejectAll(fail('The native helper exited.')); });
  const command = (action, args = {}, timeout = 5000) => new Promise((resolve, reject) => {
    if (ended) { reject(fail('The native helper is closed.')); return; }
    const requestId = `${runId}-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(requestId); reject(fail(`No bounded helper receipt for ${action}.`)); }, timeout);
    pending.set(requestId, {resolve, reject, timer});
    child.stdin.write(JSON.stringify({requestId, action, ...args}) + '\n');
  });
  const call = async (action, args, timeout) => {
    const response = await command(action, args, timeout);
    if (!response.ok) throw fail(`The helper rejected ${action}: ${String(response.error || response.code || 'unavailable').slice(0, 300)}`);
    return response.result;
  };
  let closing;
  const close = () => closing ??= (async () => {
    let result; try { result = await call('close', {}, 5000); } finally { child.stdin.end(); child.kill(); rejectAll(fail('Measurement ended.')); }
    // Preserve the receipt envelope consumed by the preview evidence recorder.
    return {ok: true, result};
  })();
  return {call, command, close, diagnosticSummary: () => ({stderrBytes, stderrSha256: stderrHash.copy().digest('hex'), rawStderrOmitted: true})};
}

function validateMetadata(value, runId, sessionId) {
  if (value?.format !== 1 || value.fixture !== 'blackice-native-motion' || value.runId !== runId || value.guestSessionId !== sessionId ||
      !Number.isSafeInteger(value.processId) || value.processId <= 0 || !['running', 'closed'].includes(value.phase)) throw fail('Fixture metadata does not match this run and the paired interactive guest session.');
  return value;
}
async function readMetadata(file, runId, sessionId) {
  let bytes; try { bytes = await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (bytes.length > 2_000_000) throw fail('Guest fixture metadata exceeded its bound.');
  return validateMetadata(JSON.parse(bytes.toString('utf8')), runId, sessionId);
}

export async function measure(options) {
  // Remain inert even when imported/called without the command-line parser.
  if (options?.live !== true) throw fail('Explicit --live opt-in is required.');
  const frameIntervalMs = options['frame-interval-ms'] ?? 33;
  if (!Number.isSafeInteger(frameIntervalMs) || frameIntervalMs < 8 || frameIntervalMs > 100) throw fail('Frame interval must be an integer from 8 to 100 milliseconds.');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw fail('Live native verification requires Windows x64.');
  const source = options['source-dir'], runId = options['run-id'], output = options['output-dir'];
  const {receipt, hashes} = await verifyBuild(options);
  const desktopRuntime = JSON.parse(await fs.readFile(path.join(options['profile-dir'], 'desktop-runtime.json'), 'utf8'));
  const appDirectory = options['app-dir'] || path.join(path.dirname(desktopRuntime.executable), 'resources', 'app');
  const cliPath = path.join(appDirectory, 'lib', 'browser-cli.mjs');
  const {connectBrowserCLI} = await import(pathToFileURL(cliPath).href);
  const {request} = await connectBrowserCLI({'profile-dir': options['profile-dir']}, {
    expectedExecutable: desktopRuntime.executable,
    fetchImpl: (url, init) => fetch(url, {...init, signal: AbortSignal.timeout(15000)}),
  });
  let client;
  const guard = new OwnershipGuard(request, async () => { if (client) await client.close().catch(() => {}); });
  const state = await guard.check();
  const folder = state.config?.folders?.find(value => value.id === 'workspace');
  if (!state.guest?.exists || !state.guest.running || !state.guest.agent?.paired || !folder?.guestMountVerified ||
      !Number.isSafeInteger(state.guest.agent.guestSessionId) || state.guest.agent.guestSessionId <= 0 ||
      state.guest.agent.expectedGuestRoot?.replaceAll('/', '\\').replace(/\\+$/, '').toUpperCase() !== 'W:')
    throw fail('An existing running, paired interactive guest with its verified W: workspace is required. No VM setup or lifecycle operation was attempted.');
  const workspace = options.workspace || folder.hostPath;
  if (!path.isAbsolute(workspace || '') || !samePath(workspace, folder.hostPath)) throw fail('--workspace must match the existing Workbench primary shared folder.');
  const bridgeRoot = path.join(workspace, '.blackice-workbench');
  const hostInfo = JSON.parse(await fs.readFile(path.join(bridgeRoot, 'host-info.json'), 'utf8'));
  if (hostInfo.version !== 1 || hostInfo.hostName !== state.capability?.hostName) throw fail('The configured share host identity does not match Workbench.');
  const windows = process.env.SystemRoot || process.env.WINDIR;
  if (!windows || !path.isAbsolute(windows)) throw fail('The Windows system directory could not be resolved.');
  const {verifyFreeRdpRuntime} = await import(pathToFileURL(path.join(source, 'scripts', 'package-workbench-freerdp.mjs')).href);
  await verifyFreeRdpRuntime({outputDirectory: receipt.runtimeDirectory, lockPath: path.join(source, 'docs', 'workbench-freerdp-dependencies.lock.json'), systemDirectory: path.join(windows, 'System32')});
  const preflightScript = path.join(source, 'scripts', 'workbench-native-host-preflight.ps1');
  const psEnv = {...process.env}; delete psEnv.PSModulePath;
  const discovered = await executeFile(path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', preflightScript, '-VmName', state.config.vmName],
    {windowsHide: true, timeout: 30000, maxBuffer: 100000, env: psEnv});
  const identity = validatePreflight(JSON.parse(discovered.stdout.trim()), state.config.vmName);
  const fixtureSource = path.join(source, 'verification', 'workbench-native-motion-fixture.ps1');
  const fixtureBytes = await fs.readFile(fixtureSource), fixtureName = `native-motion-fixture-${runId}.ps1`;
  const verification = path.join(bridgeRoot, 'verification');
  const metadata = path.join(verification, `native-motion-${runId}.json`), finalMetadata = path.join(verification, `native-motion-${runId}.final.json`);
  // Output ownership is exclusive: never overwrite an earlier report or fixture.
  await fs.mkdir(path.dirname(output), {recursive: true}); await fs.mkdir(output);
  const report = {schema: 1, scope: 'standalone-local-preview', fullAcceptance: false, runId, startedAt: new Date().toISOString(),
    measurement: 'native decoded surface; not physical input-to-photon', requestedFrameIntervalMs: frameIntervalMs,
    paths: {source, appDirectory, workspace, output},
    ...hashes, measurementSourceSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
    fixtureSourceSha256: sha256(fixtureBytes), cliSourceSha256: sha256(await fs.readFile(cliPath)),
    preflightSourceSha256: sha256(await fs.readFile(preflightScript)), preflight: identity, guestSessionId: state.guest.agent.guestSessionId,
    ownership: {initialOwner: 'agent', initialRevision: guard.revision, monitoringIntervalMs: 100, checkBeforeEveryInput: true,
      atomicWithServerInputQueue: false, limitation: 'Standalone polling has a check-to-send race. Product input uses the serialized native/input server endpoint.'}, clicks: []};
  let fixtureLaunched = false, interrupted = false;
  const interrupt = () => { interrupted = true; guard.lost ??= fail('The measurement was interrupted.'); if (client) void client.close().catch(() => {}); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    await fs.mkdir(verification, {recursive: true});
    for (const file of [metadata, finalMetadata]) { try { await fs.access(file); throw fail('RunId already has fixture metadata. Choose a fresh RunId.'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    const stagedFixture = path.join(verification, fixtureName);
    await fs.writeFile(stagedFixture, fixtureBytes, {flag: 'wx'});
    if (sha256(await fs.readFile(stagedFixture)) !== report.fixtureSourceSha256) throw fail('The shared fixture copy did not match the repository source.');
    report.fixtureScript = stagedFixture;
    await guard.start();
    // Recheck all build bindings immediately before process creation.
    await verifyBuild(options); guard.assert();
    client = nativeClient(receipt.executable, receipt.runtimeDirectory, runId, windows);
    const input = async value => { await guard.check(); guard.assert(); const submittedAt = performance.now(); const result = await client.call('input', value); return {result, submittedAt}; };
    report.prepare = await client.call('prepare', {parent: 'self', x: 0, y: 0, width: 640, height: 480});
    report.connect = await client.call('connect', {...identity, timeoutMs: 10000}, 15000);
    if (report.connect.connected !== true || report.connect.certificateVerified !== true || report.connect.selectedProtocol !== 2 ||
        !report.connect.surface?.width || !report.connect.surface?.height) throw fail('No verified native NLA session with a decoded guest surface was established.');
    await input({kind: 'mouse', x: Math.floor(report.connect.surface.width / 2), y: Math.floor(report.connect.surface.height / 2), flags: 0x0800});
    await guard.check(); guard.assert();
    // An HTTP admission failure can be uncertain: still await this unique
    // fixture's final receipt, and never repeat its launch with a new request.
    fixtureLaunched = true;
    report.fixtureLaunch = await request('/api/workbench/guest-command', {kind: 'launch', args: {
      appPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arguments: ['-NoLogo', '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File',
        `W:\\.blackice-workbench\\verification\\${fixtureName}`, '-RunId', runId, '-DurationSeconds', '30',
        '-FrameIntervalMilliseconds', String(frameIntervalMs)],
    }});
    const launchDeadline = performance.now() + 10000;
    while (report.fixtureLaunch?.status === 'pending' && /^[a-f0-9]{32}$/.test(report.fixtureLaunch.requestId || '') && performance.now() < launchDeadline) {
      guard.assert(); await pause(100);
      report.fixtureLaunch = await request('/api/workbench/guest-command/' + report.fixtureLaunch.requestId);
    }
    if (report.fixtureLaunch?.status !== 'completed' || report.fixtureLaunch.guestSessionId !== report.guestSessionId)
      throw fail('The fixture launch lacks a completed receipt from the paired guest session.');
    let initial; const readyBy = performance.now() + 10000;
    while (performance.now() < readyBy) { guard.assert(); initial = await readMetadata(metadata, runId, report.guestSessionId); if (initial?.phase === 'running' && hasIntegrityCounter(initial)) break; await pause(50); }
    if (initial?.phase !== 'running' || !hasIntegrityCounter(initial)) throw fail('The guest fixture did not publish a running counter with its required CRC32 integrity row.');
    if (initial.cadence?.requestedIntervalMs !== frameIntervalMs) throw fail('The guest fixture did not confirm its requested frame interval.');
    report.fixtureInitial = initial;
    const points = initial.binaryFrameCounter.samplePoints.map(value => value.screenPoint);
    if (initial.markers?.length!==2||initial.markers.some(marker=>marker.color!=='#FFB000'||marker.toggled!==false||
      !Number.isSafeInteger(marker.screenBounds?.x)||!Number.isSafeInteger(marker.screenBounds?.y)))
      throw fail('The fresh fixture must identify its two untouched amber marker panels.');
    const markerPoints=initial.markers.map(marker=>({x:marker.screenBounds.x+6,y:marker.screenBounds.y+6}));
    report.startupReadiness=await waitForFixtureStartup({sample:timeout=>sampleFixtureStartup({points,markerPoints,timeoutMs:timeout,
      sample:(samplePoints,bound)=>client.call('sample',{points:samplePoints},bound),assertCurrent:()=>guard.assert()}),
      frameIntervalMs,assertCurrent:()=>guard.assert()});
    if(!report.startupReadiness.ready)throw fail('The decoded surface did not show the bounded fixture counter and both amber markers before measurement.');
    report.motion = await observeMotion({sample: timeout => client.call('sample', {points}, timeout), assertCurrent: () => guard.assert()});
    if (initial.markers?.length !== 2) throw fail('The fixture did not publish exactly two markers.');
    for (let index = 0; index < 30; index++) {
      guard.assert(); const marker = initial.markers[index % 2];
      const point = {x: marker.screenBounds.x + 6, y: marker.screenBounds.y + 6};
      const before = (await client.call('sample', {points: [point]})).points[0];
      const amber = before.r > 200 && before.g > 100 && before.b < 80, cyan = before.r < 80 && before.g > 170 && before.b > 200;
      if (!amber && !cyan) throw fail('The decoded marker pixels did not identify this guest fixture.');
      const target = amber ? {r: 16, g: 216, b: 255} : {r: 255, g: 176, b: 0};
      await input({kind: 'mouse', ...marker.clickScreenPoint, flags: 0x0800});
      const {submittedAt} = await input({kind: 'mouse', ...marker.clickScreenPoint, flags: 0x9000});
      await input({kind: 'mouse', ...marker.clickScreenPoint, flags: 0x1000});
      let observed = false, latencyMs = null;
      while (performance.now() - submittedAt < 800) {
        guard.assert(); const pixel = (await client.call('sample', {points: [point]})).points[0];
        if (['r', 'g', 'b'].every(key => Math.abs(pixel[key] - target[key]) < 12)) { latencyMs = performance.now() - submittedAt; observed = true; break; }
        await pause(2);
      }
      report.clicks.push({index, marker: marker.id, observed, latencyMs});
      if (!observed) break;
    }
    report.input = summarizeClicks(report.clicks);
    // Diagnostic on this hidden helper only. The server remains agent-owned;
    // no Take/Cede endpoint is called. Verify the protocol rejects agent input
    // in physical-user mode, then restore its mode while the same server
    // ownership revision still holds. A failed check closes the helper.
    await input({enabled: true});
    await guard.check(); guard.assert();
    report.ownerReject = await client.command('input', {kind: 'mouse', x: Math.floor(report.connect.surface.width / 2),
      y: Math.floor(report.connect.surface.height / 2), flags: 0x0800});
    if (report.ownerReject.ok !== false || report.ownerReject.code !== 'INPUT_REJECTED') throw fail('The isolated helper did not reject agent input in user mode.');
    await input({enabled: false});
    report.nativeOwnershipDiagnostic = {isolatedHelperOnly: true, serverTakeOrCedeCalled: false, rejectedAgentInput: true};
    guard.assert();
    const capture = await client.call('capture', {path: path.join(output, 'native-surface.bmp')});
    if (capture.sha256 !== sha256(await fs.readFile(capture.path))) throw fail('The decoded capture bytes did not match their receipt.');
    report.capture = capture; report.status = await client.call('status');
  } catch (error) { report.error = error.message; }
  finally {
    // Begin native shutdown immediately; do not wait behind an outstanding
    // ownership HTTP read before disabling this separate test input path.
    const closing = client?.close();
    if (closing) closing.catch(() => {});
    await guard.stop();
    if (client) { try { report.close = await closing; } catch (error) { report.closeError = error.message; } report.diagnostics = client.diagnosticSummary(); }
    // The guest fixture owns its own close timer. Never terminate an arbitrary
    // guest process or take control to perform cleanup, including on failure.
    if (fixtureLaunched) {
      const closeBy = performance.now() + 35000;
      while (performance.now() < closeBy) {
        try { const final = await readMetadata(finalMetadata, runId, report.guestSessionId); if (final?.phase === 'closed') {
          report.fixtureFinal = final;
          if (report.motion) { report.motion.guestPaintFramesPerSecond = final.cadence?.actualUniquePaintFramesPerSecond ?? null; report.motion.guestCadence = final.cadence ?? null; }
          break;
        } }
        catch (error) { report.finalReceiptError = error.message; break; }
        await pause(250);
      }
      if (!report.fixtureFinal) report.cleanupError = 'The immutable closed guest fixture receipt was not observed. Inspect only this RunId/process; do not kill unrelated guest processes.';
    }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    report.ownership.cancelled = !!guard.lost; report.interrupted = interrupted;
    report.finishedAt = new Date().toISOString();
    const status = report.status;
    report.boundedChecksPassed = !report.error && !report.cleanupError && !report.closeError && !guard.lost &&
      report.input?.attempts === 30 && report.input.verified === 30 && report.fixtureFinal?.clickCount === 30 &&
      report.fixtureFinal.complete === true && !report.fixtureFinal.metadataWriteError && report.motion?.uniqueGuestFrames > 1 && report.motion?.integrity?.valid === true &&
      report.prepare?.perMonitorV2 === true && status?.certificateVerified === true && status.selectedProtocol === 2 && status.digestReady === true &&
      report.ownerReject?.code === 'INPUT_REJECTED' && report.close?.ok === true && report.close.result?.connected === false &&
      // The user may naturally switch other applications while this runs.
      // Reject activation by this helper; retain global transitions as diagnostics.
      status.inputOwner === 'agent' &&
      status.helperForegroundChangeCount === 0 && status.helperEverForeground === false;
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseOptions(argv); if (options.help) { console.log(HELP); return 0; }
    const report = await measure(options);
    console.log(JSON.stringify({runId: report.runId, report: path.join(options['output-dir'], 'report.json'), boundedChecksPassed: report.boundedChecksPassed,
      error: report.error, cleanupError: report.cleanupError, motion: report.motion && {...report.motion, observations: undefined}, input: report.input}));
    return report.boundedChecksPassed ? 0 : 1;
  } catch (error) { console.error(JSON.stringify({error: error.message, code: error.code || 'WORKBENCH_NATIVE_MEASUREMENT'})); return 1; }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) process.exitCode = await main();
