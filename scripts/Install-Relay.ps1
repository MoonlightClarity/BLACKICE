[CmdletBinding()]
param(
  [string]$Source = $PSScriptRoot,
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\Relay'),
  [string]$DesktopPath = [Environment]::GetFolderPath('Desktop'),
  [string]$RuntimeMarker = (Join-Path $env:APPDATA 'Relay\desktop-runtime.json'),
  [string]$RequirePublisher = '',
  [switch]$AllowDowngrade,
  [switch]$NoLaunch
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RelaySha256([string]$File) {
  $stream = [IO.File]::OpenRead($File); $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-RelayAbsolutePath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) { throw 'Choose an absolute local folder.' }
  $resolved = [IO.Path]::GetFullPath($Value).TrimEnd('\')
  if ($resolved -notmatch '^[A-Za-z]:\\' -or $resolved.Length -le 3) { throw 'A drive root or network location cannot be used for this installation.' }
  return $resolved
}
function Assert-RelayPlainPath([string]$Value) {
  $current = $Value
  while ($current -and $current.Length -gt 3) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Installation paths cannot pass through a link or junction.' }
    }
    $current = [IO.Path]::GetDirectoryName($current)
  }
}
function Get-RelayFiles([string]$Directory) {
  $stack = New-Object 'System.Collections.Generic.Stack[string]'; $stack.Push($Directory)
  while ($stack.Count) {
    foreach ($entry in Get-ChildItem -LiteralPath $stack.Pop() -Force) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The application bundle contains a link or junction.' }
      if ($entry.PSIsContainer) { $stack.Push($entry.FullName) } else { $entry }
    }
  }
}
function Test-RelayDistribution([string]$Directory) {
  Assert-RelayPlainPath $Directory
  $manifestFile = Join-Path $Directory 'relay-distribution.json'
  if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf) -or (Get-Item -LiteralPath $manifestFile).Length -gt 8388608) { throw 'The Relay file manifest is missing or too large.' }
  $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.format -ne 1 -or $manifest.product -ne 'Relay' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or -not $manifest.files.Count) { throw 'The Relay distribution manifest is invalid.' }
  $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($record in $manifest.files) {
    $name = [string]$record.path
    if (-not $name -or $name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or @($name.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -or -not $expected.Add($name) -or $record.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or [string]$record.size -notmatch '^\d+$') { throw 'The Relay manifest contains an invalid file path or checksum.' }
    $file = Join-Path $Directory $name.Replace('/', '\')
    if (-not $file.StartsWith($Directory + '\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "A required application file is missing: $name" }
    Assert-RelayPlainPath $file
    if ((Get-Item -LiteralPath $file).Length -ne [long]$record.size -or (Get-RelaySha256 $file) -ne $record.sha256) { throw "An application file failed its checksum: $name" }
  }
  foreach ($file in @(Get-RelayFiles $Directory)) {
    $relative = $file.FullName.Substring($Directory.Length + 1).Replace('\', '/')
    if ($relative -notin @('relay-distribution.json', 'relay-install.json') -and -not $expected.Contains($relative)) { throw "An unexpected application file was found: $relative" }
  }
  foreach ($required in @('Relay.exe', 'resources/app/package.json', 'Install-Relay.ps1')) { if (-not $expected.Contains($required)) { throw "A required application file is missing: $required" } }
  $package = Get-Content -LiteralPath (Join-Path $Directory 'resources\app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $binaryVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $Directory 'Relay.exe')).ProductVersion
  if ($package.name -ne 'relay-agent-harness' -or $package.version -ne $manifest.version -or $binaryVersion -notmatch ('^' + [regex]::Escape($manifest.version) + '(?:\.0)?(?:\+[^\s]+)?$')) { throw 'The executable, application package and manifest versions do not match.' }
  return $manifest
}
function Write-RelayJson([string]$File, $Value) {
  $temporary = $File + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  try { [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false))); Move-Item -LiteralPath $temporary -Destination $File -Force }
  finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Get-RelayRuntimeProcess([int]$ProcessId) {
  try { $native = [Diagnostics.Process]::GetProcessById($ProcessId) }
  catch [ArgumentException] { return $null }
  try { return [pscustomobject]@{ ExecutablePath = $native.MainModule.FileName; CreationDate = $native.StartTime.ToUniversalTime(); Handle = $native } }
  catch { throw 'The running Relay process could not be inspected. Close Relay normally before updating.' }
}
function Get-RelayListenerOwners([int]$Port) {
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    # A parent PowerShell 7 process can pass its module path into Windows PowerShell.
    # Resolve the Windows module explicitly rather than relying on that inherited path.
    Import-Module (Join-Path $PSHOME 'Modules\NetTCPIP\NetTCPIP.psd1') -ErrorAction Stop
  }
  return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } | ForEach-Object { $_.OwningProcess })
}
function Stop-VerifiedRelay([string]$Marker) {
  if (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) { return }
  $runtime = Get-Content -LiteralPath $Marker -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$runtime.pid -notmatch '^[1-9][0-9]*$') { throw 'The running Relay record is invalid. Close Relay normally before updating.' }
  $process = Get-RelayRuntimeProcess ([int]$runtime.pid)
  if (-not $process) { return }
  if (-not $runtime.PSObject.Properties['executable'] -or -not $runtime.executable -or -not $process.ExecutablePath -or [IO.Path]::GetFileName($runtime.executable) -ne 'Relay.exe' -or [IO.Path]::GetFullPath($runtime.executable) -ne [IO.Path]::GetFullPath($process.ExecutablePath)) { throw 'The running Relay process could not be verified. Close Relay normally before updating.' }
  $created = ([datetime]$process.CreationDate).ToUniversalTime()
  $startProperty = $runtime.PSObject.Properties['startedAt']
  if ($startProperty) {
    if ([math]::Abs(($created - ([datetime]$runtime.startedAt).ToUniversalTime()).TotalSeconds) -gt 3) { throw 'The running Relay record belongs to another process. Close Relay normally before updating.' }
  } else {
    $recorded = ([datetime]$runtime.at).ToUniversalTime()
    if (($recorded - $created).TotalSeconds -lt -2 -or ($recorded - $created).TotalMinutes -gt 10 -or $recorded -gt [datetime]::UtcNow.AddMinutes(1)) { throw 'The running Relay record is stale. Close Relay normally before updating.' }
  }
  $origin = [uri]$runtime.url
  if ($origin.Scheme -ne 'http' -or $origin.Host -notin @('127.0.0.1', 'localhost') -or $origin.Port -lt 1 -or $origin.AbsolutePath -ne '/' -or $origin.UserInfo -or $origin.Query -or $origin.Fragment) { throw 'The running Relay address could not be verified.' }
  $listeners = @(Get-RelayListenerOwners $origin.Port)
  if ([int]$runtime.pid -notin $listeners) { throw 'The running Relay connection does not belong to its recorded process.' }
  $url = $origin.GetLeftPart([UriPartial]::Authority)
  $health = Invoke-RestMethod -Uri ($url + '/health') -TimeoutSec 5 -MaximumRedirection 0
  if ($health.app -ne 'relay-agent-harness' -or $health.ok -ne $true) { throw 'The running Relay connection could not be verified.' }
  $web = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $null = Invoke-WebRequest -Uri ($url + '/') -UseBasicParsing -WebSession $web -TimeoutSec 5 -MaximumRedirection 0
  $null = Invoke-RestMethod -Uri ($url + '/api/shutdown') -Method Post -ContentType 'application/json' -Body '{}' -Headers @{ Origin = $url } -WebSession $web -TimeoutSec 5 -MaximumRedirection 0
  if (-not $process.Handle.WaitForExit(45000)) { throw 'Relay has not finished saving and closing. The current installation was left intact. Close Relay normally and retry.' }
}
function Test-RelayInstalledFolder([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory)) { return }
  Assert-RelayPlainPath $Directory
  if (-not @(Get-ChildItem -LiteralPath $Directory -Force).Count) { return }
  $packagePath = Join-Path $Directory 'resources\app\package.json'
  if (-not (Test-Path -LiteralPath (Join-Path $Directory 'Relay.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw 'The destination contains unrelated files. Choose an empty folder or an existing Relay installation.' }
  $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($package.name -ne 'relay-agent-harness') { throw 'The destination is not a verified Relay installation.' }
  if ($package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'The installed Relay version could not be verified.' }
  return $package
}
function Assert-RelayPublisher([string]$Directory, [string]$Publisher) {
  if ([string]::IsNullOrWhiteSpace($Publisher)) { return }
  Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
  $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $Directory 'Relay.exe')
  if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne $Publisher) { throw 'The Relay executable does not have a trusted signature from the required publisher.' }
}
function New-RelayShortcut([string]$File, [string]$Target, [string]$Version) {
  $temporary = Join-Path ([IO.Path]::GetDirectoryName($File)) ('.Relay-shortcut-' + [guid]::NewGuid().ToString('N') + '.lnk')
  try { $shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut($temporary); $shortcut.TargetPath = $Target; $shortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($Target); $shortcut.IconLocation = $Target + ',0'; $shortcut.Description = 'Relay ' + $Version; $shortcut.Save(); Move-Item -LiteralPath $temporary -Destination $File -Force }
  finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}
