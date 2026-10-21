param([Parameter(Mandatory=$true)][string]$Path, [Parameter(Mandatory=$true)][string]$Publisher)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
if (-not [IO.Path]::IsPathRooted($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Choose an existing absolute artifact path.' }
$signature = Get-AuthenticodeSignature -LiteralPath $Path
$name = $null; $thumbprint = $null
if ($signature.SignerCertificate) {
  $name = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  $thumbprint = $signature.SignerCertificate.Thumbprint
}
@{ valid = $signature.Status -eq 'Valid' -and $name -ceq $Publisher; status = [string]$signature.Status; publisher = $name; thumbprint = $thumbprint; productVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion } | ConvertTo-Json -Compress
