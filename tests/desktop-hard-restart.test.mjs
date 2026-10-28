import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverWindowsRestartTarget, forceWindowsRestart, windowsProcessIdentity } from '../lib/desktop-hard-restart.mjs';
import { executeDesktopRestartCLI, parseDesktopRestartArgs } from '../lib/desktop-restart-cli.mjs';
import { DESKTOP_RESTART_ORIGIN_ENV } from '../lib/desktop-restart-origin.mjs';

// Electron 44 may install its executable lazily, rather than during npm ci.
// Use the package's supported resolver rather than assuming dist already exists.
const require = createRequire(import.meta.url);
const electronExecutable = () => require('electron');

async function removeFixture(dir) {
  const root = await realpath(os.tmpdir()), target = await realpath(dir);
  if (path.dirname(target).toLowerCase() !== root.toLowerCase() || !path.basename(target).startsWith('blackice-hard-')) throw new Error('Refusing to remove an unexpected test directory.');
  await rm(target, { recursive: true, force: true });
}

test('force uses native when healthy and falls back on failed or unavailable native path', async () => {
  const options = parseDesktopRestartArgs(['--restart', '--force', '--request-id=test']);
  let calls = 0;
  const forceFallback = async () => { calls++; return { protocol: 'emergency-force' }; };
  const identity = { pid: 123, created: '12345678901234567', image: 'C:\\test.exe' };
  const connect = receipt => async () => ({ runtime: { pid: 123 }, request: async () => ({ protocol: 1, acknowledged: true, receipt: { requestId: 'test', force: true, durable: true, status: receipt, ...(receipt === 'failed' ? { error: { code: 'DESKTOP_RESTART_PREPARE_FAILED' } } : {}) } }) });
  assert.equal((await executeDesktopRestartCLI(options, { env: {}, forceFallback, connect: connect('scheduled'), getForceIdentity: async () => identity, forceWaitMs: 0 })).receipt.status, 'scheduled');
  assert.equal(calls, 0);
  assert.equal((await executeDesktopRestartCLI(options, { env: {}, forceFallback, connect: connect('failed'), getForceIdentity: async () => identity })).protocol, 'emergency-force');
  assert.equal((await executeDesktopRestartCLI(options, { env: {}, forceFallback, connect: async () => { throw Object.assign(new Error('frozen'), { code: 'BROWSER_CLI_UNREACHABLE' }); } })).protocol, 'emergency-force');
  assert.equal(calls, 2);
  assert.equal((await executeDesktopRestartCLI(parseDesktopRestartArgs(['--restart', '--force', '--emergency', '--request-id=test']), { env: {}, forceFallback })).protocol, 'emergency-force');
});

test('a lost acknowledgement never escalates against a replacement or unknown original', async () => {
  const options = parseDesktopRestartArgs(['--restart', '--force', '--request-id=lost']);
  const identity = { pid: 123, created: '12345678901234567', image: 'C:\\test.exe' };
  const connect = async () => ({ runtime: { pid: 123 }, request: async () => { throw Object.assign(new Error('lost'), { code: 'BROWSER_CLI_UNCERTAIN' }); } });
  let calls = 0, lookups = 0;
  const fallback = async () => { calls++; };
  await assert.rejects(executeDesktopRestartCLI(options, { env: {}, forceFallback: fallback, connect, getForceIdentity: async () => ++lookups === 1 ? identity : { ...identity, created: '12345678901234568' } }), { code: 'DESKTOP_RESTART_ACK_UNCERTAIN' });
  await assert.rejects(executeDesktopRestartCLI(options, { env: {}, forceFallback: fallback, connect, getForceIdentity: async () => { throw new Error('unavailable'); } }), { code: 'DESKTOP_RESTART_ACK_UNCERTAIN' });
  assert.equal(calls, 0);
});

