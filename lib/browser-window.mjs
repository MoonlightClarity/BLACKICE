import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {stat} from 'node:fs/promises';

const execFileAsync=promisify(execFile);
/**
 * Explicit, user-initiated BrowserOS window reveal. NEVER called by agent
 * execution, capability discovery, a sign-in event, or background startup.
 * Inputs are fixed installed paths, not arbitrary agent-provided URLs.
 */
const REVEAL_SCRIPT=String.raw`$ErrorActionPreference='Stop'
$exe=[Environment]::GetEnvironmentVariable('AGENT_DESK_NEO_EXE')
$profile=[Environment]::GetEnvironmentVariable('AGENT_DESK_NEO_PROFILE')
if(-not [IO.File]::Exists($exe) -or -not [IO.Directory]::Exists($profile)){throw 'BrowserOS is not installed with an existing profile.'}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class AgentDeskNeoWindow {
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd,int nCmdShow);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
function FindMain {
 $existing=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { [string]::Equals($_.ExecutablePath,$exe,[StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '--type=' })
 foreach($item in $existing){
   $p=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
   if($p -and $p.MainWindowHandle -ne [IntPtr]::Zero){return $p}
 }
 return $null
}
$main=FindMain
$started=$false
if(-not $main){
 Start-Process -FilePath $exe -WorkingDirectory ([IO.Path]::GetDirectoryName($exe)) -ArgumentList @('--no-first-run','--no-default-browser-check','--new-window','chrome://newtab/',('--user-data-dir="'+$profile+'"')) | Out-Null
 $started=$true
 for($i=0;$i -lt 50;$i++){Start-Sleep -Milliseconds 140;$main=FindMain;if($main){break}}
}
if(-not $main){[pscustomobject]@{shown=$false;started=$started;focused=$false;reason='BrowserOS window is starting. Use its taskbar icon if it does not appear.'}|ConvertTo-Json -Compress;exit}
$handle=[IntPtr]$main.MainWindowHandle
[void][AgentDeskNeoWindow]::ShowWindowAsync($handle,9)
$focused=[AgentDeskNeoWindow]::SetForegroundWindow($handle)
[pscustomobject]@{shown=[AgentDeskNeoWindow]::IsWindowVisible($handle);started=$started;focused=[bool]$focused}|ConvertTo-Json -Compress
`;
export async function revealBrowserOS({
  env=process.env,platform=process.platform,statImpl=stat,execFileImpl=execFileAsync,
}={}) {
  if(platform!=='win32')throw new Error('Opening BrowserOS is supported only on Windows.');
  const local=env.LOCALAPPDATA;
  if(typeof local!=='string'||!path.win32.isAbsolute(local)||local.includes('\0'))throw new Error('BrowserOS installation path could not be found.');
  const executable=path.win32.join(local,'BrowserClaw','Application','chrome.exe');
  const profile=path.win32.join(local,'BrowserClaw','User Data');
  if(!(await statImpl(executable)).isFile()||!(await statImpl(profile)).isDirectory())throw new Error('BrowserOS is not installed with its existing profile.');
  const result=await execFileImpl('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(REVEAL_SCRIPT,'utf16le').toString('base64')],{
    env:{...env,AGENT_DESK_NEO_EXE:executable,AGENT_DESK_NEO_PROFILE:profile},
    windowsHide:true,timeout:13000,maxBuffer:16384,encoding:'utf8',
  });
  let state;
  try{state=JSON.parse(String(result.stdout||'').trim().replace(/^\uFEFF/,''));}catch{throw new Error('BrowserOS did not confirm that its window was opened.');}
  if(typeof state.shown!=='boolean'||typeof state.focused!=='boolean'||typeof state.started!=='boolean')throw new Error('BrowserOS returned an invalid window status.');
  return {shown:state.shown,focused:state.focused,started:state.started,...(!state.shown?{reason:'BrowserOS is starting. Choose Open BrowserOS again if necessary.'}:{})};
}
