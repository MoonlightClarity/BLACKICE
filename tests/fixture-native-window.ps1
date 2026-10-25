param([string]$Role,[string]$Marker,[string]$Signal='')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.Windows.Forms.dll','System.Drawing.dll') -TypeDefinition @'
public class BlackiceQuietTestForm : System.Windows.Forms.Form {
    protected override bool ShowWithoutActivation { get { return true; } }
}
'@
$form=New-Object BlackiceQuietTestForm
$form.Text=if($Role -eq 'host'){'BLACKICE Native Test Host'}else{'BLACKICE Native Test Application'}
$form.Size=New-Object System.Drawing.Size(800,600)
$form.StartPosition='Manual'
$form.Location=New-Object System.Drawing.Point(-30000,-30000)
$form.ShowInTaskbar=$false
$form.FormBorderStyle='Sizable'
$form.Show()
[System.IO.File]::WriteAllText($Marker,([string]$form.Handle.ToInt64()),(New-Object System.Text.UTF8Encoding($false)))
if($Role -eq 'app' -and $Signal) {
  $script:dialogOpened=$false
  $timer=New-Object System.Windows.Forms.Timer
  $timer.Interval=100
  $timer.Add_Tick({
    if(-not $script:dialogOpened -and [System.IO.File]::Exists($Signal)) {
      $script:dialogOpened=$true
      # An owned native dialog without MessageBox.Show's foreground activation.
      $dialog=New-Object BlackiceQuietTestForm
      $dialog.Text='BLACKICE application dialog'
      $dialog.Size=New-Object System.Drawing.Size(320,180)
      $dialog.StartPosition='Manual'
      $dialog.Location=New-Object System.Drawing.Point(-30000,-30000)
      $dialog.ShowInTaskbar=$false
      $dialog.Show($form)
    }
  })
  $timer.Start()
}
try {[System.Windows.Forms.Application]::Run($form)}
finally {$form.Dispose()}