test('post-acknowledgement failed and stuck handoffs escalate for the same verified original process', async () => {
  const options = parseDesktopRestartArgs(['--restart', '--force', '--request-id=watch']);
  const identity = { pid: 123, created: '12345678901234567', image: 'C:\\test.exe' };
  const ack = status => ({ protocol: 1, acknowledged: true, receipt: { requestId: 'watch', force: true, durable: true, status, ...(status === 'failed' ? { error: { code: 'DESKTOP_RESTART_PREPARE_FAILED' } } : {}) } });
  let captured;
  const forceFallback = async (_options, context) => { captured = context.expectedIdentity; return { protocol: 'emergency-force' }; };
  const makeConnect = later => async () => ({ runtime: { pid: 123 }, request: async route => route.endsWith('/status') ? ack(later) : ack('scheduled') });
  const base = { forceFallback, getForceIdentity: async () => identity, forcePollMs: 2, forceWaitMs: 12, env: {} };
  assert.equal((await executeDesktopRestartCLI(options, { ...base, connect: makeConnect('failed') })).protocol, 'emergency-force'); assert.deepEqual(captured, identity);
  captured = null;
  assert.equal((await executeDesktopRestartCLI(options, { ...base, connect: makeConnect('scheduled') })).protocol, 'emergency-force'); assert.deepEqual(captured, identity);
  captured = null;
  const result = await executeDesktopRestartCLI(options, { ...base, env: { [DESKTOP_RESTART_ORIGIN_ENV]: 'a'.repeat(64) }, connect: makeConnect('scheduled') });
  assert.equal(result.receipt.status, 'scheduled'); assert.match(result.followup, /--emergency/); assert.equal(captured, null);
});

test('force never bypasses authorization denial, revoked origin or cancellation', async () => {
  const options = parseDesktopRestartArgs(['--restart', '--force', '--request-id=denied']);
  const identity = { pid: 123, created: '12345678901234567', image: 'C:\\test.exe' }; let fallback = 0;
  const base = { env: {}, forceFallback: async () => { fallback++; }, getForceIdentity: async () => identity, forceWaitMs: 20, forcePollMs: 2 };
  const denied = async () => ({ runtime: { pid: 123 }, request: async () => { throw Object.assign(new Error('denied'), { code: 'BROWSER_CLI_REJECTED', status: 403 }); } });
  await assert.rejects(executeDesktopRestartCLI(options, { ...base, connect: denied }), { status: 403 });
  for (const status of ['cancelled', 'failed']) {
    const connect = async () => ({ runtime: { pid: 123 }, request: async () => ({ protocol: 1, acknowledged: true, receipt: { requestId: 'denied', force: true, durable: true, status, error: { code: 'DESKTOP_RESTART_ORIGIN_UNAUTHORIZED' } } }) });
    assert.equal((await executeDesktopRestartCLI(options, { ...base, connect })).receipt.status, status);
  }
  const revoked = async () => ({ runtime: { pid: 123 }, request: async route => ({ protocol: 1, acknowledged: true, receipt: { requestId: 'denied', force: true, durable: true, status: route.endsWith('/status') ? 'failed' : 'scheduled', error: { code: 'DESKTOP_RESTART_ORIGIN_UNAUTHORIZED' } } }) });
  assert.equal((await executeDesktopRestartCLI(options, { ...base, connect: revoked })).receipt.status, 'failed');
  const deniedAfterAck = async () => ({ runtime: { pid: 123 }, request: async route => { if (route.endsWith('/status')) throw Object.assign(new Error('denied'), { code: 'BROWSER_CLI_REJECTED', status: 403 }); return { protocol: 1, acknowledged: true, receipt: { requestId: 'denied', force: true, durable: true, status: 'scheduled' } }; } });
  await assert.rejects(executeDesktopRestartCLI(options, { ...base, connect: deniedAfterAck }), { status: 403 });
  assert.equal(fallback, 0);
});

