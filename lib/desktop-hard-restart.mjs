import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readAccessRuntime } from './remote-access-cli.mjs';
import { DESKTOP_RESTART_ORIGIN_ENV } from './desktop-restart-origin.mjs';
import { buildDesktopRelaunchArgs } from '../desktop/lifecycle.mjs';

const execute = promisify(execFile);
const fail = (code, message) => Object.assign(new Error(message), { code });
const samePath = (a, b) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
const native = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class BlackiceProcessHandle {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h,out long created,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr h,int flags,StringBuilder name,ref int size);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int kind,IntPtr data,int length,out int returned);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 public static string[] Identity(IntPtr h) { long c,e,k,u; if(!GetProcessTimes(h,out c,out e,out k,out u)) throw new Win32Exception(); var b=new StringBuilder(32768); int n=b.Capacity; if(!QueryFullProcessImageName(h,0,b,ref n)) throw new Win32Exception(); return new[]{c.ToString(),b.ToString()}; }
 public static string[] Arguments(IntPtr h) {
  int length; NtQueryInformationProcess(h,60,IntPtr.Zero,0,out length); if(length <= 0 || length > 131072) throw new Exception("Command line unavailable");
  IntPtr b=Marshal.AllocHGlobal(length); try {
   if(NtQueryInformationProcess(h,60,b,length,out length)!=0) throw new Exception("Command line unavailable");
   int chars=(ushort)Marshal.ReadInt16(b)/2; IntPtr text=Marshal.ReadIntPtr(b,IntPtr.Size==8?8:4);
   string line=Marshal.PtrToStringUni(text,chars); int count; IntPtr argv=CommandLineToArgvW(line,out count); if(argv==IntPtr.Zero) throw new Win32Exception();
   try { var result=new string[count]; for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv,i*IntPtr.Size)); return result; } finally { LocalFree(argv); }
  } finally { Marshal.FreeHGlobal(b); }
 }
}`;
const common = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${native}\n'@\n`;
const identityScript = common + `
$h=[BlackiceProcessHandle]::OpenProcess(0x1000,$false,[int]$env:BLACKICE_RESTART_PID)
if ($h -eq [IntPtr]::Zero) { throw 'Cannot open process' }
try { $v=[BlackiceProcessHandle]::Identity($h); @{pid=[int]$env:BLACKICE_RESTART_PID;created=$v[0];image=$v[1]} | ConvertTo-Json -Compress }
finally { [void][BlackiceProcessHandle]::CloseHandle($h) }
`;
const discoveryScript = common + `
$all=@(); foreach($p in [Diagnostics.Process]::GetProcessesByName($env:BLACKICE_RESTART_NAME)) {
 $h=[BlackiceProcessHandle]::OpenProcess(0x1000,$false,$p.Id)
 if($h -eq [IntPtr]::Zero) { continue }
 try { $i=[BlackiceProcessHandle]::Identity($h); $a=[BlackiceProcessHandle]::Arguments($h); $all+=@{pid=$p.Id;created=$i[0];image=$i[1];argv=@($a)} } catch {} finally { [void][BlackiceProcessHandle]::CloseHandle($h) }
}
ConvertTo-Json -InputObject @($all) -Compress -Depth 4
`;
// The handle, identity check, termination, one-shot claim, and replacement
// launch are owned by one helper. Never turn this into a PID-only Stop-Process.
const forceScript = common + `
$v=$env:BLACKICE_RESTART_INPUT | ConvertFrom-Json
$mutex=New-Object System.Threading.Mutex($false, ('Local\\BLACKICE-Restart-' + $v.profileHash))
$locked=$false; $h=[IntPtr]::Zero
try {
 try { $locked=$mutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $locked=$true }
 if (!$locked) { throw 'Another restart is already running.' }
 $h=[BlackiceProcessHandle]::OpenProcess(0x00101001,$false,[int]$v.pid)
 if ($h -eq [IntPtr]::Zero) { throw 'The original BLACKICE process could not be opened.' }
 $i=[BlackiceProcessHandle]::Identity($h)
 if ($i[0] -cne $v.created -or ![string]::Equals($i[1],$v.image,[StringComparison]::OrdinalIgnoreCase)) { throw 'The original process identity changed.' }
 if ([BlackiceProcessHandle]::WaitForSingleObject($h,0) -ne 258) { throw 'The original process has already exited; replacement is uncertain.' }
 $durable=$false; $claimed=$false
 try {
  [IO.Directory]::CreateDirectory($v.claimDir) | Out-Null
  $f=[IO.File]::Open($v.claimFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  $claimed=$true
  try { $b=[Text.Encoding]::UTF8.GetBytes($v.claim); $f.Write($b,0,$b.Length); $f.Flush($true) } finally { $f.Dispose() }
  $durable=$true
 } catch [IO.IOException] {
  if (!$claimed -and [IO.File]::Exists($v.claimFile)) { throw 'This restart request was already dispatched; its outcome is uncertain.' }
 } catch { }
 if (![BlackiceProcessHandle]::TerminateProcess($h,1)) { throw 'The original BLACKICE process could not be terminated.' }
 if ([BlackiceProcessHandle]::WaitForSingleObject($h,10000) -ne 0) { throw 'Termination could not be confirmed; replacement is uncertain.' }
 # A native handoff may already be armed. Give it time to publish a new owner.
 $replacement=$false
 for ($n=0; $n -lt 30; $n++) {
  Start-Sleep -Milliseconds 100
  try {
   $r=Get-Content -LiteralPath $v.runtimeFile -Raw | ConvertFrom-Json
   if ($r.pid -ne $v.pid -and $r.hardRestart.identity.created -and $r.lifecycle.mode -eq $v.mode) {
    $p=[BlackiceProcessHandle]::OpenProcess(0x1000,$false,[int]$r.pid)
    if ($p -ne [IntPtr]::Zero) { try { $j=[BlackiceProcessHandle]::Identity($p); if ($j[0] -ceq $r.hardRestart.identity.created -and [string]::Equals($j[1],$v.image,[StringComparison]::OrdinalIgnoreCase)) { $replacement=$true; break } } finally { [void][BlackiceProcessHandle]::CloseHandle($p) } }
   }
  } catch { }
 }
 if (!$replacement) {
  $start=New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName=$v.image; $start.Arguments=$v.arguments; $start.UseShellExecute=$true
  $start.WorkingDirectory=$v.cwd
  Remove-Item Env:BLACKICE_RESTART_INPUT -ErrorAction SilentlyContinue
  Remove-Item Env:${DESKTOP_RESTART_ORIGIN_ENV} -ErrorAction SilentlyContinue
  $p=[Diagnostics.Process]::Start($start); if (!$p) { throw 'The replacement could not be launched.' }
 }
 @{ outcome=$(if($replacement){'replacement_observed'}else{'replacement_launched'}); durableClaim=$durable; confirmedStarted=$replacement; nativeHandoffUncertain=$true } | ConvertTo-Json -Compress
} finally { if($h -ne [IntPtr]::Zero){[void][BlackiceProcessHandle]::CloseHandle($h)}; if($locked){$mutex.ReleaseMutex()}; $mutex.Dispose() }
`;

