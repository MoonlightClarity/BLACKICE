import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ConnectionStartup } from '../lib/connection-startup.mjs';

const execute = promisify(execFile);
const fail = (message, code = 'CONNECTION_STARTUP_FAILED') => Object.assign(new Error(message), { code, status: 409 });
const encode = script => Buffer.from(script, 'utf16le').toString('base64');
const psValue = value => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(value)).toString('base64')}')) | ConvertFrom-Json`;
const bool = value => typeof value === 'boolean' ? value : null;
const CAPTURE_TAILSCALE = String.raw`
function Read-Tailscale([string[]]$CliArgs) {
  # Windows PowerShell 5 treats native stderr as an ErrorRecord. Capture only
  # stdout and the exit code without throwing or returning private stderr.
  $ErrorActionPreference = 'Continue'
  $text = (& $exe @CliArgs 2>$null | Out-String).Trim()
  return [pscustomobject]@{ Text = $text; ExitCode = $LASTEXITCODE }
}
`;

/** No shell interpolation, credentials, policy changes or arbitrary command input. */
export async function runStartupPowerShell(script, { mutation = false, execFileImpl = execute, spawnImpl = spawn, systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  const file = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encode(script)];
  if (!mutation) {
    try { return (await execFileImpl(file, args, { windowsHide: true, timeout: 12000, maxBuffer: 65536, encoding: 'utf8' })).stdout; }
    catch { throw fail('Windows startup settings could not be read.', 'CONNECTION_STARTUP_READ_FAILED'); }
  }
  // A UAC child may outlive a killed wrapper. Do not add a timeout, abort or
  // detached spawn here. The parent waits for the elevated helper; our promise
  // represents its actual process exit and blocks restart until then.
  return new Promise((resolve, reject) => {
    let child; try { child = spawnImpl(file, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(fail('Windows could not start the automatic startup helper.')); return; }
    let output = '', spawnError = false;
    child.stdout.on('data', chunk => { if (output.length < 4096) output += String(chunk).slice(0, 4096 - output.length); });
    child.stderr.on('data', () => {});
    child.once('error', () => { spawnError = true; });
    child.once('close', code => {
      if (spawnError || code !== 0) reject(fail(code === 1223 ? 'Windows permission was cancelled. Automatic startup was not confirmed.' : 'Windows could not complete automatic startup. Review the startup checks.', code === 1223 ? 'CONNECTION_STARTUP_CANCELLED' : 'CONNECTION_STARTUP_FAILED'));
      else resolve(output);
    });
  });
}

export const TAILSCALE_STARTUP_INSPECT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${CAPTURE_TAILSCALE}
$exe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$svc = Get-CimInstance Win32_Service -Filter "Name='Tailscale'"
$result = [ordered]@{ installed = (Test-Path -LiteralPath $exe); servicePresent = ($null -ne $svc); serviceAutomatic = ($svc.StartMode -eq 'Auto'); serviceRunning = ($svc.State -eq 'Running'); unattended = $null; connected = $null; supported = $false }
if ($result.installed -and $result.serviceRunning) {
  $raw = Read-Tailscale @('get','unattended')
  if ($raw.ExitCode -eq 0 -and $raw.Text -match '^(true|false)$') { $result.unattended = ($raw.Text -eq 'true'); $result.supported = $true }
  $statusText = Read-Tailscale @('status','--json')
  if ($statusText.ExitCode -eq 0) {
    $state = $statusText.Text | ConvertFrom-Json
    $result.connected = ($state.BackendState -eq 'Running' -and $state.Self.Online -eq $true)
  }
}
$result | ConvertTo-Json -Compress
`;

const REPAIR_SERVICE_FUNCTION = String.raw`
function Repair-TailscaleService {
  $svc = Get-CimInstance Win32_Service -Filter "Name='Tailscale'"
  if ($null -eq $svc) { throw 'Tailscale service is missing.' }
  if ($svc.StartMode -ne 'Auto') { Set-Service -Name Tailscale -StartupType Automatic }
  if ($svc.State -ne 'Running') { Start-Service -Name Tailscale; (Get-Service Tailscale).WaitForStatus('Running', [TimeSpan]::FromSeconds(20)) }
}
`;
// This is the complete elevated operation. It does not invoke `up`, touch
// authentication, routes, DNS, key expiry, firewall policy or scheduled tasks.
export const TAILSCALE_SERVICE_REPAIR = String.raw`
$ErrorActionPreference = 'Stop'
${REPAIR_SERVICE_FUNCTION}
try { Repair-TailscaleService; exit 0 } catch { exit 3 }
`;

export function tailscaleStartupRepairScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${CAPTURE_TAILSCALE}
${REPAIR_SERVICE_FUNCTION}
try {
  $exe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (-not (Test-Path -LiteralPath $exe)) { exit 2 }
  $svc = Get-CimInstance Win32_Service -Filter "Name='Tailscale'"
  if ($null -eq $svc) { exit 2 }
  if ($svc.StartMode -ne 'Auto' -or $svc.State -ne 'Running') {
    try { Repair-TailscaleService }
    catch {
      # Try the current token first. Prompt only for an observed permission
      # failure, not a missing service, timeout or unrelated service error.
      $denied = ($_.CategoryInfo.Category -eq 'PermissionDenied')
      for ($cause = $_.Exception; $null -ne $cause; $cause = $cause.InnerException) {
        if ($cause -is [UnauthorizedAccessException] -or $cause.NativeErrorCode -eq 5) { $denied = $true }
      }
      $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      if (-not $denied -or $admin) { exit 3 }
      $serviceArgs = @('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${encode(TAILSCALE_SERVICE_REPAIR)}')
      $p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $serviceArgs -Verb RunAs -Wait -PassThru -WindowStyle Hidden
      if ($p.ExitCode -ne 0) { exit 3 }
    }
  }
  # Set the one preference in the ORIGINAL user's context. An elevation using a
  # different administrator account must never claim that account's tailnet.
  $current = Read-Tailscale @('get','unattended')
  if ($current.ExitCode -ne 0 -or $current.Text -notmatch '^(true|false)$') { exit 4 }
  $statusText = Read-Tailscale @('status','--json')
  if ($statusText.ExitCode -ne 0) { exit 5 }
  $state = $statusText.Text | ConvertFrom-Json
  if ($state.BackendState -ne 'Running' -or $state.Self.Online -ne $true) { exit 5 }
  if ($current.Text -ne 'true') { $changed = Read-Tailscale @('set','--unattended=true'); if ($changed.ExitCode -ne 0) { exit 6 } }
  $check = Read-Tailscale @('get','unattended')
  if ($check.ExitCode -ne 0 -or $check.Text -ne 'true') { exit 7 }
  exit 0
} catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }; exit 3 }
`;
}

