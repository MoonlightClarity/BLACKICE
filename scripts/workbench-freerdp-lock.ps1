# Shared validation for the committed FreeRDP toolchain lock. No install or network effects.
function Read-WorkbenchFreeRdpLock(
  [string]$Path,
  [string]$ClientField = 'freerdp',
  [string]$ClientPackage = 'mingw-w64-ucrt-x86_64-freerdp'
) {
  $lock = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  if ($lock.schema -ne 1) { throw 'Unsupported FreeRDP lock schema.' }
  if ($lock.bootstrap.url -notmatch '^https://repo\.msys2\.org/distrib/x86_64/msys2-base-x86_64-[0-9]{8}\.tar\.xz$' -or
      $lock.bootstrap.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid FreeRDP bootstrap lock.' }
  $artifacts = @($lock.packageArtifacts)
  if (!$artifacts.Count) { throw 'FreeRDP lock has no package artifacts.' }
  $names = @{}
  foreach ($artifact in $artifacts) {
    if ($artifact.file -notmatch '^mingw-w64-ucrt-x86_64-[a-zA-Z0-9_+.~\-]+-any\.pkg\.tar\.zst$' -or
        $artifact.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid FreeRDP package artifact lock.' }
    if ($names.ContainsKey($artifact.file)) { throw "Duplicate FreeRDP package artifact: $($artifact.file)" }
    $names[$artifact.file] = $artifact.sha256
  }
  $expected = @($lock.packages | Where-Object { $_ -like 'mingw-w64-ucrt-x86_64-*' })
  if (!$expected.Count -or $expected.Count -ne $artifacts.Count) { throw 'FreeRDP package inventory and artifact counts differ.' }
  $inventoryNames = @{}
  foreach ($package in $expected) {
    if ($package -notmatch '^(mingw-w64-ucrt-x86_64-[a-zA-Z0-9_+.\-]+) ([a-zA-Z0-9_+.~\-]+)$') {
      throw "Invalid FreeRDP package inventory: $package"
    }
    $file = "$($Matches[1])-$($Matches[2])-any.pkg.tar.zst"
    if ($inventoryNames.ContainsKey($Matches[1])) { throw "Duplicate FreeRDP package inventory: $package" }
    $inventoryNames[$Matches[1]] = $true
    if (!$names.ContainsKey($file)) { throw "FreeRDP inventory has no pinned artifact: $package" }
  }
  $client = $lock.$ClientField
  $clientFile = "$($client.name)-$($client.version)-any.pkg.tar.zst"
  if ($client.name -ne $ClientPackage -or
      !$names.ContainsKey($clientFile) -or $names[$clientFile] -ne $client.sha256 -or
      $expected -notcontains "$($client.name) $($client.version)") {
    throw 'FreeRDP client metadata does not match its pinned artifact and inventory.'
  }
  return $lock
}

function Assert-WorkbenchFreeRdpArtifacts($Lock, [string]$CacheRoot) {
  foreach ($artifact in $Lock.packageArtifacts) {
    $file = Join-Path $CacheRoot $artifact.file
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing pinned artifact: $file" }
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    if ($actual -ne $artifact.sha256) { throw "Pinned SHA-256 mismatch: $file; expected=$($artifact.sha256); actual=$actual" }
  }
}

function Assert-WorkbenchFreeRdpInventory($Lock, [string[]]$Inventory) {
  $expected = @($Lock.packages | Where-Object { $_ -like 'mingw-w64-ucrt-x86_64-*' })
  $actual = @($Inventory | Where-Object { $_ -like 'mingw-w64-ucrt-x86_64-*' })
  $different = @(Compare-Object -ReferenceObject $expected -DifferenceObject $actual)
  if ($different.Count) {
    throw ('FreeRDP installed dependency inventory differs from the committed lock: ' +
      (($different | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" }) -join '; '))
  }
}