test('an owned command cannot use emergency fallback when its origin cannot be reauthorized', async () => {
  const token = 'a'.repeat(64), env = { [DESKTOP_RESTART_ORIGIN_ENV]: token }; let calls = 0;
  const forceFallback = async () => { calls++; };
  const emergency = parseDesktopRestartArgs(['--restart', '--force', '--emergency', '--request-id=owned']);
  await assert.rejects(executeDesktopRestartCLI(emergency, { env, forceFallback }), { code: 'DESKTOP_RESTART_HARD_ORIGIN' });
  const normal = parseDesktopRestartArgs(['--restart', '--force', '--request-id=owned']);
  const revoked = async () => ({ runtime: { pid: 123 }, request: async () => { throw Object.assign(new Error('revoked'), { code: 'DESKTOP_RESTART_ORIGIN_UNAUTHORIZED', status: 403 }); } });
  await assert.rejects(executeDesktopRestartCLI(normal, { env, forceFallback, connect: revoked }), { code: 'DESKTOP_RESTART_ORIGIN_UNAUTHORIZED' });
  const unreachable = async () => { throw Object.assign(new Error('unreachable'), { code: 'BROWSER_CLI_UNREACHABLE' }); };
  await assert.rejects(executeDesktopRestartCLI(normal, { env, forceFallback, connect: unreachable }), { code: 'BROWSER_CLI_UNREACHABLE' });
  assert.equal(calls, 0);
});

test('Windows emergency force rejects reused identity and restarts an owned frozen process only once', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blackice-hard-test-'));
  const profile = path.join(dir, 'profile'), claims = path.join(dir, 'claims'), output = path.join(dir, 'launches.jsonl');
  await mkdir(profile); await mkdir(claims);
  const replacement = path.join(dir, 'replacement.cjs');
  await writeFile(replacement, `require('node:fs').appendFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),origin:process.env[${JSON.stringify(DESKTOP_RESTART_ORIGIN_ENV)}]||null,helper:process.env.BLACKICE_RESTART_INPUT||null})+'\\n');`);
  const child = spawn(process.execPath, ['-e', 'while(true){}'], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => { try { child.kill(); } catch {} await removeFixture(dir); });
  const identity = await windowsProcessIdentity(child.pid);
  const raw = { pid: child.pid, startedAt: new Date().toISOString(), executable: process.execPath, version: '1.0.0', url: 'http://127.0.0.1:21900', profileMode: 'custom', capabilities: { electron: true }, lifecycle: { mode: 'background' }, hardRestart: { identity, args: [replacement, '--profile-dir', profile, '--background'] } };
  const record = async () => writeFile(path.join(profile, 'desktop-runtime.json'), JSON.stringify(raw));
  const options = { action: 'restart', force: true, 'request-id': 'one-shot', 'profile-dir': profile };
  raw.hardRestart.identity = { ...identity, created: (BigInt(identity.created) + 1n).toString() }; await record();
  await assert.rejects(forceWindowsRestart(options, { expectedExecutable: process.execPath, tempDir: claims }), { code: 'DESKTOP_RESTART_HARD_UNCERTAIN' });
  assert.equal(child.exitCode, null);
  raw.hardRestart.identity = identity; await record();
  await assert.rejects(forceWindowsRestart(options, { expectedExecutable: process.execPath, tempDir: claims, expectedIdentity: { ...identity, pid: identity.pid + 1 } }), { code: 'DESKTOP_RESTART_HARD_UNCERTAIN' });
  assert.equal(child.exitCode, null, 'a replacement cannot be terminated by an earlier handoff watcher');
  const previousOrigin = process.env[DESKTOP_RESTART_ORIGIN_ENV]; process.env[DESKTOP_RESTART_ORIGIN_ENV] = 'test-origin-must-not-leak';
  t.after(() => { if (previousOrigin === undefined) delete process.env[DESKTOP_RESTART_ORIGIN_ENV]; else process.env[DESKTOP_RESTART_ORIGIN_ENV] = previousOrigin; });
  const results = await Promise.allSettled([forceWindowsRestart(options, { expectedExecutable: process.execPath, tempDir: claims }), forceWindowsRestart(options, { expectedExecutable: process.execPath, tempDir: claims })]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const result = results.find(value => value.status === 'fulfilled').value;
  assert.equal(result.outcome, 'replacement_launched'); assert.equal(result.durableClaim, true);
  for (let n = 0; n < 30; n++) { try { await readFile(output); break; } catch { await delay(100); } }
  const lines = (await readFile(output, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { args: ['--profile-dir', profile, '--background'], origin: null, helper: null });
});

test('emergency restart proceeds with an explicitly non-durable claim if claim storage is unavailable', { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blackice-hard-no-claim-'));
  const profile = path.join(dir, 'profile'), unavailable = path.join(dir, 'not-a-directory'), output = path.join(dir, 'started');
  await mkdir(profile); await writeFile(unavailable, 'file');
  const child = spawn(process.execPath, ['-e', 'while(true){}'], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => { try { child.kill(); } catch {} await removeFixture(dir); });
  const identity = await windowsProcessIdentity(child.pid);
  const replacement = path.join(dir, 'replacement.cjs'); await writeFile(replacement, `require('fs').writeFileSync(${JSON.stringify(output)},'started')`);
  await writeFile(path.join(profile, 'desktop-runtime.json'), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), executable: process.execPath, version: '1.0.0', url: 'http://127.0.0.1:21900', profileMode: 'custom', capabilities: { electron: true }, lifecycle: { mode: 'window' }, hardRestart: { identity, args: [replacement] } }));
  const result = await forceWindowsRestart({ 'profile-dir': profile, 'request-id': 'degraded' }, { expectedExecutable: process.execPath, tempDir: unavailable });
  assert.equal(result.outcome, 'replacement_launched'); assert.equal(result.durableClaim, false); assert.equal(result.confirmedStarted, false);
  for (let n = 0; n < 30; n++) { try { await readFile(output); break; } catch { await delay(100); } }
  assert.equal(await readFile(output, 'utf8'), 'started');
});