export function tailscaleStartupState(value) {
  const installed = value?.installed === true && value?.servicePresent === true;
  const ready = installed && value.serviceAutomatic === true && value.serviceRunning === true && value.unattended === true;
  let detail = ready ? 'Tailscale is set to start automatically and run unattended. Its Windows tray window does not need to stay open.' : !installed ? 'Install Tailscale and sign in first, then refresh this check.' : !value.serviceRunning ? 'The Tailscale service is stopped. Setup can start it and enable automatic service startup; sign-in may still be needed.' : value.supported !== true || bool(value.unattended) === null ? 'Update Tailscale to a version that supports checking unattended mode, then refresh.' : value.connected !== true ? 'Connect and sign in to Tailscale before enabling unattended mode.' : 'Enable unattended mode and automatic service startup to keep Tailscale available after sign-out or a reboot.';
  return { ready, canEnable: installed && (!value.serviceRunning || value.supported === true && value.connected === true), detail };
}

export function startupLoginSpec({ executable, profileDir, appDir, packaged = true }) {
  for (const value of [executable, profileDir, ...(!packaged ? [appDir] : [])]) if (typeof value !== 'string' || !path.win32.isAbsolute(value) || /^[\\/]{2}/.test(value) || /[\x00-\x1f\x7f"]/.test(value)) throw fail('Automatic startup requires ordinary absolute local application and profile paths.', 'CONNECTION_STARTUP_PATH');
  return { path: path.win32.normalize(executable), args: [...(!packaged ? [path.win32.normalize(appDir)] : []), '--background', '--profile-dir', path.win32.normalize(profileDir)], name: `BLACKICE-${createHash('sha256').update(path.win32.normalize(profileDir).toLowerCase()).digest('hex').slice(0, 16)}` };
}

export function scheduledStartupInspectScript(spec) {
  // A related custom task is reported as managed, never overwritten. Exact
  // task-name matches alone do not prove executable, profile or trigger identity.
  return String.raw`
$ErrorActionPreference = 'Stop'
$spec = ${psValue(spec)}
$found = $false
foreach ($task in @(Get-ScheduledTask -ErrorAction Stop)) {
  if ($task.TaskName -match '(?i)blackice|agent[ -]?desk|relay') { $found = $true; break }
  foreach ($action in @($task.Actions)) {
    if ($action.Execute -eq $spec.path -or ([string]$action.Arguments).IndexOf($spec.path, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $found = $true; break }
  }
  if ($found) { break }
}
@{ relatedTask = $found } | ConvertTo-Json -Compress
`;
}

// Electron 44's login getter reads the default AppUserModelID rather than our
// named profile value, and Chromium GetArgs() drops switches from launchItems.
// Verify the actual owned command with the Windows argv parser instead.
export const STARTUP_COMMANDLINE_NATIVE = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BlackiceStartupCommandLine {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
  private static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);
  public static string Approval(byte[] value) {
    if (value == null || value.Length != 12) return "unknown";
    uint code = BitConverter.ToUInt32(value, 0);
    if (code == 0 || code == 2) return "enabled";
    if (code == 3) return "disabled";
    return "unknown";
  }
  public static bool Matches(string command, string executable, string[] expectedArgs) {
    if (String.IsNullOrWhiteSpace(command)) return false;
    int count; IntPtr memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new InvalidOperationException("Windows could not parse the startup command.");
    try {
      if (count != expectedArgs.Length + 1) return false;
      if (!String.Equals(Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, 0)), executable, StringComparison.OrdinalIgnoreCase)) return false;
      for (int i = 0; i < expectedArgs.Length; i++) {
        if (!String.Equals(Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, (i + 1) * IntPtr.Size)), expectedArgs[i], StringComparison.Ordinal)) return false;
      }
      return true;
    } finally { LocalFree(memory); }
  }
}
'@ | Out-Null
`;

export function loginStartupInspectScript(spec) {
  return String.raw`
