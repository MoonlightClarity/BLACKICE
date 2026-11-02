# BLACKICE guest interactive desktop streamer.
# Continuous JPEG frames originate in the guest session (never Hyper-V thumbnails).
# Runs hidden in the guest; only captures while the host viewer heartbeat is fresh.
param(
  [string]$WorkspaceRoot='W:\',
  [ValidateRange(2,25)][int]$TargetFps=15,
  [ValidateRange(35,90)][int]$Quality=68
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if(!$WorkspaceRoot -or -not [IO.Path]::IsPathRooted($WorkspaceRoot)){throw 'Expected the mapped guest workspace root.'}
$bridge=Join-Path $WorkspaceRoot '.blackice-workbench'
$identity=Join-Path $bridge 'host-info.json'
if(!(Test-Path -LiteralPath $identity)){throw 'Guest workspace handshake is absent.'}
$hostInfo=Get-Content -LiteralPath $identity -Raw|ConvertFrom-Json
if(([string]$hostInfo.hostName).Equals($env:COMPUTERNAME,[StringComparison]::OrdinalIgnoreCase)){throw 'Refusing host desktop streaming.'}
if(-not [Environment]::UserInteractive -or [Diagnostics.Process]::GetCurrentProcess().SessionId -le 0){
  throw 'A signed-in interactive guest desktop is required.'
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$stream=Join-Path $bridge 'desktop-stream'
New-Item -Path $stream -ItemType Directory -Force|Out-Null

$script:netClient=$null
$script:netStream=$null
function Disconnect-GuestVideo{
  if($script:netStream){try{$script:netStream.Dispose()}catch{}}
  if($script:netClient){try{$script:netClient.Dispose()}catch{}}
  $script:netClient=$null;$script:netStream=$null
}
function Connect-GuestVideo{
  $settingsFile=Join-Path $stream 'transport.json'
  if(!(Test-Path -LiteralPath $settingsFile)){return $false}
  $cfg=Get-Content -LiteralPath $settingsFile -Raw|ConvertFrom-Json
  if($cfg.version -ne 1 -or [string]$cfg.hostIp -notmatch '^\d{1,3}(?:\.\d{1,3}){3}$' -or
     [int]$cfg.port -lt 1024 -or [int]$cfg.port -gt 65535 -or
     [string]$cfg.token -notmatch '^[a-f0-9]{48}$'){return $false}
  $client=[Net.Sockets.TcpClient]::new()
  try{
    $attempt=$client.BeginConnect([string]$cfg.hostIp,[int]$cfg.port,$null,$null)
    if(!$attempt.AsyncWaitHandle.WaitOne(450)){throw 'Guest video listener not reachable.'}
    $client.EndConnect($attempt)
    $client.NoDelay=$true
    $socketStream=$client.GetStream()
    $socketStream.WriteTimeout=2500
    $hello=[Text.Encoding]::ASCII.GetBytes(('BIV1 '+[string]$cfg.token+[char]10))
    $socketStream.Write($hello,0,$hello.Length)
    $script:netClient=$client;$script:netStream=$socketStream
    return $true
  }catch{$client.Dispose();return $false}
}
function Write-GuestVideo([byte[]]$jpeg,[int]$width,[int]$height){
  if(!$script:netStream){return $false}
  $length=$jpeg.Length
  $header=New-Object byte[] 8
  $header[0]=[byte](($length -shr 24) -band 255)
  $header[1]=[byte](($length -shr 16) -band 255)
  $header[2]=[byte](($length -shr 8) -band 255)
  $header[3]=[byte]($length -band 255)
  $header[4]=[byte](($width -shr 8) -band 255)
  $header[5]=[byte]($width -band 255)
  $header[6]=[byte](($height -shr 8) -band 255)
  $header[7]=[byte]($height -band 255)
  try{
    $script:netStream.Write($header,0,8)
    $script:netStream.Write($jpeg,0,$length)
    return $true
  }catch{Disconnect-GuestVideo;return $false}
}
$mutex=New-Object Threading.Mutex($false,'Local\BLACKICE-Workbench-DesktopStream')
$ownsMutex=$false
try{
  $ownsMutex=$mutex.WaitOne(0)
  if(-not $ownsMutex){exit 0}
  $codec=[Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|
    Where-Object {$_.MimeType -eq 'image/jpeg'}|Select-Object -First 1
  if(!$codec){throw 'JPEG encoder unavailable in guest session.'}
  $encoderParams=[Drawing.Imaging.EncoderParameters]::new(1)
  $encoderParams.Param[0]=[Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality,[long]$Quality)
  $producer=[guid]::NewGuid().ToString('N')
  $periodMs=[int][Math]::Round(1000/$TargetFps)
  $lastAudienceCheck=[datetime]::MinValue
  $lastCleanup=[datetime]::MinValue
  $lastConnect=[datetime]::MinValue
  $lastFallback=[datetime]::MinValue
  $lastStats=[DateTime]::UtcNow
  $framesInInterval=0
  $directInInterval=0
  $sumCaptureWorkMs=0.0
  $grabSumMs=0.0
  $encodeSumMs=0.0
  $sendSumMs=0.0
  $active=$false
  $viewers=Join-Path $stream 'viewer.json'
  while($true){
    $start=[DateTime]::UtcNow
    try{
      if(($start-$lastAudienceCheck).TotalMilliseconds -gt 300){
        $lastAudienceCheck=$start
        $active=$false
        if(Test-Path -LiteralPath $viewers){
          $subscriber=Get-Content -LiteralPath $viewers -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop
          if($subscriber.version -eq 1 -and $subscriber.active -eq $true){
            $when=[datetime]::Parse([string]$subscriber.at).ToUniversalTime()
            $active=[math]::Abs(($start-$when).TotalSeconds) -lt 5
          }
        }
      }
      if($active){
        if(!$script:netStream -and ($start-$lastConnect).TotalSeconds -gt 1){
          $lastConnect=$start
          [void](Connect-GuestVideo)
        }
        $phaseTimer=[Diagnostics.Stopwatch]::StartNew()
        $rect=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        if($rect.Width -lt 160 -or $rect.Height -lt 120 -or $rect.Width -gt 7680 -or $rect.Height -gt 4320){
          throw 'Guest display resolution outside expected range.'
        }
        $image=[Drawing.Bitmap]::new($rect.Width,$rect.Height)
        try{
          $graphics=[Drawing.Graphics]::FromImage($image)
          try{$graphics.CopyFromScreen($rect.Location,[Drawing.Point]::Empty,$rect.Size)}
          finally{$graphics.Dispose()}
          $grabMs=$phaseTimer.Elapsed.TotalMilliseconds
          $output=[IO.MemoryStream]::new()
          try{
            $image.Save($output,$codec,$encoderParams)
            if($output.Length -lt 200 -or $output.Length -gt 4000000){
              throw 'Guest frame exceeds bounded transport size.'
            }
            $jpeg=$output.ToArray()
            $encodeMs=$phaseTimer.Elapsed.TotalMilliseconds-$grabMs
            $sent=Write-GuestVideo $jpeg $rect.Width $rect.Height
            $sendMs=$phaseTimer.Elapsed.TotalMilliseconds-$grabMs-$encodeMs
            $grabSumMs+=$grabMs;$encodeSumMs+=$encodeMs;$sendSumMs+=$sendMs
            if($sent){$directInInterval++}
            if(!$sent -and ($start-$lastFallback).TotalMilliseconds -gt 650){
              $lastFallback=$start
            $id=[guid]::NewGuid().ToString('N')
            $filename='frame-'+$id+'.jpg'
            $tmp=Join-Path $stream ($filename+'.tmp')
            $target=Join-Path $stream $filename
            try{
              [IO.File]::WriteAllBytes($tmp,$jpeg)
              [IO.File]::Move($tmp,$target)
            }finally{Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue}
            $metadata=[ordered]@{
              version=1
              frameId=$id
              filename=$filename
              producerId=$producer
              at=[DateTime]::UtcNow.ToString('o')
              width=[int]$rect.Width
              height=[int]$rect.Height
              bytes=[int]$output.Length
              codec='jpeg'
            }
            $manifest=Join-Path $stream 'latest.json'
            $manifestTemp=$manifest+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
            try{
              [IO.File]::WriteAllText($manifestTemp,($metadata|ConvertTo-Json -Compress),
                [Text.UTF8Encoding]::new($false))
              Move-Item -LiteralPath $manifestTemp -Destination $manifest -Force -ErrorAction Stop
            }finally{Remove-Item -LiteralPath $manifestTemp -Force -ErrorAction SilentlyContinue}
            }
          }finally{$output.Dispose()}
        }finally{$image.Dispose()}
        if(!$script:netStream -and ($start-$lastCleanup).TotalSeconds -gt 3){
          $lastCleanup=$start
          Get-ChildItem -LiteralPath $stream -Filter 'frame-*.jpg' -File -ErrorAction SilentlyContinue|
            Sort-Object LastWriteTimeUtc -Descending|Select-Object -Skip 8|
            Remove-Item -Force -ErrorAction SilentlyContinue
        }
        $elapsed=[DateTime]::UtcNow.Subtract($start).TotalMilliseconds
        $framesInInterval++
        $sumCaptureWorkMs+=$elapsed
        if(($start-$lastStats).TotalSeconds -gt 3){
          $duration=[DateTime]::UtcNow.Subtract($lastStats).TotalSeconds
          $report=[ordered]@{
            at=[DateTime]::UtcNow.ToString('o')
            measuredSeconds=[Math]::Round($duration,2)
            guestFrames=$framesInInterval
            directTcpFrames=$directInInterval
            captureFps=[Math]::Round($framesInInterval/$duration,2)
            workMsAverage=$(if($framesInInterval){[Math]::Round($sumCaptureWorkMs/$framesInInterval,2)}else{0})
            grabMsAverage=$(if($framesInInterval){[Math]::Round($grabSumMs/$framesInInterval,2)}else{0})
            encodeMsAverage=$(if($framesInInterval){[Math]::Round($encodeSumMs/$framesInInterval,2)}else{0})
            sendMsAverage=$(if($framesInInterval){[Math]::Round($sendSumMs/$framesInInterval,2)}else{0})
            targetFps=$TargetFps
            quality=$Quality
            resolution=[string]$rect.Width+'x'+[string]$rect.Height
          }
          try{[IO.File]::WriteAllText((Join-Path $stream 'video-stats.json'),
            ($report|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))}catch{}
          $lastStats=[DateTime]::UtcNow;$framesInInterval=0;$directInInterval=0;$sumCaptureWorkMs=0
          $grabSumMs=0;$encodeSumMs=0;$sendSumMs=0
        }
        $sleepMs=[int][Math]::Max(10,$periodMs-$elapsed)
        Start-Sleep -Milliseconds $sleepMs
      }else{
        if($script:netStream){Disconnect-GuestVideo}
        Start-Sleep -Milliseconds 180
      }
    }catch{
      # Guest-only diagnostics, independent from the command agent's heartbeat.
      $line=([DateTime]::UtcNow.ToString('o')+' '+[string]$_.Exception.Message)
      try{[IO.File]::WriteAllText((Join-Path $stream 'last-error.txt'),$line)}catch{}
      Start-Sleep -Milliseconds 450
    }
  }
}finally{
  Disconnect-GuestVideo
  if($ownsMutex){$mutex.ReleaseMutex()|Out-Null}
  $mutex.Dispose()
}
