/**
 * Verify BLACKICE's email adapter against an installed Himalaya 2.2.1 binary.
 * Every mailbox/config/message is disposable and local. The user's email configuration
 * is never opened. No IMAP/SMTP/JMAP/Graph/Gmail backend, auth or send command is used.
 * Usage: node scripts/verify-email-cli.mjs --executable C:\\path\\himalaya.exe
 * Config: https://docs.rs/crate/himalaya/2.2.1/source/config.sample.toml
 */
import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const candidateRoot = fileURLToPath(new URL('../', import.meta.url));
const boundSources = ['lib/agent-email.mjs', 'lib/email-message.mjs', 'lib/email-tools.mjs', 'scripts/verify-email-cli.mjs'];
const lastFixtureAccountInvocation = Symbol('lastFixtureAccountInvocation');
async function fileHash(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}
const sourceHashes = async () => Object.fromEntries(await Promise.all(boundSources.map(async filename => [filename, await fileHash(path.join(candidateRoot, filename))])));

// Diagnostics are permitted only in this script's owned, offline fixture. Never
// use this runner for a user's account or import it into the production adapter.
function runOwnedFixtureCli(input, report) {
  return new Promise((resolve, reject) => {
    let child, killer, timer, stopTimer, done = false, stopping = false;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), stdoutBytes = 0, stderrBytes = 0;
    const stdoutLimit = Math.min(input.maxOutputBytes || 2097152, 2097152), stderrLimit = 16384;
    const finish = (error, exitCode = null, exitSignal = null) => {
      if (done) return; done = true;
      clearTimeout(timer); clearTimeout(stopTimer); input.signal?.removeEventListener('abort', abort);
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
      try { killer?.kill('SIGKILL'); } catch {}
      const invocation = {
        cwd: input.cwd, args: input.args, exitCode, exitSignal,
        stdout: stdout.subarray(0, 4096).toString('utf8'), stderr: stderr.toString('utf8'),
        stdoutTruncated: stdoutBytes > 4096, stderrTruncated: stderrBytes > stderrLimit,
        source: 'Only the disposable local fixture configuration and mailbox were available to this invocation.',
      };
      if (input.args.some(argument => argument.startsWith('--config='))) report[lastFixtureAccountInvocation] = invocation;
      if (error) {
        report.failedFixtureInvocation = invocation;
        reject(error);
      } else resolve({ stdout: stdout.toString('utf8'), exitCode });
    };
    const stop = error => {
      if (done || stopping) return; stopping = true;
      if (child?.pid) {
        if (process.platform === 'win32') {
          try {
            killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
            killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} });
          } catch { try { child.kill('SIGKILL'); } catch {} }
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
      }
      child?.once('close', (code, signal) => finish(error, code, signal));
      stopTimer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} finish(error); }, 1000);
      if (!child?.pid) finish(error);
    };
    const problem = (message, code) => Object.assign(new Error(message), { code });
    const abort = () => stop(problem('The offline email fixture was cancelled.', 'EMAIL_FIXTURE_CANCELLED'));
    try {
      child = spawn(input.executable, input.args, {
        cwd: input.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0', TERM: 'dumb', RUST_LOG: 'off' },
      });
    } catch { finish(problem('The offline fixture executable could not start.', 'EMAIL_FIXTURE_EXECUTABLE')); return; }
    child.stdin.on('error', () => {}); child.stdin.end();
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdout.length < stdoutLimit) stdout = Buffer.concat([stdout, chunk.subarray(0, stdoutLimit - stdout.length)]);
      if (stdoutBytes > stdoutLimit) stop(problem('Offline fixture output exceeded its limit.', 'EMAIL_FIXTURE_OUTPUT_LIMIT'));
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderr.length < stderrLimit) stderr = Buffer.concat([stderr, chunk.subarray(0, stderrLimit - stderr.length)]);
      if (stderrBytes > stderrLimit) stop(problem('Offline fixture diagnostics exceeded their limit.', 'EMAIL_FIXTURE_OUTPUT_LIMIT'));
    });
    child.once('error', () => stop(problem('The offline fixture executable could not start.', 'EMAIL_FIXTURE_EXECUTABLE')));
    child.once('close', (code, signal) => {
      if (stopping) return;
      finish(code === 0 ? null : problem(`The owned email fixture client exited with code ${code}.`, 'EMAIL_FIXTURE_CLIENT_FAILED'), code, signal);
    });
    timer = setTimeout(() => stop(problem('The offline email fixture timed out.', 'EMAIL_FIXTURE_TIMEOUT')), Math.min(input.timeoutMs || 10000, 10000));
    input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) abort();
  });
}

