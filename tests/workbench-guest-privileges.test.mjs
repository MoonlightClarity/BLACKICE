import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {WorkbenchGuestBridge} from '../lib/workbench-guest-bridge.mjs';

const basis='interactive-guest-agent-token';
const agentScript=fileURLToPath(new URL('../scripts/workbench-guest-agent.ps1',import.meta.url));
const fixture=async t=>{
  const shared=await fs.mkdtemp(path.join(tmpdir(),'blackice-guest-privileges-'));
  t.after(()=>fs.rm(shared,{recursive:true,force:true}));
  const time=Date.now(),bridge=new WorkbenchGuestBridge({sharedRoot:shared,clock:()=>time});
  await bridge.init();
  const root=path.join(shared,'.blackice-workbench');
  const agent={version:1,agentId:'a'.repeat(32),guestName:'GUEST',sessionId:2,interactive:true,
    heartbeatAt:new Date(time).toISOString(),guestRoot:'W:\\',capabilities:['probe']};
  const pair={version:1,agentId:agent.agentId,guestSessionId:2,verifiedAt:new Date(time).toISOString()};
  return {bridge,agent,pair,time,async publish(){
    await fs.writeFile(path.join(root,'agent-state.json'),JSON.stringify(agent));
    await fs.writeFile(path.join(root,'pairing.json'),JSON.stringify(pair));
    // Host administrator rights cannot establish the different guest token.
    await fs.writeFile(path.join(root,'host-info.json'),JSON.stringify({version:1,hostName:'HOST',processElevated:true,administratorToken:true}));
  }};
};

for(const administratorToken of [false,true])test(`paired fresh guest reports its own administrator token ${administratorToken}`,async t=>{
  const f=await fixture(t);f.agent.privileges={administratorToken,basis};await f.publish();
  assert.deepEqual((await f.bridge.agentStatus()).privileges,{administratorToken,basis});
});

test('legacy or malformed privilege metadata remains unknown',async t=>{
  const f=await fixture(t);
  const invalid=[undefined,null,false,[],{},
    {administratorToken:false},{basis},
    {administratorToken:0,basis},{administratorToken:'false',basis},
    {administratorToken:true,basis:'host-token'},
    {administratorToken:true,basis,accountMember:true}];
  for(const privileges of invalid){
    if(privileges===undefined)delete f.agent.privileges;else f.agent.privileges=privileges;
    await f.publish();const status=await f.bridge.agentStatus();
    assert.equal(status.online,true);assert.equal(status.paired,true);
    assert.equal(Object.hasOwn(status,'privileges'),false,JSON.stringify(privileges));
  }
});

test('stale, noninteractive, unpaired and changed-session guest tokens are omitted',async t=>{
  for(const change of [
    f=>{f.agent.heartbeatAt=new Date(f.time-20001).toISOString();},
    f=>{f.agent.heartbeatAt=new Date(f.time+5001).toISOString();},
    f=>{f.agent.interactive=false;},
    f=>{f.pair.agentId='b'.repeat(32);},
    f=>{f.pair.guestSessionId=3;},
    f=>{f.pair.verifiedAt=new Date(f.time-24*3600_000-1).toISOString();}
  ]){
    const f=await fixture(t);f.agent.privileges={administratorToken:true,basis};change(f);await f.publish();
    assert.equal(Object.hasOwn(await f.bridge.agentStatus(),'privileges'),false);
  }
});

test('guest privilege computation follows independent guest and interactive guards and preserves unknown failures',async()=>{
  const source=await fs.readFile(agentScript,'utf8');
  const hostGuard=source.indexOf("throw 'Refusing to run the Workbench guest agent on the host Windows desktop.'");
  const sessionGuard=source.indexOf("if(!$Interactive){throw 'A logged-in interactive guest Windows session is required.");
  const tokenRead=source.indexOf('$GuestIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()');
  assert.ok(hostGuard>=0&&sessionGuard>hostGuard&&tokenRead>sessionGuard);
  const tokenBlock=source.slice(tokenRead,source.indexOf('$AgentId=',tokenRead));
  assert.match(tokenBlock,/WindowsPrincipal\]::new\(\$GuestIdentity\)/);
  assert.match(tokenBlock,/administratorToken=\[bool\]\$GuestPrincipal\.IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
  assert.match(tokenBlock,/finally\{if\(\$GuestIdentity\)\{\$GuestIdentity\.Dispose\(\)\}\}/);
  assert.match(tokenBlock,/catch\{[\s\S]*\$GuestPrivileges=\$null/);
  assert.match(source,/function Write-Heartbeat\{[\s\S]*privileges=\$GuestPrivileges/);
});

test('Windows PowerShell parses the guest agent without executing its entry point',{skip:process.platform!=='win32'},async()=>{
  const script='$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseFile($env:BLACKICE_PRIVILEGES_AGENT_SOURCE,[ref]$tokens,[ref]$errors);if($errors.Count){[Console]::Error.WriteLine("Guest source parse failed");exit 1};[Console]::WriteLine("parsed-only")';
  const result=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',script],{
    windowsHide:true,timeout:15000,maxBuffer:32768,env:{...process.env,BLACKICE_PRIVILEGES_AGENT_SOURCE:agentScript}
  });
  assert.equal(result.stdout.trim(),'parsed-only');
});
