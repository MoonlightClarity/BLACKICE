/**
 * One-action Workbench pairing. Hyper-V Guest Service Interface delivers
 * bootstrap files before SMB works; a guest-local watcher remounts W: after
 * sign-in, host IP changes or guest resume.
 */
import {promises as fs} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PAIR_GUEST_ROOT='C:\\Users\\Public\\BLACKICE-Pairing';
export const PAIR_GUEST_ENTRY=PAIR_GUEST_ROOT+'\\workbench-guest-pair-bootstrap.ps1';
const scriptFile=name=>fileURLToPath(new URL('../scripts/'+name,import.meta.url));
const ps=value=>"'"+String(value).replaceAll("'","''")+"'";
const fail=message=>Object.assign(Error(message),{code:'WORKBENCH_PAIR_AUTO',status:409});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const basename=s=>path.win32.basename(s);

export function guestPairingCopyCommand({vmName,hostComputer,workspace,account,password,staged}){
  for(const value of [vmName,hostComputer,account])
    if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value))throw fail('Invalid VM, host or pairing account.');
  if(typeof workspace!=='string'||!path.win32.isAbsolute(workspace)||typeof password!=='string'||password.length<25)throw fail('Invalid pairing workspace or credential.');
  const localUser=hostComputer+'\\'+account;
  const files=staged.map(entry=>({source:entry.source,dest:PAIR_GUEST_ROOT+'\\'+basename(entry.name)}));
  const copies=files.map(({source,dest})=>'Copy-VMFile -Name '+ps(vmName)+' -SourcePath '+ps(source)+' -DestinationPath '+ps(dest)+' -FileSource Host -CreateFullPath -Force -ErrorAction Stop').join('\n');
  return [
    "$ErrorActionPreference='Stop'",
    '$name='+ps(account),
    '$workspace='+ps(workspace),
    '$account='+ps(localUser),
    '$password='+ps(password),
    '$secret=ConvertTo-SecureString -String $password -AsPlainText -Force',
    "if(!(Test-Path -LiteralPath $workspace -PathType Container)){throw 'Workbench workspace folder missing.'}",
    '$existing=Get-LocalUser -Name $name -ErrorAction SilentlyContinue',
    'if($existing){Set-LocalUser -Name $name -Password $secret -ErrorAction Stop;if(!$existing.Enabled){Enable-LocalUser -Name $name -ErrorAction Stop}}',
    'else{New-LocalUser -Name $name -Password $secret -PasswordNeverExpires -ErrorAction Stop|Out-Null}',
    "$share=Get-SmbShare -Name 'BLACKICE-Workspace' -ErrorAction SilentlyContinue",
    "if(!$share){New-SmbShare -Name 'BLACKICE-Workspace' -Path $workspace -ChangeAccess $account -ErrorAction Stop|Out-Null}",
    "elseif([IO.Path]::GetFullPath([string]$share.Path).TrimEnd('\\') -ine [IO.Path]::GetFullPath($workspace).TrimEnd('\\')){throw 'Existing BLACKICE share points to another folder.'}",
    "else{Grant-SmbShareAccess -Name 'BLACKICE-Workspace' -AccountName $account -AccessRight Change -Force -ErrorAction Stop|Out-Null}",
    '$rights=$account+\":(OI)(CI)M\"',
    '& icacls.exe $workspace /grant $rights|Out-Null',
    "if($LASTEXITCODE -ne 0){throw 'Workbench share folder cannot grant write access.'}",
    "$service=Get-VMIntegrationService -VMName "+ps(vmName)+" -Name 'Guest Service Interface' -ErrorAction Stop",
    "if(!$service.Enabled){Enable-VMIntegrationService -VMName "+ps(vmName)+" -Name 'Guest Service Interface' -ErrorAction Stop}",
    copies,
    "Write-Output 'BLACKICE_PAIR_BOOTSTRAP_COPIED'"
  ].join('\n');
}
const scan=async(workbench,scanCode,flags)=>workbench.guestNativeConsoleInput({kind:'key',scanCode,flags});
async function openGuestRunDialog(workbench){
  // Windows + R inside the guest; neither host keyboard nor foreground changes.
  await scan(workbench,0x5b,0x0100);
  try{
    await scan(workbench,0x13,0);
    await scan(workbench,0x13,0x8000);
  }finally{await scan(workbench,0x5b,0x8100)}
  await wait(450);
}
export async function autoPairWorkbench(workbench,{pollAttempts=28,intervalMs=1100}={}){
  if(!workbench||typeof workbench.status!=='function'||typeof workbench.command!=='function')throw fail('Workbench backend unavailable.');
  const before=await workbench.status({fresh:true});
  if(before.guest?.agent?.paired===true&&before.workspaceReady===true)
    return {status:'paired',unchanged:true,vmName:before.vmName,hostComputer:before.capability?.hostName,drive:'W:',guest:before.guest.agent,workspaceReady:true};
  if(!before.guest?.running)throw fail('Start the existing Workbench VM first.');
  if(!before.capability?.canManageVM)throw fail('Hyper-V management unavailable.');
  const workspace=before.config?.folders?.[0]?.hostPath;
  const hostComputer=before.capability?.hostName,vmName=before.vmName;
  if(!workspace||!hostComputer||!vmName)throw fail('Workbench host identity or workspace missing.');
  await workbench.prepareGuestAgent();
  const folder=await fs.mkdtemp(path.join(tmpdir(),'blackice-workbench-pair-'));
  const password=randomBytes(36).toString('base64')+'Aa9!';
  const settings={hostComputer,shareName:'BLACKICE-Workspace',account:hostComputer+'\\BLACKICEWBLink',password};
  let handoff=false;
  try{
    const files=[
      {name:'workbench-guest-reconnect.ps1',source:scriptFile('workbench-guest-reconnect.ps1')},
      {name:'workbench-guest-pair-bootstrap.ps1',source:scriptFile('workbench-guest-pair-bootstrap.ps1')},
      {name:'share-bootstrap.json',source:path.join(folder,'share-bootstrap.json')}
    ];
    await fs.writeFile(files[2].source,JSON.stringify(settings),{mode:0o600});
    const command=guestPairingCopyCommand({vmName,hostComputer,workspace,account:'BLACKICEWBLink',password,staged:files});
    const output=await workbench.command(command,55000);
    if(!output.includes('BLACKICE_PAIR_BOOTSTRAP_COPIED'))throw fail('Guest bootstrap delivery was not confirmed.');
    const owner=workbench.consoleControl.status();
    if(owner.owner==='user'){
      await workbench.consoleControl.handoffToAgent(owner.revision);
      handoff=true;
    }else if(owner.owner!=='agent')throw fail('Workbench guest input is unavailable.');
    try{await workbench.guestNativeConsoleWake()}catch{}
    await openGuestRunDialog(workbench);
    const launch='powershell.exe -NoProfile -ExecutionPolicy Bypass -File "'+PAIR_GUEST_ENTRY+'"';
    await workbench.guestConsoleType(launch);
    await workbench.guestConsoleKey('ENTER');
    for(let i=0;i<pollAttempts;i++){
      await wait(intervalMs);
      const agent=await workbench.bridge().agentStatus();
      if(agent.online){
        const pair=await workbench.pairGuest();
        const state=await workbench.status({fresh:true});
        if(state.guest?.agent?.paired&&state.workspaceReady)
          return {status:'paired',vmName,hostComputer,drive:'W:',guest:state.guest.agent,workspaceReady:true,handshake:pair};
        return {status:'started',vmName,hostComputer,drive:'W:',paired:false,guest:state.guest.agent};
      }
    }
    return {status:'pending',vmName,hostComputer,drive:'W:',message:'Bootstrap delivered and launched, but no fresh guest heartbeat observed. Reconnect helper remains configured to retry.'};
  }finally{
    await fs.rm(folder,{recursive:true,force:true}).catch(()=>{});
    if(handoff&&workbench.consoleControl.status().owner==='agent'){
      await workbench.consoleControl.take();
    }
  }
}
