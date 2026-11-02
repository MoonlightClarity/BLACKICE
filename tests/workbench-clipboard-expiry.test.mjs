import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
test('private guest clipboard expiry survives restart, expires only proven paths, and runs bounded batches',{skip:process.platform!=='win32'},async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'blackice-clipboard-expiry-'));
  t.after(async()=>{
    assert.equal(path.dirname(path.resolve(root)).toLowerCase(),path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('blackice-clipboard-expiry-'));
    await fs.rm(root,{recursive:true,force:true});
  });
  const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    path.resolve('tests/fixtures/workbench-clipboard-expiry.ps1'),'-AgentPath',path.resolve('scripts/workbench-guest-agent.ps1'),'-FixtureRoot',root],
    {windowsHide:true,timeout:15000,maxBuffer:32768});
  assert.match(stdout,/CLIPBOARD_EXPIRY_FIXTURES_PASS/);
});
