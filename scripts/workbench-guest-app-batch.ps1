# Background Windows guest package synchronization.
# Runs ONLY inside the guest session; preserves per-package observed results.
# Uses the host's immutable winget export, not arbitrary shell commands.
param(
 [Parameter(Mandatory=$true)][string]$WorkspaceRoot,
 [Parameter(Mandatory=$true)][string]$RunId,
 [Parameter(Mandatory=$true)][string]$SnapshotId
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($RunId -notmatch '^[a-f0-9]{32}$' -or $SnapshotId -notmatch '^[a-f0-9]{32}$'){
 throw 'Unknown application sync batch identity.'
}
$bridge=Join-Path $WorkspaceRoot '.blackice-workbench'
$hostInfo=Get-Content -LiteralPath (Join-Path $bridge 'host-info.json') -Raw | ConvertFrom-Json
if([string]$hostInfo.hostName -eq $env:COMPUTERNAME){throw 'Guest app sync cannot execute on the host.'}
$root=Join-Path $bridge 'app-sync'
$manifestDir=Join-Path $root 'manifests'
$receiptFile=Join-Path $manifestDir ($SnapshotId+'.receipt.json')
$runFile=Join-Path (Join-Path $root 'runs') ($RunId+'.json')
$logs=Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$record=Get-Content -LiteralPath $runFile -Raw|ConvertFrom-Json
$receipt=Get-Content -LiteralPath $receiptFile -Raw|ConvertFrom-Json
$sourceSha=if($record.sourceSnapshotSha256){[string]$record.sourceSnapshotSha256}else{[string]$record.manifestSha256}
$variant=[string]$record.importVariant
if($variant -and $variant -notin @('original','augmented')){throw 'Unknown batch import variant.'}
$filename=if($variant -eq 'augmented'){$SnapshotId+'.augmented-'+([string]$record.manifestSha256).Substring(0,16)+'.json'}else{$SnapshotId+'.json'}
$manifestFile=Join-Path $manifestDir $filename
if($record.version -ne 1 -or $record.runId -ne $RunId -or $record.snapshotId -ne $SnapshotId -or
 $sourceSha -ne $receipt.sha256 -or $receipt.snapshotId -ne $SnapshotId){
 throw 'Batch identity does not match the immutable host source snapshot.'
}
$actual=(Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash.ToLowerInvariant()
if($actual -ne $record.manifestSha256){throw 'Selected guest import manifest bytes have changed.'}
$manifest=Get-Content -LiteralPath $manifestFile -Raw|ConvertFrom-Json
if(@($manifest.Sources).Count -gt 32){throw 'Too many package sources.'}
$packages=New-Object System.Collections.ArrayList
$seen=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach($source in @($manifest.Sources)){
 $sourceName=[string]$source.SourceDetails.Name
 if($sourceName -notmatch '^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$'){throw 'Invalid package source.'}
 foreach($pkg in @($source.Packages)){
   $id=[string]$pkg.PackageIdentifier
   if($id -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,179}$'){throw 'Invalid package identifier.'}
   if($seen.Add($sourceName+'/'+$id)){
     [void]$packages.Add([ordered]@{id=$id;source=$sourceName})
     if($packages.Count -gt 1200){throw 'Too many packages.'}
   }
 }
}
if($packages.Count -ne [int]$record.totalPackages){throw 'Guest import package count changed after this batch was reserved.'}
function Save-Status($state,$results,$message,$counts,$finished=$false){
 $value=[ordered]@{
   version=1;runId=$RunId;snapshotId=$SnapshotId;manifestSha256=$receipt.sha256
   status=$state;createdAt=$record.createdAt;updatedAt=(Get-Date).ToUniversalTime().ToString('o')
   totalPackages=$packages.Count;counts=$counts
   packages=@($results);message=$message
 }
 if($finished){$value.finishedAt=(Get-Date).ToUniversalTime().ToString('o')}
 $tmp=$runFile+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 try {
   [IO.File]::WriteAllText($tmp,($value|ConvertTo-Json -Compress -Depth 7),[Text.UTF8Encoding]::new($false))
   Move-Item -LiteralPath $tmp -Destination $runFile -Force
 }finally {Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue -Force}
}
function Run-Winget($argsArray,$tag,$timeoutMs){
 $exe=Get-Command winget.exe -ErrorAction Stop
 $out=Join-Path $logs ($RunId+'-'+$tag+'.stdout.txt')
 $err=Join-Path $logs ($RunId+'-'+$tag+'.stderr.txt')
 $argsText=@($argsArray|ForEach-Object {
   if([string]$_ -match '\s'){'"'+([string]$_).Replace('"','')+'"'}else{[string]$_}
 })
 $process=Start-Process -FilePath $exe.Source -ArgumentList $argsText -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction Stop
 if(-not $process.WaitForExit($timeoutMs)){
   try{$process.Kill()}catch{}
   throw ('winget '+$tag+' did not complete before the operational timeout; the application installation outcome is uncertain.')
 }
 return [int]$process.ExitCode
}
function Get-GuestPackages($tag){
 $snapshot=Join-Path $logs ($RunId+'-'+$tag+'.json')
 $code=Run-Winget @('export','--output',$snapshot,'--accept-source-agreements','--disable-interactivity') $tag 180000
 if($code -ne 0 -or !(Test-Path -LiteralPath $snapshot)){throw ('Cannot verify guest package inventory: '+$tag)}
 $installed=Get-Content -LiteralPath $snapshot -Raw|ConvertFrom-Json
 $names=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
 foreach($s in @($installed.Sources)){
   $sName=[string]$s.SourceDetails.Name
   foreach($p in @($s.Packages)){
     $identifier=[string]$p.PackageIdentifier
     if($identifier){[void]$names.Add($sName+'/'+$identifier)}
   }
 }
 return ,$names
}
$results=@()
$counts=@{installed=0;alreadyPresent=0;missing=0;unverified=0}
try {
 Save-Status 'running' @() 'Inspecting installed packages inside the Windows guest.' $counts
 $before=Get-GuestPackages 'before'
 $importCode=Run-Winget @('import','--import-file',$manifestFile,'--ignore-unavailable',
   '--ignore-versions','--no-upgrade','--accept-source-agreements',
   '--accept-package-agreements','--disable-interactivity') 'import' 3600000
 $after=Get-GuestPackages 'after'
 foreach($pkg in $packages){
   $key=$pkg.source+'/'+$pkg.id
   $status=if($before.Contains($key)){'already_present'}elseif($after.Contains($key)){'installed'}else{'missing'}
   switch($status){
    'installed'{$counts.installed++}
    'already_present'{$counts.alreadyPresent++}
    'missing'{$counts.missing++}
   }
   $results+=@{id=$pkg.id;source=$pkg.source;status=$status}
 }
 $state=if($counts.missing -gt 0 -or $importCode -ne 0){'partial'}else{'completed'}
 $message=if($counts.missing -gt 0){[string]$counts.missing+' packages remain missing; these can be retried by re-batching.'}
   elseif($importCode -ne 0){'winget returned an error although all recognizable packages are now present; inspect logs.'}
   else{'Guest installed state verified for every package in the host manifest.'}
 Save-Status $state $results ($message+' Exit code: '+$importCode) $counts $true
}catch{
 # A failed guest export or uncertain package-manager import must not be
 # misreported as a successful package installation.
 if($before){
   foreach($pkg in $packages){
     $key=$pkg.source+'/'+$pkg.id
     $state=if($before.Contains($key)){'already_present'}else{'unverified'}
     if($state -eq 'already_present'){$counts.alreadyPresent++}else{$counts.unverified++}
     $results+=@{id=$pkg.id;source=$pkg.source;status=$state}
   }
 }
 Save-Status 'uncertain' $results ('Batch did not finish verification: '+$_.Exception.Message) $counts $true
}
