import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {tailscaleStartupRepairScript} from '../desktop/connection-startup.mjs';
import {resolveCodexCommand} from '../lib/codex-discovery.mjs';
import {readHostInstalledPublishers} from '../lib/workbench-app-publishers.mjs';

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
    ['lib/workbench-app-publishers.mjs', /'-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command'/],
    ['lib/workbench-elevated-command.mjs', /'-NoProfile','-NonInteractive','-WindowStyle','Hidden'/],
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

test('host publisher scan uses a fully hidden native process',async()=>{
  let calls=0;
  const result=await readHostInstalledPublishers({
    platform:'win32',
    runner:async(_executable,args,options)=>{
      calls++;
      assert.ok(args.includes('-WindowStyle'));
      assert.ok(args.includes('Hidden'));
      assert.equal(options.windowsHide,true);
      return {stdout:'{"entries":[]}'};
    }
  });
  assert.equal(calls,1);assert.deepEqual(result,[]);
});

test('automatic Tailscale repair never starts another elevated child',()=>{
  const script=tailscaleStartupRepairScript();
  assert.match(script,/Repair-TailscaleService/);
  assert.match(script,/exit 3/);
  assert.doesNotMatch(script,/Start-Process|-Verb RunAs|SetForegroundWindow/);
});


test('unsigned single-maintainer release documentation makes SAC Off recommended and signing deferred',async()=>{
  const [guide,workbenchDoc,releaseDoc,readme]=await Promise.all([
    source('public/next/workspaces/workbench-guide.mjs'),
    source('docs/WORKBENCH-ADMINISTRATOR-LAUNCH.md'),
    source('SIGNING-AND-RELEASE.md'),
    source('README.md')
  ]);
  assert.match(guide,/Smart App Control: BLACKICE recommends Off/);
  assert.match(guide,/likely incompatible with Smart App Control On/);
  assert.match(guide,/compiled unsigned test program executed/);
  assert.match(guide,/policy-refresh command hung/);
  assert.match(guide,/Signing may be revisited after adoption/);
  assert.match(workbenchDoc,/free and open source, maintained by one person/);
  assert.match(workbenchDoc,/Smart App Control set to Off/);
  assert.match(workbenchDoc,/blocked an unsigned BLACKICE Setup executable/);
  assert.match(workbenchDoc,/guest-agent pairing have not yet been verified/);
  assert.match(releaseDoc,/signing budget/);
  assert.match(releaseDoc,/Code Integrity events 3033\/3077/);
  assert.match(releaseDoc,/previously blocked unsigned NSIS build subsequently succeeded/);
  assert.match(releaseDoc,/No paid certificate or signing service/);
  assert.match(readme,/Signing is deferred until adoption/);
  assert.doesNotMatch(releaseDoc,/Smart App Control On is a supported configuration/);
});

test('UAC power-user recommendation is documented without changing Windows settings',async()=>{
  const [guide,docs]=await Promise.all([
    source('public/next/workspaces/workbench-guide.mjs'),
    source('docs/WORKBENCH-ADMINISTRATOR-LAUNCH.md')
  ]);
  assert.match(guide,/BLACKICE tested UAC configuration and recommendation/);
  assert.match(guide,/Never notify/);
  assert.match(guide,/does not change it automatically/);
  assert.match(guide,/ConsentPromptBehaviorAdmin=0/);
  assert.match(guide,/EnableLUA=1/);
  assert.match(guide,/only UAC configuration observed/);
  assert.match(guide,/<strong>not been tested<\/strong>/);
  assert.doesNotMatch(guide,/Keeping Windows prompts enabled is equally supported/);
  assert.match(docs,/Recommended UAC setting: Never notify/);
  assert.match(docs,/ConsentPromptBehaviorAdmin=0/);
  assert.match(docs,/EnableLUA=1/);
  assert.match(docs,/UAC prompts enabled and `EnableLUA=0` remain untested/);
  assert.match(docs,/default.*highestAvailable/i);
  assert.doesNotMatch(docs,/Both choices are supported/);
});