const index = process.argv.indexOf('--executable');
const executable = index < 0 ? '' : process.argv[index + 1];
if (!executable || !path.isAbsolute(executable)) {
  console.error('Use --executable with the absolute path to an installed Himalaya2.2.1 binary.');
  process.exitCode = 2;
} else {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-email-local-proof-'));
  let store;
  const report = { integration: 'email_read_local_draft', offlineFixture: true, actualUserAccountAccessed: false, sent: false, platform: process.platform, arch: process.arch, checkedAt: new Date().toISOString(), checks: [] };
  try {
    report.sourceHashesBefore = await sourceHashes();
    report.candidateVersion = JSON.parse(await fs.readFile(path.join(candidateRoot, 'package.json'), 'utf8')).version;
    report.executable = { path: path.resolve(executable), sha256Before: await fileHash(executable), version: null };
    // Bind the source before importing the adapter used by the proof.
    const { AgentEmailStore } = await import('../lib/agent-email.mjs');
    const maildir = path.join(directory, 'maildir');
    const messageName = '1720000000.M123456P1.blackice';
    const body = 'This is a disposable local email fixture. No provider was contacted. Résumé — ✓';
    const encodedBody = Buffer.from(body, 'utf8').toString('base64');
    const message = ['From: Fixture <fixture@example.invalid>', 'To: reader@example.invalid', 'Reply-To: reply@example.invalid', 'Subject: Blackice offline fixture', 'Date: Tue, 01 Oct 2024 12:00:00 +0000', 'Message-ID: <blackice-local-fixture@example.invalid>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodedBody, ''].join('\r\n');
    // Cover canonical root-INBOX and named Maildir folder layouts using only owned data.
    const mailboxRoots = [maildir, path.join(maildir, 'INBOX'), path.join(maildir, '.INBOX')];
    for (const root of mailboxRoots) {
      for (const child of ['cur', 'new', 'tmp']) await fs.mkdir(path.join(root, child), { recursive: true });
      await fs.writeFile(path.join(root, 'new', messageName), message, { mode: 0o600 });
    }
    const configPath = path.join(directory, 'fixture.toml');
    // JSON's quoted path escaping is valid for a TOML basic string on both Windows and Unix.
    const config = `[accounts.fixture]\ndefault = true\nemail = "fixture@example.invalid"\nmaildir.root = ${JSON.stringify(maildir)}\nmailbox.alias.inbox = "INBOX"\n`;
    await fs.writeFile(configPath, config, { mode: 0o600 });
    const calls = [];
    const runner = input => {
      const localInspection = input.args.includes('--help') || input.args.join(' ') === '--version';
      if (!localInspection) {
        assert.equal(input.cwd, path.dirname(configPath));
        assert.ok(input.args.includes(`--config=./${path.basename(configPath)}`));
        assert.ok(input.args.includes('--account=fixture'));
        assert.ok(input.args.includes('envelope') || input.args.includes('message') && input.args.includes('read') || input.args.includes('mailbox') && input.args.includes('list'));
        assert.ok(!input.args.some(arg => ['send', 'add', 'compose', 'configure', 'smtp', 'imap', 'jmap', 'msgraph', 'gmail', '--seen', '--counts'].includes(arg)));
      }
      calls.push([...input.args]);
      return runOwnedFixtureCli(input, report);
    };
    store = await new AgentEmailStore({ dataDir: directory, runner }).init();
    await store.configure({ enabled: true, executable, configPath, account: 'fixture', timeoutMs: 10000 });
    assert.equal(calls.length, 0);
    report.checks.push('configuration_has_no_process_or_account_side_effect');
    await store.check();
    assert.equal(store.status().cli.version, '2.2.1');
    report.cliVersion = store.status().cli.version;
    report.executable.version = report.cliVersion;
    assert.equal(store.status().account.observed, false);
    report.checks.push('installed_cli_version_and_help');
    const folders = await store.mailboxes();
    assert.ok(folders.mailboxes.some(item => path.resolve(item.name) === path.resolve(maildir)), 'The owned Maildir root was not returned by native mailbox discovery.');
    assert.equal(folders.evidence.operation, 'mailboxes');
    report.checks.push('real_maildir_mailbox_discovery_without_counts');
    const exactRoot = folders.mailboxes.find(item => path.resolve(item.name) === path.resolve(maildir));
    const byMailboxId = await store.list({ folder: exactRoot.id, limit: 20 });
    assert.ok(byMailboxId.messages.some(item => item.subject === 'Blackice offline fixture'), 'The exact returned mailbox ID did not select the owned Maildir.');
    report.checks.push('real_maildir_exact_mailbox_id_selection');
    const listed = await store.list({ folder: 'INBOX', limit: 20 });
    const envelope = listed.messages.find(item => item.subject === 'Blackice offline fixture');
    assert.ok(envelope, 'The disposable local fixture was not listed.');
    report.checks.push('real_maildir_list');
    const searched = await store.list({ folder: 'INBOX', query: 'subject Blackice', limit: 20 });
    assert.ok(searched.messages.some(item => String(item.id) === String(envelope.id)));
    report.checks.push('real_maildir_search_with_single_argv_query');
    const read = await store.read({ folder: 'INBOX', id: envelope.id });
    assert.equal(typeof read.message, 'string');
    assert.ok(read.message.includes(encodedBody), 'Raw source must retain the transfer-encoded body.');
    report.checks.push('real_maildir_raw_json_read');
    assert.equal(read.content.text.trim(), body);
    assert.equal(read.content.subject, 'Blackice offline fixture');
    assert.equal(read.content.from[0].email, 'fixture@example.invalid');
    assert.equal(read.content.replyTo[0].email, 'reply@example.invalid');
    assert.equal(read.content.truncated, false);
    report.checks.push('real_maildir_decoded_mime_preview_raw_preserved');
    const after = await store.list({ folder: 'INBOX', limit: 20 });
    assert.deepEqual(after.messages.find(item => String(item.id) === String(envelope.id))?.flags, envelope.flags);
    report.checks.push('read_preserves_message_flags');
    const draft = await store.draft({ requestId: 'offline-proof-draft', to: ['recipient@example.invalid'], subject: 'Offline draft', body: 'Only a local draft.' });
    assert.equal(draft.sent, false);
    assert.match(await fs.readFile(draft.path, 'utf8'), /X-Unsent: 1/);
    report.checks.push('local_unsent_draft_persistence');
    report.passed = true;
    report.cliVersion = store.status().cli.version;
    report.clientCalls = calls.length;
    report.note = 'This verifies the installed CLI against an owned local Maildir. It does not verify any user account or a network backend.';
  } catch (error) {
    report.passed = false;
    report.error = { code: error.code || 'EMAIL_LOCAL_PROOF_FAILED', message: error.message };
    if (report[lastFixtureAccountInvocation]) report.lastFixtureInvocation = report[lastFixtureAccountInvocation];
    process.exitCode = 1;
  } finally {
    await store?.close();
    try {
      report.sourceHashesAfter = await sourceHashes();
      report.sourceUnchanged = JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
      report.executable.sha256After = await fileHash(executable);
      report.executableUnchanged = report.executable.sha256Before === report.executable.sha256After;
      if (!report.sourceUnchanged || !report.executableUnchanged) {
        report.passed = false;
        report.error = { code: 'EMAIL_PROOF_SOURCE_CHANGED', message: 'The candidate email source or installed executable changed during verification.' };
        process.exitCode = 1;
      }
    } catch {
      report.passed = false;
      report.error = { code: 'EMAIL_PROOF_SOURCE_UNAVAILABLE', message: 'The source or executable hashes could not be verified after the run.' };
      process.exitCode = 1;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
}
