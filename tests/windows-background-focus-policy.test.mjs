import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import path from 'node:path';
import vm from 'node:vm';
import {tailscaleStartupRepairScript} from '../desktop/connection-startup.mjs';
import {resolveCodexCommand} from '../lib/codex-discovery.mjs';

const source=async relative=>readFile(new URL('../'+relative,import.meta.url),'utf8');

test('normal Windows workspace commands suppress console creation while preserving transparent arguments and output',async()=>{
  const value=await source('lib/workspace-tools.mjs'), launches=[];
  // Exercise the exact command runner with an inert launcher, not a regex tied
  // to obsolete PowerShell hiding switches. No native process or window opens.
  const spawn=(executable,args,options)=>{
    launches.push({executable,args,options});
    const child=new EventEmitter();
    child.stdout=new EventEmitter(); child.stderr=new EventEmitter(); child.pid=123;
    queueMicrotask(()=>{
      child.emit('spawn');
      child.stdout.emit('data',Buffer.from('visible output'));
      child.stderr.emit('data',Buffer.from('visible diagnostic'));
      child.emit('close',0,null);
    });
    return child;
  };
  const sandbox={spawn,fs:{stat:async()=>({isDirectory:()=>true})},path:path.win32,StringDecoder,
    process:{platform:'win32',env:{}},DESKTOP_RESTART_ORIGIN_ENV:'BLACKICE_RESTART_ORIGIN',
    setTimeout,clearTimeout,AbortSignal,Buffer,TextDecoder};
  vm.runInNewContext(value.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+
    '\nthis.createHandler=createWorkspaceToolHandler;',sandbox);
  const handler=sandbox.createHandler({cwd:'C:\\fixture'}),command='Write-Output "plain text"';
  const response=await handler({name:'relay_workspace',arguments:{action:'run',command}});
  assert.equal(response.success,true);
  assert.equal(launches.length,1,'One transparent launch, without a wrapper or elevated child.');
  const {executable,args,options}=launches[0];
  assert.equal(executable,'powershell.exe');
  assert.deepEqual(Array.from(args.slice(0,4)),['-NoLogo','-NoProfile','-NonInteractive','-Command']);
  assert.equal(args.length,5); assert.ok(args[4].endsWith('\n'+command));
  assert.ok(!args.some(arg=>/Bypass|EncodedCommand|WindowStyle|ExecutionPolicy/i.test(arg)));
  assert.equal(options.windowsHide,true,'The Windows child must not create a console window.');
  assert.equal(options.detached,false,'The Windows command stays an owned child.');
  assert.deepEqual(Array.from(options.stdio),['ignore','pipe','pipe']);
  assert.equal(options.shell,undefined);
  const result=JSON.parse(response.contentItems[0].text);
  assert.equal(result.stdout,'visible output'); assert.equal(result.stderr,'visible diagnostic');
  assert.doesNotMatch(value,/Start-Process.*-Verb RunAs|SetForegroundWindow/);
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