test('a late competing Electron relaunch cannot create a second active instance in the same profile', { skip: process.platform !== 'win32', timeout: 90000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blackice-hard-electron-'));
  const profile = path.join(dir, 'profile'), claims = path.join(dir, 'claims'), appDir = path.join(dir, 'app');
  const events = path.join(dir, 'events.jsonl'), stop = path.join(dir, 'stop');
  await mkdir(profile); await mkdir(claims); await mkdir(appDir);
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
  const identityModule = new URL('../lib/desktop-hard-restart.mjs', import.meta.url).href;
  await writeFile(path.join(appDir, 'main.cjs'), `
    const {app}=require('electron'); const fs=require('node:fs'); const path=require('node:path');
    const profile=${JSON.stringify(profile)}, events=${JSON.stringify(events)}, stop=${JSON.stringify(stop)}, appDir=${JSON.stringify(appDir)};
    app.setPath('userData',profile);
    if (!app.requestSingleInstanceLock()) { app.exit(0); }
    else {
      const log=(kind)=>fs.appendFileSync(events,JSON.stringify({kind,pid:process.pid})+'\\n');
      app.on('second-instance',()=>log('second'));
      app.whenReady().then(async()=>{
        log('started');
        const identity=await (await import(${JSON.stringify(identityModule)})).windowsProcessIdentity();
        fs.writeFileSync(path.join(profile,'desktop-runtime.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),executable:process.execPath,version:'1.0.0',url:'http://127.0.0.1:21900',profileMode:'custom',capabilities:{electron:true},lifecycle:{mode:'background'},hardRestart:{identity,args:[appDir,'--profile-dir',profile,'--background']}}));
        if(process.argv.includes('--freeze')) while(true){}
        setInterval(()=>{if(fs.existsSync(stop))app.quit()},100);
      });
    }
  `);
  const electron = electronExecutable();
  const target = spawn(electron, [appDir, '--profile-dir', profile, '--background', '--freeze'], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => { await writeFile(stop, 'stop').catch(() => {}); await delay(1000); try { target.kill(); } catch {} await removeFixture(dir); });
  const runtimeFile = path.join(profile, 'desktop-runtime.json');
  let identity;
  for (let n = 0; n < 120; n++) { try { identity = JSON.parse(await readFile(runtimeFile, 'utf8')).hardRestart.identity; break; } catch { await delay(100); } }
  assert.ok(identity, 'disposable Electron primary published its identity');
  const result = await forceWindowsRestart({ 'profile-dir': profile, 'request-id': 'electron-late' }, { expectedExecutable: electron, tempDir: claims });
  assert.equal(result.outcome, 'replacement_launched'); assert.equal(result.confirmedStarted, false);
  // This deliberately arrives later than the emergency path's observation window.
  await delay(2200);
  const late = spawn(electron, [appDir, '--profile-dir', profile, '--background'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { late.once('exit', resolve); late.once('error', reject); });
  for (let n = 0; n < 40; n++) { const text = await readFile(events, 'utf8'); if (text.includes('"second"')) break; await delay(100); }
  const rows = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.kind === 'started').length, 2, 'one original and one replacement acquire the profile lock');
  assert.equal(rows.filter(row => row.kind === 'second').length, 1, 'late launch is forwarded to the replacement');
});