function Remove-RelayGeneratedFolder([string]$Directory, [string]$Parent, [string]$Prefix) {
  $absolute = Get-RelayAbsolutePath $Directory
  if ([IO.Path]::GetDirectoryName($absolute) -ne $Parent -or -not [IO.Path]::GetFileName($absolute).StartsWith($Prefix, [StringComparison]::Ordinal)) { throw 'Installer cleanup escaped its staging boundary.' }
  Assert-RelayPlainPath $absolute
  if (Test-Path -LiteralPath $absolute) { $null = @(Get-RelayFiles $absolute) }
  if (Test-Path -LiteralPath $absolute) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}
function Enter-RelayInstallLock([string]$Directory) {
  $normalized = (Get-RelayAbsolutePath $Directory).ToUpperInvariant()
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $identity = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))).Replace('-', '') }
  finally { $algorithm.Dispose() }
  $mutex = New-Object Threading.Mutex($false, ('Global\Relay.Install.' + $identity))
  try {
    $acquired = $false
    try { $acquired = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Another Relay installer is already updating this installation. Wait for it to finish, then try again. No application files were changed.' }
    return $mutex
  } catch { $mutex.Dispose(); throw }
}
function Invoke-RelayInstallation {
  [CmdletBinding()]
  param([string]$Source, [string]$InstallRoot, [string]$DesktopPath, [string]$RuntimeMarker, [string]$RequirePublisher = '', [switch]$AllowDowngrade, [switch]$NoLaunch)
  $Source = Get-RelayAbsolutePath $Source; $InstallRoot = Get-RelayAbsolutePath $InstallRoot; $DesktopPath = Get-RelayAbsolutePath $DesktopPath
  if ($Source -eq $InstallRoot -or $Source.StartsWith($InstallRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or $InstallRoot.StartsWith($Source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The source bundle and installed application must use separate folders.' }
  if ($DesktopPath -eq $InstallRoot -or $DesktopPath.StartsWith($InstallRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or $DesktopPath -eq $Source -or $DesktopPath.StartsWith($Source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The Desktop shortcut must be outside the application bundle.' }
  foreach ($location in @($Source, $InstallRoot, $DesktopPath)) { Assert-RelayPlainPath $location }
  if (-not (Test-Path -LiteralPath $DesktopPath -PathType Container)) { throw 'The Desktop folder does not exist.' }
  $installMutex = Enter-RelayInstallLock $InstallRoot
  try {
  $manifest = Test-RelayDistribution $Source
  Assert-RelayPublisher $Source $RequirePublisher
  $installedPackage = Test-RelayInstalledFolder $InstallRoot
  if ($installedPackage -and [version]$manifest.version -lt [version]$installedPackage.version -and -not $AllowDowngrade) { throw 'This bundle is older than the installed Relay version. Downgrades require -AllowDowngrade and a verified compatible profile backup.' }
  $parent = [IO.Path]::GetDirectoryName($InstallRoot); $leaf = [IO.Path]::GetFileName($InstallRoot)
  $null = New-Item -ItemType Directory -Path $parent -Force
  $stage = Join-Path $parent ($leaf + '.stage-' + [guid]::NewGuid().ToString('N'))
  $backup = Join-Path $parent ($leaf + '.previous-' + [datetime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
  $link = Join-Path $DesktopPath 'Relay.lnk'; $shortcutBackup = $null; $oldMoved = $false; $promoted = $false; $shortcutWritten = $false; $committed = $false
  try {
    $null = New-Item -ItemType Directory -Path $stage
    foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) { Copy-Item -LiteralPath $entry.FullName -Destination $stage -Recurse -Force }
    $null = Test-RelayDistribution $stage
    Assert-RelayPublisher $stage $RequirePublisher
    if (Test-Path -LiteralPath $link) {
      if (-not (Test-Path -LiteralPath $link -PathType Leaf)) { throw 'Desktop Relay.lnk is not a shortcut file and was left untouched.' }
      $shell = New-Object -ComObject WScript.Shell; $oldTarget = $shell.CreateShortcut($link).TargetPath
      $related = $false
      if ([IO.Path]::GetFileName($oldTarget) -eq 'Relay.exe') {
        $oldFolder = [IO.Path]::GetDirectoryName($oldTarget)
        if ($oldTarget -eq (Join-Path $InstallRoot 'Relay.exe') -or [IO.Path]::GetFileName($oldFolder) -eq 'Relay-Desktop-Windows') { $related = $true }
        elseif (Test-Path -LiteralPath (Join-Path $oldFolder 'resources\app\package.json') -PathType Leaf) { $oldPackage = Get-Content -LiteralPath (Join-Path $oldFolder 'resources\app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json; $related = $oldPackage.name -eq 'relay-agent-harness' }
      }
      if (-not $related) { throw 'Desktop Relay.lnk points to another application and was left untouched.' }
      $shortcutBackups = Join-Path $parent ($leaf + '-shortcut-backups'); Assert-RelayPlainPath $shortcutBackups
      $null = New-Item -ItemType Directory -Path $shortcutBackups -Force
      $shortcutBackup = Join-Path $shortcutBackups ([guid]::NewGuid().ToString('N') + '.lnk.backup')
      Copy-Item -LiteralPath $link -Destination $shortcutBackup
    }
    Write-RelayJson (Join-Path $stage 'relay-install.json') @{ product = 'Relay'; version = $manifest.version; installedAt = [datetime]::UtcNow.ToString('o'); installRoot = $InstallRoot; manifestSha256 = Get-RelaySha256 (Join-Path $stage 'relay-distribution.json'); previousInstall = $(if (Test-Path -LiteralPath $InstallRoot) { $backup } else { $null }) }
    Stop-VerifiedRelay $RuntimeMarker
    if (Test-Path -LiteralPath $InstallRoot) { Move-Item -LiteralPath $InstallRoot -Destination $backup; $oldMoved = $true }
    Move-Item -LiteralPath $stage -Destination $InstallRoot; $promoted = $true
    $null = Test-RelayDistribution $InstallRoot
    Assert-RelayPublisher $InstallRoot $RequirePublisher
    New-RelayShortcut $link (Join-Path $InstallRoot 'Relay.exe') $manifest.version; $shortcutWritten = $true; $committed = $true
  } catch {
    $original = $_
    if ($shortcutWritten -and -not $shortcutBackup -and (Test-Path -LiteralPath $link -PathType Leaf)) { Remove-Item -LiteralPath $link -Force }
    if ($shortcutBackup) { Copy-Item -LiteralPath $shortcutBackup -Destination $link -Force }
    if ($promoted) { Remove-RelayGeneratedFolder $InstallRoot $parent $leaf; $promoted = $false }
    if ($oldMoved) { Move-Item -LiteralPath $backup -Destination $InstallRoot; $oldMoved = $false }
    throw $original
  } finally {
    if (Test-Path -LiteralPath $stage) { Remove-RelayGeneratedFolder $stage $parent ($leaf + '.stage-') }
  }
  if ($committed -and -not $NoLaunch) {
    try { $null = Start-Process -FilePath (Join-Path $InstallRoot 'Relay.exe') -WorkingDirectory $InstallRoot -WindowStyle Hidden -PassThru }
    catch { Write-Warning 'Relay was installed and verified, but could not be opened. Use the Desktop shortcut.' }
  }
  [pscustomobject]@{ installed = $committed; version = $manifest.version; installRoot = $InstallRoot; shortcut = $link; previousInstall = $(if ($oldMoved) { $backup } else { $null }) }
  } finally {
    try { $installMutex.ReleaseMutex() }
    finally { $installMutex.Dispose() }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  try { Invoke-RelayInstallation -Source $Source -InstallRoot $InstallRoot -DesktopPath $DesktopPath -RuntimeMarker $RuntimeMarker -RequirePublisher $RequirePublisher -AllowDowngrade:$AllowDowngrade -NoLaunch:$NoLaunch | ConvertTo-Json -Compress }
  catch { Write-Error $_.Exception.Message; exit 1 }
}
