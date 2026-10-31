[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\BLACKICE'),
  [string]$DesktopDirectory = [Environment]::GetFolderPath('DesktopDirectory'),
  [string]$StartMenuDirectory = (Join-Path ([Environment]::GetFolderPath('Programs')) '')
)
$ErrorActionPreference = 'Stop'
$exe = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'BLACKICE.exe'))
$icon = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'resources\app\desktop\icon.ico'))
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "BLACKICE executable not found: $exe" }
if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw "BLACKICE icon not found: $icon" }
$shell = New-Object -ComObject WScript.Shell
try {
  $destinations = @($DesktopDirectory, $StartMenuDirectory) | Select-Object -Unique
  # Preflight every destination before changing either shortcut.
  foreach ($dir in $destinations) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Shortcut directory not found: $dir" }
    $link = Join-Path $dir 'BLACKICE.lnk'
    if (Test-Path -LiteralPath $link) {
      if (-not (Test-Path -LiteralPath $link -PathType Leaf)) { throw "Not a shortcut file: $link" }
      $existing = $shell.CreateShortcut($link)
      try { $oldTarget = [string]$existing.TargetPath } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($existing) }
      # Accept only this executable or the normal per-user install, including
      # Windows packaged-app file-system redirection. Never replace other links.
      $owned = $oldTarget -and ($oldTarget.Equals($exe, [StringComparison]::OrdinalIgnoreCase) -or ($oldTarget.StartsWith($env:LOCALAPPDATA + '\', [StringComparison]::OrdinalIgnoreCase) -and $oldTarget -match '(?i)\\Programs\\BLACKICE\\BLACKICE\.exe$'))
      if (-not $owned) { throw "Existing shortcut is not a recognized BLACKICE installation; left unchanged: $link" }
    }
  }
  foreach ($dir in $destinations) {
    $link = Join-Path $dir 'BLACKICE.lnk'
    if ($PSCmdlet.ShouldProcess($link, 'Create or repair BLACKICE shortcut')) {
      $temp = Join-Path $dir ('.BLACKICE-' + [guid]::NewGuid().ToString('N') + '.lnk')
      try {
        $shortcut = $shell.CreateShortcut($temp)
        try {
          $shortcut.TargetPath = $exe
          $shortcut.WorkingDirectory = [IO.Path]::GetDirectoryName($exe)
          $shortcut.IconLocation = $icon + ',0'
          $shortcut.Description = 'BLACKICE'
          $shortcut.Save()
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        Move-Item -LiteralPath $temp -Destination $link -Force
        Write-Output "Repaired: $link"
      } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
    }
  }
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
if (-not $WhatIfPreference) {
  if (-not ('BlackiceShellRefresh' -as [type])) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BlackiceShellRefresh { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint e, uint f, IntPtr a, IntPtr b); }'
  }
  [BlackiceShellRefresh]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}
