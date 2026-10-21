import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const candidate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(candidate, '..', 'qa-contained-browser-root'));
if (out === candidate || out.startsWith(candidate + path.sep)) throw Error('Keep verification output outside application source.');
await fs.mkdir(out, { recursive: true });
const sources = ['desktop/browser-driver.mjs', 'desktop/browser-capture.mjs', 'desktop/browser-router.mjs', 'lib/browser.mjs', 'tests/browser-auth.integration.test.mjs', 'tests/browser-lazy.integration.test.mjs', 'tests/fixtures/browser-auth-live.mjs', 'tests/fixtures/browser-lazy-live.mjs', 'scripts/verify-contained-browser.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async name => [name, digest(await fs.readFile(path.join(candidate, name)))])));
const report = { format: 1, product: 'BLACKICE', suite: 'contained-browser', platform: process.platform, node: process.version, candidate, startedAt: new Date().toISOString(), runnerPid: process.pid, deadlineMs: 180000, actualUserBrowserAccessed: false, onlyDisposableLocalSites: true, before: await hashes() };
const logfile = path.join(out, 'contained-browser.tap');
const log = await fs.open(logfile, 'w');
let timer, stopTimer;
try {
  const environment = { ...process.env, RELAY_LIVE_BROWSER_QA: '1' };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', 'tests/browser-auth.integration.test.mjs', 'tests/browser-lazy.integration.test.mjs'], { cwd: candidate, env: environment, shell: false, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  report.childPid = child.pid;
  const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  timer = setTimeout(() => {
    report.timedOut = true;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill('SIGKILL'));
      stopTimer = setTimeout(() => { killer.kill('SIGKILL'); child.kill('SIGKILL'); }, 3000);
    } else child.kill('SIGKILL');
  }, report.deadlineMs);
  const result = await completed;
  report.exitCode = result.code; report.signal = result.signal;
} catch (error) { report.exitCode = 1; report.error = error.message; }
finally { clearTimeout(timer); clearTimeout(stopTimer); await log.close(); }
const content = await fs.readFile(logfile, 'utf8');
const count = name => { const values = [...content.matchAll(new RegExp('^# ' + name + ' (\\d+)\\r?$', 'gm'))]; return values.length ? Number(values.at(-1)[1]) : null; };
report.tests = { total: count('tests'), passed: count('pass'), failed: count('fail'), cancelled: count('cancelled'), skipped: count('skipped') };
report.logSha256 = digest(content);
report.after = await hashes();
report.unchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
report.passed = report.exitCode === 0 && !report.timedOut && report.unchanged && report.tests.total === 2 && report.tests.passed === 2 && report.tests.skipped === 0 && report.tests.failed === 0 && report.tests.cancelled === 0;
report.finishedAt = new Date().toISOString();
await fs.writeFile(path.join(out, 'contained-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
