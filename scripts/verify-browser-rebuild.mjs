#!/usr/bin/env node
/** Run real contained-browser acceptance with an explicit raw Electron binary. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index++) {
  const value = args[index];
  if (value === '--help') { options.help = true; continue; }
  if (value === '--wheel-only') { options.wheelOnly = true; continue; }
  if (!value.startsWith('--')) throw Error(`Unexpected argument: ${value}`);
  const equal = value.indexOf('='), name = value.slice(2, equal < 0 ? undefined : equal);
  if (!['electron', 'out', 'source'].includes(name) || Object.hasOwn(options, name)) throw Error(`Unknown or repeated option: ${name}`);
  options[name] = equal < 0 ? args[++index] : value.slice(equal + 1);
  if (!options[name] || options[name].startsWith('--')) throw Error(`Supply --${name}=<absolute path>.`);
}
if (options.help) { console.log('node scripts/verify-browser-rebuild.mjs --electron=<absolute raw electron.exe> --out=<absolute evidence directory outside source> [--source=<candidate checkout>] [--wheel-only]'); process.exit(0); }
const source = path.resolve(options.source || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
if (!options.electron || !path.isAbsolute(options.electron) || !options.out || !path.isAbsolute(options.out)) throw Error('Supply absolute --electron and --out paths.');
const executable = path.resolve(options.electron), out = path.resolve(options.out), relativeOut = path.relative(source, out);
if (!['electron', 'electron.exe'].includes(path.basename(executable).toLowerCase())) throw Error('Use a raw Electron executable, never the installed BLACKICE application.');
if (!relativeOut || !relativeOut.startsWith('..' + path.sep) && !path.isAbsolute(relativeOut)) throw Error('Keep verification evidence outside the candidate source.');
if (!(await fs.stat(executable)).isFile()) throw Error('The supplied raw Electron executable is not a file.');
const fixtureRelative = 'tests/fixtures/browser-wheel-live.mjs';
const fixtureFile = path.join(source, fixtureRelative), suite = 'browser-wheel';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function sourceHashes() {
  const pending = ['public/app.js', 'public/observe-ui.mjs', 'public/index.html', 'public/observe.css', 'public/blackice-information.css', 'public/conversation-layout.css', 'desktop/browser-driver.mjs', 'desktop/browser-router.mjs', 'lib/browser.mjs', fixtureRelative, 'scripts/verify-browser-rebuild.mjs'];
  const files = new Set(['package.json', 'desktop/browser-compatibility/manifest.json', 'desktop/browser-compatibility/main.js', 'lib/vendor/adblock-filter-data.json']);
  while (pending.length) {
    const relative = pending.pop(); if (files.has(relative)) continue; files.add(relative);
    const absolute = path.join(source, relative), text = await fs.readFile(absolute, 'utf8');
    const imports = [...text.matchAll(/\b(?:from\s*|import\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\1/g)];
    for (const match of imports) {
      const target = path.resolve(path.dirname(absolute), match[2]), dependency = path.relative(source, target);
      if (dependency.startsWith('..' + path.sep) || path.isAbsolute(dependency)) throw Error(`A browser dependency leaves the candidate: ${relative}`);
      if (/\.(?:mjs|js|json)$/.test(target)) pending.push(dependency.split(path.sep).join('/'));
    }
  }
  return Object.fromEntries(await Promise.all([...files].sort().map(async relative => [relative, digest(await fs.readFile(path.join(source, relative)))])));
}

await fs.mkdir(out, { recursive: true });
const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-browser-rebuild-')), nonce = randomUUID();
await fs.mkdir(path.join(root, 'profile')); await fs.writeFile(path.join(root, 'fixture-marker.json'), JSON.stringify({ suite: 'native-' + suite, nonce }));
const reportFile = path.join(out, 'browser-rebuild-report.json'), nativeFile = path.join(out, 'browser-rebuild-native.json'), logFile = path.join(out, 'browser-rebuild-native.log');
const report = { format: 1, product: 'BLACKICE', suite, source, platform: process.platform, node: process.version, startedAt: new Date().toISOString(), deadlineMs: 90000,
  actualUserBrowserAccessed: false, onlyDisposableLocalSites: true, temporaryRoot: root, executable: { path: executable, sha256: digest(await fs.readFile(executable)) }, before: await sourceHashes() };
await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
const log = await fs.open(logFile, 'w');
let child, timer, killer;
try {
  child = spawn(executable, [fixtureFile, `--fixture-root=${root}`, `--fixture-nonce=${nonce}`, `--fixture-result=${nativeFile}`], { cwd: source, env: environment, shell: false, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  report.childPid = child.pid;
  const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ exitCode, signal })); });
  timer = setTimeout(() => {
    report.timedOut = true; report.forcedCleanup = true;
    // This PID was created above for a new disposable profile. No installed
    // BLACKICE process or user's browser is selected or terminated here.
    if (process.platform === 'win32' && child.pid) {
      killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill('SIGKILL'));
    } else child.kill('SIGKILL');
  }, report.deadlineMs);
  Object.assign(report, await completed);
} catch (error) { report.exitCode = 1; report.runnerError = error.message; }
finally { clearTimeout(timer); await log.close(); }
try { report.native = JSON.parse(await fs.readFile(nativeFile, 'utf8')); }
catch (error) { report.resultError = `The native fixture did not produce a readable result: ${error.message}`; }
report.logSha256 = digest(await fs.readFile(logFile));
report.after = await sourceHashes(); report.sourceUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
report.passed = report.exitCode === 0 && !report.timedOut && !report.runnerError && !report.resultError && report.native?.passed === true && report.native.fixtureNonce === nonce && report.native.pid === report.childPid && report.native.cleanup?.complete === true && report.native.forcedCleanup !== true && report.sourceUnchanged;
if (report.passed) {
  try { assert.match(path.basename(root), /^blackice-browser-rebuild-/); assert.equal(path.dirname(root), path.resolve(tmpdir())); await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); report.disposableStateRemoved = true; }
  catch (error) { report.passed = false; report.cleanupError = error.message; }
} else report.failureEvidenceRetained = root;
report.finishedAt = new Date().toISOString(); report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, checks: report.native?.checks.length || 0, actions: report.native?.actions.length || 0, electron: report.native?.electron, durationMs: report.durationMs, report: reportFile, nativeReport: nativeFile, log: logFile, stage: report.native?.stage, error: report.native?.error || report.runnerError || report.resultError || report.cleanupError }));
if (!report.passed) process.exitCode = 1;
