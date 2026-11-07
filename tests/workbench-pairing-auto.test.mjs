import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {autoPairWorkbench,guestPairingCopyCommand,PAIR_GUEST_ENTRY} from '../lib/workbench-pairing.mjs';

test('repeating Pair & auto-repair on a healthy guest never rotates its working credential',async()=>{
  let mutations=0;
  const guest={paired:true,online:true,agentId:'existing-session'};
  const wb={
    async status(){return {vmName:'BLACKICE-Workbench',guest:{running:true,agent:guest},workspaceReady:true,capability:{hostName:'HOST'}}},
    async prepareGuestAgent(){mutations++},async command(){mutations++}
  };
  const result=await autoPairWorkbench(wb);
  assert.equal(result.status,'paired');assert.equal(result.unchanged,true);
  assert.equal(mutations,0);
});

test('host bootstrap configures a working share account and copies setup into the VM independent of SMB',()=>{
  const command=guestPairingCopyCommand({
    vmName:'BLACKICE-Workbench',hostComputer:'DESKTOP-TEST',workspace:'C:\\Users\\User\\Relay\\workspace',
    account:'BLACKICEWBLink',password:'ExampleBase64Password0123abcd98765Aa9!',
    staged:[{name:'workbench-guest-reconnect.ps1',source:'C:\\temp\\workbench-guest-reconnect.ps1'},
      {name:'workbench-guest-pair-bootstrap.ps1',source:'C:\\temp\\workbench-guest-pair-bootstrap.ps1'},
      {name:'share-bootstrap.json',source:'C:\\temp\\share-bootstrap.json'}]
  });
  assert.match(command,/Set-LocalUser -Name \$name -Password \$secret/);
  assert.match(command,/New-LocalUser -Name \$name -Password \$secret/);
  assert.match(command,/Grant-SmbShareAccess/);
  assert.equal((command.match(/Copy-VMFile/g)||[]).length,3);
  assert.match(command,/Guest Service Interface/);
  assert.ok(!command.includes('Remove-VM '),'never recreate or delete the guest');
});

test('reconnect can start before W: exists',()=>{
  const source=readFileSync(fileURLToPath(new URL('../scripts/workbench-guest-reconnect.ps1',import.meta.url)),'utf8');
  assert.ok(source.includes("$bridge=$driveRoot+'.blackice-workbench'"));
  assert.ok(source.includes("($bridge+'\\host-info.json')"));
  assert.equal(source.includes("$bridge=Join-Path $driveRoot"),false);
});

test('guest watcher is persistent, self-contained and restores its W drive across changing host IPs',()=>{
  const source=readFileSync(fileURLToPath(new URL('../scripts/workbench-guest-reconnect.ps1',import.meta.url)),'utf8');
  const bootstrap=readFileSync(fileURLToPath(new URL('../scripts/workbench-guest-pair-bootstrap.ps1',import.meta.url)),'utf8');
  for(const phrase of ['Local\\BLACKICE-Workbench-Watch','Get-NetIPConfiguration','New-PSDrive','Guest-ShareReady','Guest-Agent-Alive','Start-Sleep -Seconds $IntervalSeconds','-Persist -Scope Global'])assert.ok(source.includes(phrase),phrase);
  for(const phrase of ['Export-Clixml','BLACKICE-Workbench-Reconnect','-Watch -IntervalSeconds 15','& $localReconnect -Once','Remove-Item -LiteralPath $secretFile'])assert.ok(bootstrap.includes(phrase),phrase);
  assert.match(PAIR_GUEST_ENTRY,/C:\\Users\\Public\\BLACKICE-Pairing\\workbench-guest-pair-bootstrap\.ps1/);
});

test('agent-authorized auto-pair stages and launches guest bootstrap, waits for handshake, restores user ownership',async()=>{
  const events=[];
  let owner='user',revision=8,paired=false;
  const agent={online:true,paired:true,sharedReadWriteVerified:true,guestSessionId:34,agentId:'a',capabilities:['probe','capture']};
  const wb={
    async status(){return {vmName:'BLACKICE-Workbench',guest:{running:true,agent:{paired}},workspaceReady:paired,
      capability:{canManageVM:true,hostName:'DESKTOP-TEST'},config:{folders:[{hostPath:'C:\\Users\\User\\Relay\\workspace'}]}}},
    async prepareGuestAgent(){events.push('prepare')},
    async command(script){assert.match(script,/Copy-VMFile/);events.push('host-copied');return 'BLACKICE_PAIR_BOOTSTRAP_COPIED'},
    consoleControl:{status(){return {owner,revision}},async handoffToAgent(expected){assert.equal(expected,revision);owner='agent';revision++;events.push('agent-control')},async take(){owner='user';revision++;events.push('user-control')}},
    async guestNativeConsoleWake(){events.push('wake')},
    async guestNativeConsoleInput(input){assert.equal(input.kind,'key');events.push(input.scanCode+':'+input.flags)},
    async guestConsoleType(text){assert.match(text,/workbench-guest-pair-bootstrap/);events.push('type')},
    async guestConsoleKey(key){assert.equal(key,'ENTER');events.push('enter')},
    bridge(){return{async agentStatus(){events.push('online');return agent}}},
    async pairGuest(){paired=true;events.push('challenge');return {paired:true}}
  };
  const receipt=await autoPairWorkbench(wb,{pollAttempts:1,intervalMs:1});
  assert.equal(receipt.status,'paired');
  assert.equal(receipt.workspaceReady,true);
  assert.equal(owner,'user');
  assert.deepEqual(events.filter(x=>['prepare','host-copied','agent-control','type','enter','online','challenge','user-control'].includes(x)),
    ['prepare','host-copied','agent-control','type','enter','online','challenge','user-control']);
});

test('no heartbeat remains pending, not a false successful pairing',async()=>{
  let owner='agent';
  const wb={
    async status(){return {vmName:'BLACKICE-Workbench',guest:{running:true,agent:{paired:false}},workspaceReady:false,
      capability:{canManageVM:true,hostName:'DESKTOP-TEST'},config:{folders:[{hostPath:'C:\\temp\\workspace'}]}}},
    async prepareGuestAgent(){},async command(){return 'BLACKICE_PAIR_BOOTSTRAP_COPIED'},
    consoleControl:{status(){return{owner,revision:1}}},
    async guestNativeConsoleWake(){},async guestNativeConsoleInput(){},async guestConsoleType(){},async guestConsoleKey(){},
    bridge(){return{async agentStatus(){return {online:false}}}}
  };
  const result=await autoPairWorkbench(wb,{pollAttempts:1,intervalMs:1});
  assert.equal(result.status,'pending');assert.equal(owner,'agent');
});
