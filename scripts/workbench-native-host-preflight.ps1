# Read-only native VMConnect transport discovery. No VM/Windows/certificate changes.
# Certificate fingerprints come from the local VMMS service store, not the network.
param([ValidateLength(1,200)][string]$VmName='BLACKICE-Workbench')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$blockers=@()
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]::new($identity)
$elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$vm=$null
try {$vm=Get-VM -Name $VmName -ErrorAction Stop}
catch {$blockers+='Hyper-V inventory could not be verified: '+$_.Exception.Message}
$service=Get-CimInstance Win32_Service -Filter "Name='vmms'" -ErrorAction SilentlyContinue
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort 2179 -ErrorAction SilentlyContinue)
$ownedListener=($null -ne $service -and $service.State -eq 'Running' -and
  @($listeners | Where-Object {$_.OwningProcess -eq $service.ProcessId}).Count -gt 0)
if(!$ownedListener){$blockers+='The running VMMS service does not own a verified console listener on port 2179.'}
$certificates=@()
$store='HKLM:\SOFTWARE\Microsoft\Cryptography\Services\vmms\SystemCertificates\MY\Certificates'
try {
  $certificates=@(Get-ChildItem -LiteralPath $store -ErrorAction Stop | ForEach-Object {
    $blob=(Get-ItemProperty -LiteralPath $_.PSPath -Name Blob -ErrorAction Stop).Blob
    $certificate=[Security.Cryptography.X509Certificates.X509Certificate2]::new([byte[]]$blob)
    $hasher=[Security.Cryptography.SHA256]::Create()
    try {
      if($certificate.NotBefore -le (Get-Date) -and $certificate.NotAfter -gt (Get-Date)){
        [ordered]@{
          sha256=([BitConverter]::ToString($hasher.ComputeHash($certificate.RawData))).Replace('-','').ToLowerInvariant()
          subject=$certificate.Subject
          notAfter=$certificate.NotAfter.ToUniversalTime().ToString('o')
          source='local-vmms-service-certificate-store'
        }
      }
    } finally {$hasher.Dispose();$certificate.Dispose()}
  })
} catch {$blockers+='The public VMMS certificate store could not be read: '+$_.Exception.Message}
if(!$certificates.Count){$blockers+='No currently valid public VMMS certificate fingerprint was found.'}
if($vm -and [string]$vm.State -ne 'Running'){$blockers+='The existing guest is not running; no lifecycle action was taken.'}
[ordered]@{
  version=1
  at=[DateTime]::UtcNow.ToString('o')
  processElevated=[bool]$elevated
  vmName=$VmName
  vmId=$(if($vm){[string]$vm.Id}else{$null})
  vmState=$(if($vm){[string]$vm.State}else{'Unknown'})
  host='127.0.0.1'
  port=2179
  listenerOwnedByVmms=[bool]$ownedListener
  certificates=@($certificates)
  certificateSha256=$(if($certificates.Count -eq 1){$certificates[0].sha256}else{$null})
  readyForBoundedProbe=($blockers.Count -eq 0)
  guestDisplayVerified=$false
  blockers=@($blockers)
} | ConvertTo-Json -Depth 6 -Compress
