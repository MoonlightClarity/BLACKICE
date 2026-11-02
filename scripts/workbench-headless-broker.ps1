#Requires -Version 5.1
<#
BLACKICE Workbench headless control. Runs as a pre-authorized SYSTEM
scheduled task in Session 0. No desktop window, UAC or host input.
Diagnostic mode validates the pipe but cannot control a virtual machine.
#>
param(
  [ValidatePattern('^BLACKICE-Workbench-v1(?:-test-[a-z0-9]{6,20})?$')][string]$PipeName='BLACKICE-Workbench-v1',
  [string]$AuthorizedSid='',
  [string]$MediaDirectory='',
  [string]$VmDirectory='',
  [switch]$DiagnosticOnly,
  [switch]$DirectOnce
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$script:VmName='BLACKICE-Workbench'
$script:Identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$script:SessionId=(Get-Process -Id $PID -ErrorAction Stop).SessionId
$script:AdminToken=[Security.Principal.WindowsPrincipal]::new($script:Identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
# Administrator consent happens at BLACKICE launch, not inside Workbench.
# An already-elevated child inherits the same token without new UAC prompts.
$script:Authority=(($script:Identity.User.Value -eq 'S-1-5-18' -and $script:SessionId -eq 0) -or ($DirectOnce -and $script:AdminToken)) -and !$DiagnosticOnly
if($script:Authority -and !$DirectOnce){
  if(![IO.Path]::IsPathRooted($MediaDirectory) -or ![IO.Path]::IsPathRooted($VmDirectory)){
    throw 'Headless VM storage folders require absolute paths.'
  }
  $script:MediaRoot=[IO.Path]::GetFullPath($MediaDirectory)
  $script:VmRoot=[IO.Path]::GetFullPath($VmDirectory)
}
if(!$DirectOnce){
  if(!$AuthorizedSid){
    if(!$DiagnosticOnly){throw 'An authorized Windows client SID must be explicitly configured.'}
    $AuthorizedSid=$script:Identity.User.Value
  }
  if($AuthorizedSid -notmatch '^S-1-5-(?:\d+-){1,15}\d+$'){throw 'Invalid Windows client SID.'}
  $security=[System.IO.Pipes.PipeSecurity]::new()
  $security.SetAccessRuleProtection($true,$false)
  foreach($sid in @($AuthorizedSid,'S-1-5-18')){
    $principal=[System.Security.Principal.SecurityIdentifier]::new($sid)
    $rule=[System.IO.Pipes.PipeAccessRule]::new(
      $principal,[System.IO.Pipes.PipeAccessRights]::ReadWrite,
      [System.Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
  }
}
function Assert-Authority {
  if(!$script:Authority){throw 'Administrator-approved BLACKICE or an authorized Session 0 SYSTEM task is required.'}
  Import-Module Hyper-V -ErrorAction Stop
  [void]@(Get-VM -ErrorAction Stop)
}
function Get-WorkbenchVM {
  Assert-Authority
  return (Get-VM -Name $script:VmName -ErrorAction SilentlyContinue)
}
function Get-Resources($resourceRequest){
  # `$args` is an automatic PowerShell array and silently shadows a parameter
  # named `args`. Use a distinct parameter to retain the requested values.
  $r=[ordered]@{minimumMiB=[int]$resourceRequest.minimumMiB;startupMiB=[int]$resourceRequest.startupMiB;
    maximumMiB=[int]$resourceRequest.maximumMiB;cpuCount=[int]$resourceRequest.cpuCount}
  if($r.minimumMiB -lt 2048 -or $r.startupMiB -lt 4096 -or $r.startupMiB -lt $r.minimumMiB -or
    $r.maximumMiB -lt $r.startupMiB -or $r.maximumMiB -gt 131072 -or $r.cpuCount -lt 1 -or $r.cpuCount -gt 64){
    throw 'The guest resource request is out of bounds.'
  }
  $cores=[int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
  if($r.cpuCount -gt [Math]::Max(1,$cores-2)){throw 'The guest CPU request would overcommit the host.'}
  return $r
}
function Get-GuestDisplay {
  $vm=Get-WorkbenchVM
  if(!$vm -or [string]$vm.State -ne 'Running'){throw 'The guest is not running.'}
  Add-Type -AssemblyName System.Drawing
  $guest=@(Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem -Filter "ElementName='BLACKICE-Workbench'" -ErrorAction Stop)
  $service=@(Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_VirtualSystemManagementService -ErrorAction Stop)
  if($guest.Count -ne 1 -or $service.Count -ne 1){throw 'Guest video capture is unavailable.'}
  # Hyper-V's thumbnail method requires the *current VM settings* reference,
  # not the Msvm_ComputerSystem VM object. Keep this guest-scoped and refuse
  # absent or ambiguous settings instead of guessing or touching host display.
  $settings=@($guest[0].GetRelated('Msvm_VirtualSystemSettingData',
    'Msvm_SettingsDefineState',$null,$null,'SettingData','ManagedElement',$false,$null))
  if($settings.Count -ne 1){throw 'Current guest display settings are unavailable or ambiguous.'}
  $settingPath=[string]$settings[0].Path.Path
  if(!$settingPath){throw 'Current guest display settings lack a WMI reference.'}
  $width=800;$height=600
  $parameters=$service[0].GetMethodParameters('GetVirtualSystemThumbnailImage')
  $parameters['TargetSystem']=$settingPath
  $parameters['WidthPixels']=[uint16]$width
  $parameters['HeightPixels']=[uint16]$height
  $frame=$service[0].InvokeMethod('GetVirtualSystemThumbnailImage',$parameters,$null)
  if([int]$frame.ReturnValue -ne 0){throw ('Guest video returned error '+$frame.ReturnValue)}
  $pixels=$width*$height*2
  $bytes=[byte[]]$frame.ImageData
  if($bytes.Length -lt $pixels -or $bytes.Length -gt $pixels+16){throw 'Unexpected guest video dimensions.'}
  $bitmap=[System.Drawing.Bitmap]::new($width,$height,[System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
  try{
    $rect=[System.Drawing.Rectangle]::new(0,0,$width,$height)
    $data=$bitmap.LockBits($rect,[System.Drawing.Imaging.ImageLockMode]::WriteOnly,
      [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
    try{
      if($data.Stride*$data.Height -ne $pixels){throw 'Guest video stride changed.'}
      [Runtime.InteropServices.Marshal]::Copy($bytes,0,$data.Scan0,$pixels)
    }finally{$bitmap.UnlockBits($data)}
    $out=[System.Drawing.Bitmap]::new($width,$height)
    try{
      $graphics=[System.Drawing.Graphics]::FromImage($out)
      try{$graphics.DrawImage($bitmap,0,0,$width,$height)}finally{$graphics.Dispose()}
      $memory=[IO.MemoryStream]::new()
      try{
        $out.Save($memory,[System.Drawing.Imaging.ImageFormat]::Jpeg)
        if($memory.Length -gt 900000){throw 'Guest snapshot exceeded size limit.'}
        return [ordered]@{width=$width;height=$height;jpeg=[Convert]::ToBase64String($memory.ToArray())}
      }finally{$memory.Dispose()}
    }finally{$out.Dispose()}
  }finally{$bitmap.Dispose()}
}
function Send-GuestKey([string]$key){
  $vm=Get-WorkbenchVM
  if(!$vm -or [string]$vm.State -ne 'Running'){throw 'The guest is not running.'}
  $codes=@{ENTER=13;TAB=9;SPACE=32;ESCAPE=27;UP=38;DOWN=40;LEFT=37;
    RIGHT=39;BACKSPACE=8;F10=121;F12=123}
  if(!$codes.ContainsKey($key)){throw 'Unsupported guest-only keyboard key.'}
  $guest=@(Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem -Filter "ElementName='BLACKICE-Workbench'" -ErrorAction Stop)
  if($guest.Count -ne 1){throw 'Guest virtual keyboard identity is ambiguous.'}
  $keyboards=@($guest[0].GetRelated('Msvm_Keyboard'))
  if($keyboards.Count -ne 1){throw 'Guest virtual keyboard missing.'}
  $receipt=$keyboards[0].TypeKey([uint16]$codes[$key])
  if([int]$receipt.ReturnValue -ne 0){throw ('Virtual keyboard returned '+$receipt.ReturnValue)}
  return [ordered]@{guest=$script:VmName;key=$key;delivered=$true}
}
function Send-GuestText([string]$text){
  $vm=Get-WorkbenchVM
  if(!$vm -or [string]$vm.State -ne 'Running'){throw 'The guest is not running.'}
  if(!$text -or $text.Length -gt 200 -or $text -match '[\x00-\x1f\x7f]'){
    throw 'Guest-only text must be printable and no longer than 200 characters.'
  }
  $guests=@(Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem -Filter "ElementName='BLACKICE-Workbench'" -ErrorAction Stop)
  if($guests.Count -ne 1){throw 'Guest keyboard owner is ambiguous.'}
  $keyboards=@($guests[0].GetRelated('Msvm_Keyboard'))
  if($keyboards.Count -ne 1){throw 'The guest virtual keyboard is unavailable.'}
  # Microsoft's Hyper-V TypeText API simulates typed characters in the guest.
  # It never sends keyboard or pointer input to the Windows host.
  $result=$keyboards[0].TypeText($text)
  if([int]$result.ReturnValue -ne 0){throw ('Guest text typing failed: '+$result.ReturnValue)}
  return [ordered]@{guest=$script:VmName;typed=$true;characters=$text.Length}
}
function Send-GuestClick([int]$x,[int]$y,[int]$button){
  $vm=Get-WorkbenchVM
  if(!$vm -or [string]$vm.State -ne 'Running'){throw 'The guest is not running.'}
  if($x -lt 0 -or $x -ge 800 -or $y -lt 0 -or $y -ge 600 -or $button -notin @(1,2,3)){
    throw 'Guest click must target the observed 800 by 600 VM frame.'
  }
  $guests=@(Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem -Filter "ElementName='BLACKICE-Workbench'" -ErrorAction Stop)
  if($guests.Count -ne 1){throw 'The target guest mouse device is ambiguous.'}
  $mouse=@($guests[0].GetRelated('Msvm_SyntheticMouse'))
  $controllers=@($guests[0].GetRelated('Msvm_SyntheticDisplayController'))
  if($mouse.Count -ne 1 -or $controllers.Count -ne 1){
    throw 'The guest synthetic mouse or display controller is not available.'
  }
  $video=@($controllers[0].GetRelated('Msvm_VideoHead'))
  if($video.Count -ne 1){throw 'The guest video head is unavailable.'}
  $width=[int]$video[0].CurrentHorizontalResolution
  $height=[int]$video[0].CurrentVerticalResolution
  if($width -lt 160 -or $height -lt 120 -or $width -gt 8192 -or $height -gt 8192){
    throw 'The guest display resolution is unknown; refusing to guess a click target.'
  }
  # Microsoft defines SetAbsolutePosition coordinates in guest screen pixels.
  # Scale from the verified 800x600 screenshot to that native resolution.
  $actualX=[int][math]::Round([double]$x*($width-1)/799.0)
  $actualY=[int][math]::Round([double]$y*($height-1)/599.0)
  $moved=$mouse[0].SetAbsolutePosition($actualX,$actualY)
  if([int]$moved.ReturnValue -ne 0){
    throw ('The guest synthetic mouse refused positioning: '+$moved.ReturnValue)
  }
  $clicked=$mouse[0].ClickButton([uint32]$button)
  if([int]$clicked.ReturnValue -ne 0){
    throw ('The guest synthetic mouse refused the click: '+$clicked.ReturnValue)
  }
  return [ordered]@{guest=$script:VmName;clicked=$true;
    x=$x;y=$y;button=$button;guestX=$actualX;guestY=$actualY}
}
function Invoke-Broker($request){
  if($request.v -ne 1 -or $request.op -notin @('ping','status','provision','start','stop','key','frame','type','click')){
    throw 'Unsupported Workbench protocol or command.'
  }
  if($request.args -isnot [pscustomobject]){throw 'A structured object of arguments is required.'}
  $props=@($request.args.PSObject.Properties | ForEach-Object {$_.Name})
  $allowed=switch($request.op){
    'provision' {@('isoPath','vmRoot','minimumMiB','startupMiB','maximumMiB','cpuCount')}
    'start' {@('minimumMiB','startupMiB','maximumMiB','cpuCount')}
    'key' {@('key')}
    'type' {@('text')}
    'click' {@('x','y','button')}
    default {@()}
  }
  foreach($prop in $props){if($prop -notin $allowed){throw ('Unsupported Workbench parameter: '+$prop)}}
  if($request.op -eq 'ping'){
    return [ordered]@{broker='BLACKICE-Workbench';version=1;identity=$script:Identity.Name;
      identitySid=$script:Identity.User.Value;sessionIsolated=($script:SessionId -eq 0);diagnostic=[bool]$DiagnosticOnly}
  }
  if($request.op -eq 'status'){
    $state=[ordered]@{broker='BLACKICE-Workbench';identity=$script:Identity.Name;
      identitySid=$script:Identity.User.Value;sessionIsolated=($script:SessionId -eq 0);
      vmQueryAuthorized=$false;vmExists=$false;vmState='Unknown';
      vmProcessorCount=0;vmAssignedMemoryMiB=0;shareExists=$false;sharePath='';
      reason='Headless broker requires a pre-authorized Session 0 SYSTEM task.'}
    if(!$script:Authority){return $state}
    try{
      Import-Module Hyper-V -ErrorAction Stop
      [void]@(Get-VM -ErrorAction Stop)
      $vm=Get-VM -Name $script:VmName -ErrorAction SilentlyContinue
      $state.vmQueryAuthorized=$true
      $state.vmExists=($null -ne $vm)
      $state.vmState=if($vm){[string]$vm.State}else{'NotInstalled'}
      if($vm){
        $state.vmProcessorCount=[int]$vm.ProcessorCount
        $state.vmAssignedMemoryMiB=[int][Math]::Floor([double]$vm.MemoryAssigned/1MB)
      }
      $share=Get-SmbShare -Name 'BLACKICE-Workspace' -ErrorAction SilentlyContinue
      $state.shareExists=($null -ne $share)
      $state.sharePath=if($share){[string]$share.Path}else{''}
      $state.reason=''
    }catch{
      $state.reason=$_.Exception.Message.Substring(0,[Math]::Min(200,$_.Exception.Message.Length))
    }
    return $state
  }
  if($DiagnosticOnly){throw 'Diagnostic mode cannot change a VM or send guest input.'}
  Assert-Authority
  switch($request.op){
    'key'{
      if($props.Count -ne 1){throw 'One supported guest key is required.'}
      return (Send-GuestKey ([string]$request.args.key))
    }
    'type'{
      if($props.Count -ne 1){throw 'Exactly one guest-only text argument is required.'}
      return (Send-GuestText ([string]$request.args.text))
    }
    'click'{
      if($props.Count -ne 3){throw 'Guest-only clicks need bounded x, y and button.'}
      return (Send-GuestClick ([int]$request.args.x) ([int]$request.args.y) ([int]$request.args.button))
    }
    'frame'{return (Get-GuestDisplay)}
    'start'{
      if($props.Count -ne 4){throw 'Expected four bounded resource fields.'}
      $r=Get-Resources $request.args
      $vm=Get-WorkbenchVM
      if(!$vm -or [string]$vm.State -ne 'Off'){throw 'Persistent guest is not Off; no duplicate start.'}
      Set-VMMemory -VMName $script:VmName -DynamicMemoryEnabled $true -MinimumBytes ($r.minimumMiB*1MB) -StartupBytes ($r.startupMiB*1MB) -MaximumBytes ($r.maximumMiB*1MB) -ErrorAction Stop
      Set-VMProcessor -VMName $script:VmName -Count $r.cpuCount -ErrorAction Stop
      Start-VM -Name $script:VmName -ErrorAction Stop|Out-Null
      return [ordered]@{vm=$script:VmName;started=$true}
    }
    'stop'{
      $vm=Get-WorkbenchVM
      if(!$vm -or [string]$vm.State -ne 'Running'){throw 'Guest not running; cannot stop.'}
      Stop-VM -Name $script:VmName -Shutdown -Confirm:$false -ErrorAction Stop
      return [ordered]@{vm=$script:VmName;requestedGracefulShutdown=$true}
    }
    'provision'{
      if($props.Count -ne 6){throw 'Expected six bounded provision fields.'}
      $r=Get-Resources $request.args
      $iso=Join-Path $script:MediaRoot 'Windows.iso'
      $vmRoot=$script:VmRoot
      if([IO.Path]::GetFullPath([string]$request.args.isoPath) -ine $iso -or
        [IO.Path]::GetFullPath([string]$request.args.vmRoot) -ine $vmRoot){
        throw 'Provision target must match the installed Workbench media and VM roots.'
      }
      if(Get-VM -Name $script:VmName -ErrorAction SilentlyContinue){throw 'Existing Workbench VM preserved; no replacement.'}
      $disk=Join-Path $vmRoot 'Workbench-Windows.vhdx'
      if(Test-Path -LiteralPath $disk){throw 'Existing Workbench disk preserved; no replacement.'}
      $media=Get-Item -LiteralPath $iso -ErrorAction Stop
      if($media.Length -lt 512MB){throw 'Windows installation ISO missing or too small.'}
      $switch=Get-VMSwitch -Name 'Default Switch' -ErrorAction Stop
      New-Item -ItemType Directory -Path $vmRoot -Force|Out-Null
      New-VM -Name $script:VmName -Generation 2 -MemoryStartupBytes ($r.startupMiB*1MB) -NewVHDPath $disk -NewVHDSizeBytes 160GB -Path $vmRoot -SwitchName $switch.Name -ErrorAction Stop|Out-Null
      Set-VMMemory -VMName $script:VmName -DynamicMemoryEnabled $true -MinimumBytes ($r.minimumMiB*1MB) -StartupBytes ($r.startupMiB*1MB) -MaximumBytes ($r.maximumMiB*1MB) -ErrorAction Stop
      Set-VMProcessor -VMName $script:VmName -Count $r.cpuCount -ErrorAction Stop
      Set-VMFirmware -VMName $script:VmName -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows -ErrorAction Stop
      Set-VMKeyProtector -VMName $script:VmName -NewLocalKeyProtector -ErrorAction Stop
      Enable-VMTPM -VMName $script:VmName -ErrorAction Stop
      Add-VMDvdDrive -VMName $script:VmName -Path $iso -ErrorAction Stop
      $dvd=Get-VMDvdDrive -VMName $script:VmName|Select-Object -First 1
      Set-VMFirmware -VMName $script:VmName -FirstBootDevice $dvd -ErrorAction Stop
      Set-VM -Name $script:VmName -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -CheckpointType ProductionOnly -ErrorAction Stop
      return [ordered]@{vm=$script:VmName;provisioned=$true}
    }
  }
  throw 'Unsupported guest operation.'
}
# A one-shot operation inherits the administrator token granted when BLACKICE
# was launched. Read the bounded request from stdin so guest text never appears
# on the process command line. No UAC, host keyboard, pointer or window use.
if($DirectOnce){
  $id=''
  try{
    $raw=[Console]::In.ReadLine()
    if(!$raw -or $raw.Length -gt 10000){throw 'Invalid direct guest-console request length.'}
    $request=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
    $id=[string]$request.id
    if($id -notmatch '^[a-f0-9-]{36}$'){throw 'Invalid guest-console request identity.'}
    if($request.op -notin @('frame','key','type','click')){throw 'Only guest console operations can be run directly.'}
    if(!$script:AdminToken -or !$script:Authority){throw 'Launch BLACKICE as administrator before using the guest console.'}
    $result=Invoke-Broker $request
    $reply=[ordered]@{v=1;id=$id;ok=$true;result=$result}
  }catch{
    $message=$_.Exception.Message
    $reply=[ordered]@{v=1;id=$id;ok=$false;code='WORKBENCH_BROKER_REJECTED';
      message=$message.Substring(0,[Math]::Min(320,$message.Length))}
  }
  [Console]::Out.WriteLine(($reply|ConvertTo-Json -Depth 8 -Compress))
  exit 0
}
# Legacy preauthorized named-pipe server is no longer required by BLACKICE.
# Only the configured user SID and SYSTEM may connect if it is used.
while($true){
  $pipe=$null;$reader=$null;$writer=$null
  try{
    $pipe=[System.IO.Pipes.NamedPipeServerStream]::new(
      $PipeName,[System.IO.Pipes.PipeDirection]::InOut,1,
      [System.IO.Pipes.PipeTransmissionMode]::Byte,[System.IO.Pipes.PipeOptions]::Asynchronous,
      8192,8192,$security)
    $pipe.WaitForConnection()
    $encoding=[Text.UTF8Encoding]::new($false)
    $reader=[IO.StreamReader]::new($pipe,$encoding,$false,4096,$true)
    $writer=[IO.StreamWriter]::new($pipe,$encoding,4096,$true)
    $writer.AutoFlush=$true
    # A connected but silent client must not monopolize the single isolated
    # broker indefinitely. NamedPipeServerStream.CanTimeout is false on the
    # supported Windows PowerShell runtime: bound ReadLineAsync explicitly.
    $lineTask=$reader.ReadLineAsync()
    if(!$lineTask.Wait(3000)){
      throw 'Headless broker client did not submit a request within three seconds.'
    }
    $raw=$lineTask.GetAwaiter().GetResult()
    if(!$raw -or $raw.Length -gt 10000){throw 'Invalid broker request length.'}
    $message=ConvertFrom-Json -InputObject $raw -ErrorAction Stop
    $id=[string]$message.id
    if($id -notmatch '^[a-f0-9-]{36}$'){throw 'Invalid request identity.'}
    try{
      $result=Invoke-Broker $message
      $reply=[ordered]@{v=1;id=$id;ok=$true;result=$result}
    }catch{
      $msg=$_.Exception.Message
      $reply=[ordered]@{v=1;id=$id;ok=$false;code='WORKBENCH_BROKER_REJECTED';
        message=$msg.Substring(0,[Math]::Min(320,$msg.Length))}
    }
    $writer.WriteLine(($reply|ConvertTo-Json -Depth 8 -Compress))
  }catch{
    # Transport errors are isolated to the current request. No modal UI or
    # automatic VM retry is ever attempted. Avoid tight loops on a bad pipe.
    Start-Sleep -Milliseconds 200
  }finally{
    if($writer){$writer.Dispose()}
    if($reader){$reader.Dispose()}
    if($pipe){$pipe.Dispose()}
  }
}
