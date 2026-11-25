import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = new URL('../desktop/upgrade-preflight.ps1', import.meta.url);
const windowsOnly = process.platform === 'win32';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('NSIS upgrade hook handles existing installs but does not change ordinary desktop shutdown', async () => {
  const [nsh, powershell, builder, signing] = await Promise.all([
    fs.readFile(new URL('../desktop/installer.nsh', import.meta.url), 'utf8'),
    fs.readFile(helper, 'utf8'),
    fs.readFile(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/release-signing.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(nsh, /!macro customInit/);
  assert.match(nsh, /IfFileExists.*BLACKICE\.exe/);
  assert.match(nsh, /nsExec::ExecToStack/);
  assert.match(nsh, /Abort/);
  assert.match(powershell, /--quit/);
  assert.match(powershell, /remote-availability-worker/);
  assert.match(powershell, /crashpad-handler/);
  assert.match(powershell, /Get-CimInstance Win32_Process/);
  assert.match(builder, /include: desktop\/installer\.nsh/);
  assert.match(builder, /!desktop\/upgrade-preflight\.ps1/);
  assert.match(signing, /nsis:\{include:'desktop\/installer\.nsh'/);
});

test('native in-place upgrade releases abandoned helper processes, without stopping another installation',
  { skip: !windowsOnly, timeout: 30000 }, async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-upgrade-process-'));
    const installRoot = path.join(home, 'Programs', 'BLACKICE');
    await fs.mkdir(installRoot, { recursive: true });
    const exe = path.join(installRoot, 'BLACKICE.exe');
    await fs.copyFile(process.execPath, exe);
    const script = path.join(home, 'remote-availability-worker.mjs');
    await fs.writeFile(script, 'setInterval(() => {}, 1000);\n');
    const children = [];
    t.after(async () => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.all(children.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(3000)]);
      }));
      await fs.rm(home, { recursive: true, force: true });
    });
    const start = async (binary, args) => {
      const child = spawn(binary, args, { windowsHide: true, stdio: 'ignore' });
      children.push(child);
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      return child;
    };
    const worker = await start(exe, [script]);
    const crashpad = await start(exe, [script, '--type=crashpad-handler']);
    const otherDir = path.join(home, 'other');
    await fs.mkdir(otherDir);
    const otherExe = path.join(otherDir, 'BLACKICE.exe');
    await fs.copyFile(process.execPath, otherExe);
    const unrelated = await start(otherExe, [script]);
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', fileURLToPath(helper), '-InstallRoot', installRoot,
    ], { env: { ...process.env, LOCALAPPDATA: home, APPDATA: path.join(home, 'profile') },
      encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    const hasExited = async child => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      return Promise.race([new Promise(resolve => child.once('exit', () => resolve(true))), pause(2000).then(() => false)]);
    };
    assert.equal(await hasExited(worker), true, 'orphaned remote helper exited');
    assert.equal(await hasExited(crashpad), true, 'orphaned crash handler exited');
    assert.equal(unrelated.exitCode, null, 'different installation was untouched');
    assert.equal(unrelated.signalCode, null, 'different installation was not signaled');
    assert.equal(await fs.readFile(script, 'utf8'), 'setInterval(() => {}, 1000);\n');
  });
