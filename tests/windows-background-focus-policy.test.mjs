import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {tailscaleStartupRepairScript} from '../desktop/connection-startup.mjs';
import {resolveCodexCommand} from '../lib/codex-discovery.mjs';

const source=async relative=>readFile(new URL('../'+relative,import.meta.url),'utf8');

test('normal Windows workspace command runner explicitly hides PowerShell on top of windowsHide',async()=>{
  const value=await source('lib/workspace-tools.mjs');
  assert.match(value,/const parameters = windows \? \['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden'/);
  assert.match(value,/spawn\(executable, args, \{ cwd, env, windowsHide: true/);
  assert.doesNotMatch(value,/Start-Process.*-Verb RunAs/);
});

test('background Windows subsystems use hidden PowerShell and do not create a host task window',async()=>{
  const patterns=[
    ['lib/windows-session.mjs', /'-NonInteractive', '-Mta', '-WindowStyle', 'Hidden'/],
    ['lib/profile-backup.mjs', /'-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command'/],
    ['lib/remote-access-cli.mjs', /'-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', OWNER_SCRIPT/],
    ['lib/remote-access-cli.mjs', /'-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', PRIVATE_ACL_SCRIPT/],
    ['lib/codex-discovery.mjs', /'-NonInteractive', '-WindowStyle', 'Hidden', '-Command'/],
  ];
  for(const [file,pattern] of patterns){
    assert.match(await source(file),pattern,'Windows background helper not hidden: '+file);
  }
});

test('Codex discovery uses hidden PowerShell without changing profile or PATH',()=>{
  const calls=[];
  resolveCodexCommand({
    platform:'win32',arch:'x64',
    env:{LOCALAPPDATA:'C:\\Fake',SystemRoot:'C:\\Windows',Path:'C:\\Windows\\System32'},
    exists:()=>false,
    execFile:(executable,args,options)=>{calls.push({args,options});return '';}
  });
  assert.equal(calls.length,1);
  assert.ok(calls[0].args.includes('-WindowStyle'));
  assert.ok(calls[0].args.includes('Hidden'));
  assert.equal(calls[0].options.windowsHide,true);
});

test('automatic Tailscale repair never starts another elevated child',()=>{
  const script=tailscaleStartupRepairScript();
  assert.match(script,/Repair-TailscaleService/);
  assert.match(script,/exit 3/);
  assert.doesNotMatch(script,/Start-Process|-Verb RunAs|SetForegroundWindow/);
});