$ErrorActionPreference = 'Stop'
$spec = ${psValue(spec)}
${STARTUP_COMMANDLINE_NATIVE}
$run = $null; $approved = $null
$result = [ordered]@{ entryExists = $false; commandMatches = $false; approval = 'enabled' }
try {
  # OpenSubKey(..., false) is read-only and never creates a missing key.
  $run = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run', $false)
  if ($null -ne $run -and $run.GetValueNames() -contains $spec.name) {
    $result.entryExists = $true
    $raw = $run.GetValue($spec.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($run.GetValueKind($spec.name) -eq [Microsoft.Win32.RegistryValueKind]::String -and $raw -is [string]) {
      $result.commandMatches = [BlackiceStartupCommandLine]::Matches($raw, $spec.path, [string[]]$spec.args)
    }
  }
  $approved = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run', $false)
  if ($null -ne $approved -and $approved.GetValueNames() -contains $spec.name) {
    $result.approval = 'unknown'
    $bytes = $approved.GetValue($spec.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($approved.GetValueKind($spec.name) -eq [Microsoft.Win32.RegistryValueKind]::Binary -and $bytes -is [byte[]]) {
      $result.approval = [BlackiceStartupCommandLine]::Approval($bytes)
    }
  }
  # Missing StartupApproved is enabled, matching Electron's enabled:true
  # setter, which deletes this value. Unknown formats never count as enabled.
  $result | ConvertTo-Json -Compress
} finally { if ($null -ne $run) { $run.Dispose() }; if ($null -ne $approved) { $approved.Dispose() } }
`;
}

export function loginStartupState(settings, tasks, spec, registry) {
  if (registry?.entryExists === true && registry.commandMatches === true && registry.approval === 'enabled') return { ready: true, canEnable: true, detail: 'This BLACKICE profile starts in the background when this Windows account signs in.' };
  if (registry?.entryExists === true) return { ready: false, canEnable: false, detail: 'The BLACKICE startup entry is disabled, differs from this profile, or has an unrecognized Windows startup state. It was preserved; review Windows startup settings.' };
  if (registry?.entryExists !== false || registry?.approval !== 'enabled') return { ready: false, canEnable: false, detail: 'The current-user BLACKICE startup entry could not be verified. Existing startup settings were preserved.' };
  if (tasks?.relatedTask === true) return { ready: false, canEnable: false, detail: 'An existing BLACKICE-related scheduled task manages startup. It was preserved; verify its account, profile and trigger in Task Scheduler.' };
  // The lossy Electron getter is only a conservative duplication hint. It can
  // neither prove readiness nor authorize replacing another startup entry.
  if ((settings?.launchItems || []).length) return { ready: false, canEnable: false, detail: 'Another startup entry already launches this BLACKICE executable. It was preserved; verify its profile and startup state in Windows.' };
  if (tasks?.relatedTask !== false) return { ready: false, canEnable: false, detail: 'Existing scheduled startup could not be checked. No additional startup entry will be created until that check succeeds.' };
  return { ready: false, canEnable: true, detail: 'BLACKICE does not yet have a verified sign-in entry for this profile. Setup can add one for the current Windows account.' };
}

export function createDesktopConnectionStartup({ platform = process.platform, executable = process.execPath, profileDir, appDir, packaged = true, loginItem, runPowerShell = runStartupPowerShell, now, cacheMs } = {}) {
  if (platform !== 'win32') return new ConnectionStartup({ platform });
  const spec = startupLoginSpec({ executable, profileDir, appDir, packaged });
  const tailscale = {
    inspect: async () => tailscaleStartupState(JSON.parse(await runPowerShell(TAILSCALE_STARTUP_INSPECT))),
    enable: async () => { await runPowerShell(tailscaleStartupRepairScript(), { mutation: true }); },
  };
  const blackice = {
    inspect: async () => {
      const [settings, tasks, registry] = await Promise.all([loginItem.inspect(spec), runPowerShell(scheduledStartupInspectScript(spec)).then(JSON.parse), runPowerShell(loginStartupInspectScript(spec)).then(JSON.parse)]);
      return loginStartupState(settings, tasks, spec, registry);
    },
    enable: async () => {
      const state = await blackice.inspect();
      if (state.ready) return;
      if (!state.canEnable) throw fail('Existing BLACKICE startup configuration was preserved.', 'CONNECTION_STARTUP_MANAGED');
      await loginItem.enable(spec);
    },
  };
  return new ConnectionStartup({ platform, tailscale, blackice, now, cacheMs });
}