async function powershell(script, env, options = {}) {
  const exe = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) if (key.toUpperCase() === DESKTOP_RESTART_ORIGIN_ENV.toUpperCase()) delete inherited[key];
  const result = await execute(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, shell: false, timeout: 30000, maxBuffer: 65536, ...options, env: { ...inherited, ...env } });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

export async function windowsProcessIdentity(pid = process.pid) {
  if (process.platform !== 'win32') return null;
  const value = await powershell(identityScript, { BLACKICE_RESTART_PID: String(pid) });
  if (value.pid !== pid || !/^\d{15,20}$/.test(value.created) || !path.win32.isAbsolute(value.image)) throw fail('DESKTOP_RESTART_IDENTITY', 'The Windows process identity could not be verified.');
  return value;
}

// Windows command-line quoting matching CommandLineToArgvW.
export function quoteWindowsArgument(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

/** Discover only an unambiguous main process whose own handle reports this
 * executable and profile. Command-line mode is an inference if no record exists. */
export async function discoverWindowsRestartTarget(profile, context = {}) {
  if (!context.expectedExecutable || !context.defaultProfile) throw fail('DESKTOP_RESTART_HARD_IDENTITY', 'The intended executable and default profile are required for process discovery.');
  const expected = await fs.realpath(context.expectedExecutable);
  const candidates = await powershell(discoveryScript, { BLACKICE_RESTART_NAME: path.win32.basename(context.expectedExecutable, '.exe') });
  const matched = [];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate.argv) || candidate.argv.length < 1 || !candidate.image || !/^\d{15,20}$/.test(candidate.created)) continue;
    let image; try { image = await fs.realpath(candidate.image); } catch { continue; }
    if (!samePath(expected, image)) continue;
    const argv = candidate.argv, args = argv.slice(1);
    if (args.some(value => /^--(?:type|restart|restart-status|cancel-restart|quit|access-code)(?:=|$)/.test(value)) || args.some(value => value === 'browser' || value === 'remote')) continue;
    if (context.appDirectory && (!args.length || !samePath(args[0], context.appDirectory))) continue;
    let selected = context.defaultProfile, explicit = false, invalid = false, headless = false, background = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--headless') headless = true;
      else if (arg === '--background') background = true;
      else if (/^--(?:profile-dir|profile)(?:=|$)/.test(arg)) {
        if (explicit) { invalid = true; break; }
        explicit = true; selected = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index];
      }
    }
    if (invalid || headless && background || typeof selected !== 'string' || !path.win32.isAbsolute(selected) || !samePath(selected, profile)) continue;
    const mode = headless ? 'headless' : background ? 'background' : 'window';
    const relaunchArgs = buildDesktopRelaunchArgs({ argv, profileDir: explicit ? selected : null, mode, showInactive: true });
    matched.push({ identity: { pid: candidate.pid, created: candidate.created, image: candidate.image }, mode, args: relaunchArgs });
  }
  if (matched.length !== 1) throw fail('DESKTOP_RESTART_HARD_IDENTITY', matched.length ? 'More than one BLACKICE process matches this profile; emergency restart was not dispatched.' : 'No BLACKICE process with the selected executable and profile could be verified.');
  return matched[0];
}

