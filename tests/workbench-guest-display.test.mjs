import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile),quote=value=>"'"+value.replaceAll("'","''")+"'";
test('guest display companion compiles correct Win32 layout and rejects host execution before display APIs',
  {skip:process.platform!=='win32'},async t=>{
    const root=await mkdtemp(path.join(tmpdir(),'blackice-display-module-'));t.after(()=>rm(root,{recursive:true,force:true}));
    await mkdir(path.join(root,'.blackice-workbench'));await writeFile(path.join(root,'.blackice-workbench','host-info.json'),JSON.stringify({hostName:process.env.COMPUTERNAME}));
    const module=fileURLToPath(new URL('../scripts/workbench-guest-display.ps1',import.meta.url)),script=path.join(root,'verify.ps1');
    await writeFile(script,`$ErrorActionPreference='Stop'
. ${quote(module)}
[BLACKICEGuestDisplay]::ValidateDimensions(640,480)
[BLACKICEGuestDisplay]::ValidateDimensions(1920,1080)
$invalid=0
foreach($pair in @(@(639,480),@(640,479),@(4097,1080),@(1920,4097))){try{[BLACKICEGuestDisplay]::ValidateDimensions($pair[0],$pair[1])}catch{$invalid++}}
$guarded=0
$cancelled=0
try{[BLACKICEGuestDisplay]::Resize(1920,1080,[Func[bool]]{$false})|Out-Null}catch{if($_.Exception.Message -notmatch 'expired or was cancelled'){throw};$cancelled++}
try{Get-BLACKICEGuestDisplayInfo -WorkspaceRoot ${quote(root)} -GuestSessionId ([Diagnostics.Process]::GetCurrentProcess().SessionId)|Out-Null}catch{if($_.Exception.Message -notmatch 'Refusing.*host display'){throw};$guarded++}
try{Set-BLACKICEGuestDisplaySize -Width 1920 -Height 1080 -WorkspaceRoot ${quote(root)} -GuestSessionId ([Diagnostics.Process]::GetCurrentProcess().SessionId)|Out-Null}catch{if($_.Exception.Message -notmatch 'Refusing.*host display'){throw};$guarded++}
[ordered]@{modeBytes=[Runtime.InteropServices.Marshal]::SizeOf([type][BLACKICEGuestDisplay+Mode]);invalidRejected=$invalid;hostGuards=$guarded;cancelledBeforeApis=$cancelled;displayApisInvoked=$false}|ConvertTo-Json -Compress
`);
    const {stdout}=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,shell:false,timeout:15000,maxBuffer:16000});
    assert.deepEqual(JSON.parse(stdout.trim()),{modeBytes:220,invalidRejected:4,hostGuards:2,cancelledBeforeApis:1,displayApisInvoked:false});
  });