test('an owned PowerShell command and its helper survive termination of their frozen Electron parent', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blackice-hard-owned-'));
  const profile = path.join(dir, 'profile'), appDir = path.join(dir, 'app'), claims = path.join(dir, 'claims');
  const outcome = path.join(dir, 'outcome.json'), events = path.join(dir, 'events.jsonl'), stop = path.join(dir, 'stop');
  await mkdir(profile); await mkdir(appDir); await mkdir(claims);
  const moduleUrl = new URL('../lib/desktop-hard-restart.mjs', import.meta.url).href;
  const electron = electronExecutable();
  const cli = path.join(dir, 'cli.cjs'), command = path.join(dir, 'command.ps1');
  await writeFile(cli, `setTimeout(async()=>{ try { const m=await import(${JSON.stringify(moduleUrl)}); const r=await m.forceWindowsRestart({'profile-dir':${JSON.stringify(profile)},'request-id':'owned-command'},{expectedExecutable:${JSON.stringify(electron)},tempDir:${JSON.stringify(claims)}});require('fs').writeFileSync(${JSON.stringify(outcome)},JSON.stringify(r)); }catch(e){require('fs').writeFileSync(${JSON.stringify(outcome)},JSON.stringify({error:e.message,code:e.code}));}},1200);`);
  const quote = s => `'${s.replaceAll("'", "''")}'`;
  await writeFile(command, `& ${quote(process.execPath)} ${quote(cli)}\n`);
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
  await writeFile(path.join(appDir, 'main.cjs'), `
    const {app}=require('electron'),fs=require('fs'),path=require('path'),{spawn}=require('child_process');
    const profile=${JSON.stringify(profile)},events=${JSON.stringify(events)},stop=${JSON.stringify(stop)},appDir=${JSON.stringify(appDir)};
    app.setPath('userData',profile);
    if(!app.requestSingleInstanceLock())app.exit(0); else app.whenReady().then(async()=>{
      fs.appendFileSync(events,JSON.stringify({pid:process.pid})+'\\n');
      const identity=await (await import(${JSON.stringify(moduleUrl)})).windowsProcessIdentity();
      fs.writeFileSync(path.join(profile,'desktop-runtime.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),executable:process.execPath,version:'1.0.0',url:'http://127.0.0.1:21900',profileMode:'custom',capabilities:{electron:true},lifecycle:{mode:'headless'},hardRestart:{identity,args:[appDir,'--profile-dir',profile,'--headless']}}));
      if(process.argv.includes('--owned')) { spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',${JSON.stringify(command)}],{windowsHide:true,stdio:['ignore','pipe','pipe']}); while(true){} }
      setInterval(()=>{if(fs.existsSync(stop))app.quit()},100);
    });
  `);
  const original = spawn(electron, [appDir, '--profile-dir', profile, '--headless', '--owned'], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => { await writeFile(stop, 'stop').catch(() => {}); await delay(1000); try { original.kill(); } catch {} await removeFixture(dir); });
  let result;
  for (let n = 0; n < 400; n++) { try { result = JSON.parse(await readFile(outcome, 'utf8')); break; } catch { await delay(100); } }
  assert.equal(result?.outcome, 'replacement_launched', JSON.stringify(result));
  for (let n = 0; n < 200; n++) { try { if ((await readFile(events, 'utf8')).trim().split('\n').length === 2) break; } catch {} await delay(100); }
  assert.equal((await readFile(events, 'utf8')).trim().split('\n').length, 2);
  let resumed;
  for (let n = 0; n < 100; n++) { resumed = JSON.parse(await readFile(path.join(profile, 'desktop-runtime.json'), 'utf8')); if (resumed.pid !== original.pid) break; await delay(100); }
  assert.equal(resumed.lifecycle.mode, 'headless'); assert.notEqual(resumed.pid, original.pid);
});