export async function forceWindowsRestart(options, context = {}) {
  if (process.platform !== 'win32') throw fail('DESKTOP_RESTART_HARD_PLATFORM', 'Emergency restart is currently available on Windows.');
  const profile = options['profile-dir'] || context.defaultProfile;
  if (!profile || !path.isAbsolute(profile)) throw fail('DESKTOP_RESTART_HARD_PROFILE', 'Choose the running BLACKICE profile.');
  let target, inferredMode = false;
  try {
    const runtime = await readAccessRuntime(profile, { expectedExecutable: context.expectedExecutable });
    const raw = JSON.parse(await fs.readFile(path.join(profile, 'desktop-runtime.json'), 'utf8'));
    const identity = raw.hardRestart?.identity, args = raw.hardRestart?.args, mode = raw.lifecycle?.mode;
    if (runtime.pid !== raw.pid || runtime.startedAt !== raw.startedAt || !samePath(runtime.executable, raw.executable) || !identity || identity.pid !== runtime.pid || !/^\d{15,20}$/.test(identity.created) || !path.win32.isAbsolute(identity.image || '') || !Array.isArray(args) || args.some(value => typeof value !== 'string' || /[\x00-\x1f]/.test(value)) || !['window', 'background', 'headless'].includes(mode)) throw Error('No exact runtime identity');
    const [recordedImage, nativeImage] = await Promise.all([fs.realpath(runtime.executable), fs.realpath(identity.image)]);
    if (!samePath(recordedImage, nativeImage)) throw Error('Different executable');
    target = { identity, args, mode };
  } catch {
    target = await discoverWindowsRestartTarget(profile, context); inferredMode = true;
  }
  const { identity, args, mode } = target;
  if (context.expectedIdentity && (identity.pid !== context.expectedIdentity.pid || identity.created !== context.expectedIdentity.created || !samePath(identity.image, context.expectedIdentity.image))) throw fail('DESKTOP_RESTART_HARD_UNCERTAIN', 'The original process changed during the native handoff; inspect BLACKICE before retrying.');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const profileHash = hash(path.resolve(profile).toLowerCase()), claimDir = path.join(context.tempDir || os.tmpdir(), 'BLACKICE-restart-claims');
  const claimFile = path.join(claimDir, hash(profileHash + ':' + options['request-id']) + '.json');
  const input = { ...identity, mode, profileHash, runtimeFile: path.join(profile, 'desktop-runtime.json'), arguments: args.map(quoteWindowsArgument).join(' '), cwd: path.dirname(identity.image), claimDir, claimFile, claim: JSON.stringify({ requestId: options['request-id'], pid: identity.pid, created: identity.created }) };
  try {
    const outcome = await powershell(forceScript, { BLACKICE_RESTART_INPUT: JSON.stringify(input) });
    return { protocol: 'emergency-force', requestId: options['request-id'], ...outcome, mode, modeInferredFromLaunch: inferredMode, message: 'The original process stopped. Reconnect and inspect BLACKICE to confirm the replacement; emergency claims are not available through --restart-status. Interrupted actions and any native handoff may have unknown outcomes.' };
  } catch (error) { throw fail('DESKTOP_RESTART_HARD_UNCERTAIN', `Emergency restart could not be confirmed. Inspect BLACKICE before retrying the same request. ${String(error.stderr || error.message).replace(/\s+/g, ' ').slice(0, 300)}`); }
}
