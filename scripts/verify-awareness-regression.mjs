#!/usr/bin/env node
/** Full regression against one immutable candidate; records the actual entire
 * test-file argument list as well as TAP totals. Use a new evidence directory.
 * No optional live browser/desktop integrations or real provider turns enabled.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appFingerprint } from './release-check.mjs';
import { captureSourceFiles } from './install-background-update.mjs';

const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(candidate, '..', 'qa-regression'));
if (out === candidate || out.startsWith(candidate + path.sep)) throw Error('Keep regression output outside the candidate.');
await fs.mkdir(out, { recursive: true });
for (const name of ['running.json', 'regression-report.json', 'regression.tap']) {
  try { await fs.lstat(path.join(out, name)); throw Error('Preserve the existing regression attempt and use a new evidence directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const report = { format: 1, product: 'BLACKICE', version: JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')).version, platform: process.platform, node: process.version, candidate, startedAt: new Date().toISOString(), runnerPid: process.pid, deadlineMs: 480000 };
await fs.writeFile(path.join(out, 'running.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
report.appFingerprintBefore = await appFingerprint(candidate);
report.sourceHashesBefore = await captureSourceFiles(candidate);
report.testFileList = Object.keys(report.sourceHashesBefore).filter(name => /^tests\/.+\.test\.mjs$/.test(name)).sort();
report.testFiles = report.testFileList.length;
report.testArguments = ['--test', '--test-concurrency=4', '--test-timeout=60000', '--test-reporter=tap', ...report.testFileList];
const logPath = path.join(out, 'regression.tap'), log = await fs.open(logPath, 'wx');
let child, timedOut = false, timer, stopTimer;
try {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith('RELAY_LIVE_')) environment[key] = '0';
  for (const key of ['RELAY_LIVE_BROWSER_QA', 'RELAY_LIVE_FIREFOX_QA', 'RELAY_LIVE_UIA_QA']) environment[key] = '0';
  delete environment.NODE_OPTIONS;
  child = spawn(process.execPath, report.testArguments, { cwd: candidate, env: environment, windowsHide: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
  report.childPid = child.pid;
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  timer = setTimeout(() => {
    timedOut = true;
    // Terminate only this owned, timed-out disposable test process tree. This
    // never targets the installed application and can never yield a passing gate.
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill('SIGKILL'));
      stopTimer = setTimeout(() => { killer.kill('SIGKILL'); child.kill('SIGKILL'); }, 3000);
    } else child.kill('SIGKILL');
  }, report.deadlineMs);
  const result = await done; report.exitCode = result.code; report.signal = result.signal; report.timedOut = timedOut;
} catch (error) { report.error = error.message; report.exitCode = 1; }
finally { clearTimeout(timer); clearTimeout(stopTimer); await log.close(); }
const content = await fs.readFile(logPath, 'utf8');
const count = name => { const values = [...content.matchAll(new RegExp('^# ' + name + ' (\\d+)\\r?$', 'gm'))]; return values.length ? Number(values.at(-1)[1]) : null; };
report.tests = { total: count('tests'), passed: count('pass'), failed: count('fail'), cancelled: count('cancelled'), skipped: count('skipped') };
report.skips = content.split(/\r?\n/).filter(line => /# SKIP\b/.test(line));
report.failures = content.split(/\r?\n/).filter(line => /^not ok\b/.test(line));
report.logSha256 = createHash('sha256').update(content).digest('hex');
report.appFingerprintAfter = await appFingerprint(candidate);
report.sourceHashesAfter = await captureSourceFiles(candidate);
report.unchanged = report.appFingerprintBefore === report.appFingerprintAfter && JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
report.passed = report.exitCode === 0 && !report.timedOut && report.unchanged && report.tests.total > 0 && report.tests.failed === 0 && report.tests.cancelled === 0;
report.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(out, 'regression-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
await fs.rm(path.join(out, 'running.json'));
const { sourceHashesBefore, sourceHashesAfter, testArguments, testFileList, ...summary } = report;
console.log(JSON.stringify({ ...summary, sourceFilesVerified: Object.keys(sourceHashesAfter).length, testFileListRecorded: testFileList.length }, null, 2));
if (!report.passed) process.exitCode = 1;