test('record-free discovery matches profile and executable, refuses ambiguity, then restarts a frozen startup', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'blackice-hard-discovery-'));
  const profile = path.join(dir, 'profile'), other = path.join(dir, 'other'), appDir = path.join(dir, 'app'), claims = path.join(dir, 'claims');
  await mkdir(profile); await mkdir(other); await mkdir(appDir); await mkdir(claims);
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
  await writeFile(path.join(appDir, 'main.cjs'), `
    const {app}=require('electron'),fs=require('fs'),path=require('path');
    const i=process.argv.indexOf('--profile-dir'),profile=process.argv[i+1]; app.setPath('userData',profile);
    app.whenReady().then(()=>{fs.appendFileSync(path.join(profile,'events'),process.pid+'\\n');const marker=path.join(profile,'frozen');if(!fs.existsSync(marker)){fs.writeFileSync(marker,'1');while(true){}}setInterval(()=>{if(fs.existsSync(path.join(profile,'stop')))app.quit()},100)});
  `);
  const electron = electronExecutable();
  const run = selected => spawn(electron, [appDir, '--profile-dir', selected, '--background'], { windowsHide: true, stdio: 'ignore' });
  const first = run(profile), unrelated = run(other);
  const otherApp = path.join(dir, 'unrelated-app'); await mkdir(otherApp);
  await writeFile(path.join(otherApp, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
  await writeFile(path.join(otherApp, 'main.cjs'), `require('electron').app.whenReady().then(()=>{require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'other-ready'))},'1');while(true){}})`);
  const unrelatedApp = spawn(electron, [otherApp, '--profile-dir', profile, '--background'], { windowsHide: true, stdio: 'ignore' });
  let duplicate;
  t.after(async () => { for (const selected of [profile, other]) await writeFile(path.join(selected, 'stop'), '1').catch(() => {}); for (const child of [first, unrelated, unrelatedApp, duplicate]) try { child?.kill(); } catch {} await delay(1200); await removeFixture(dir); });
  for (let n = 0; n < 120; n++) { try { await Promise.all([readFile(path.join(profile, 'frozen')), readFile(path.join(other, 'frozen'))]); break; } catch { await delay(100); } }
  const context = { expectedExecutable: electron, defaultProfile: path.join(dir, 'default'), appDirectory: appDir, tempDir: claims };
  const candidate = await discoverWindowsRestartTarget(profile, context);
  assert.equal(candidate.identity.pid, first.pid); assert.equal(candidate.mode, 'background'); assert.ok(candidate.args.includes(profile));
  await assert.rejects(discoverWindowsRestartTarget(path.join(dir, 'missing'), context), { code: 'DESKTOP_RESTART_HARD_IDENTITY' });
  duplicate = run(profile);
  for (let n = 0; n < 100; n++) { if ((await readFile(path.join(profile, 'events'), 'utf8')).trim().split('\n').length === 2) break; await delay(100); }
  await assert.rejects(discoverWindowsRestartTarget(profile, context), { code: 'DESKTOP_RESTART_HARD_IDENTITY' });
  duplicate.kill(); await new Promise(resolve => duplicate.once('exit', resolve)); duplicate = null;
  await writeFile(path.join(profile, 'desktop-runtime.json'), '{corrupt');
  const result = await forceWindowsRestart({ 'profile-dir': profile, 'request-id': 'no-record' }, context);
  assert.equal(result.outcome, 'replacement_launched'); assert.equal(result.mode, 'background'); assert.equal(result.modeInferredFromLaunch, true);
  assert.equal(unrelated.exitCode, null, 'other profile remains running');
  assert.equal(unrelatedApp.exitCode, null, 'unrelated Electron app remains running');
  for (let n = 0; n < 100; n++) { if ((await readFile(path.join(profile, 'events'), 'utf8')).trim().split('\n').length === 3) break; await delay(100); }
  assert.equal((await readFile(path.join(profile, 'events'), 'utf8')).trim().split('\n').length, 3);
});
