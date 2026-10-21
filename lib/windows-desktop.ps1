param([switch]$Stream)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Invoke-RelayDesktop([string]$raw) {
    try {
        if ($raw.Length -gt 100000) { throw 'Desktop request exceeded the size limit.' }
        $request = $raw | ConvertFrom-Json
        $supported = @('screenshot', 'windows', 'inspect', 'get_text', 'invoke', 'set_value', 'select', 'toggle', 'expand', 'collapse', 'scroll', 'scroll_into_view')
        if ($supported -notcontains $request.action) { throw 'Unsupported desktop action. Physical mouse, keyboard and focus actions are disabled. Inspect a window and use the advertised accessibility patterns.' }
        if (-not ('RelayDesktop' -as [type])) {
            Add-Type -AssemblyName System.Drawing
            Add-Type -AssemblyName UIAutomationClient
            Add-Type -AssemblyName UIAutomationTypes
            Add-Type -AssemblyName WindowsBase
            Add-Type -Path @((Join-Path $PSScriptRoot 'windows-native-uia.cs'),(Join-Path $PSScriptRoot 'windows-uia.cs')) -ReferencedAssemblies @(
                [System.Windows.Automation.AutomationElement].Assembly.Location,
                [System.Windows.Automation.AutomationPattern].Assembly.Location,
                [System.Windows.Rect].Assembly.Location,
                'System.dll', 'System.Core.dll'
            )
        }
        [RelayDesktop]::EnableDpi()
        function Assert-Integer($value, [long]$minimum, [long]$maximum, [string]$label) {
            if ($null -eq $value -or $value -is [bool] -or $value -is [string] -or [double]$value -ne [math]::Floor([double]$value) -or $value -lt $minimum -or $value -gt $maximum) { throw "Invalid $label." }
        }
        if ($null -ne $request.handle -and ($request.handle -isnot [string] -or $request.handle -notmatch '^[1-9]\d{0,18}$')) { throw 'Invalid window handle. List windows again.' }
        if ($null -ne $request.ref -and ($request.ref -isnot [string] -or $request.ref -notmatch '^uia_[a-f0-9]{12}_[1-9]\d{0,6}$')) { throw 'Invalid accessibility ref. Inspect the window again.' }
        $result = @{ ok=$true; mode='background_uia'; physicalInput=$false }
        switch ($request.action) {
            'screenshot' {
                $originX=[RelayDesktop]::GetSystemMetrics(76); $originY=[RelayDesktop]::GetSystemMetrics(77)
                $nativeWidth=[RelayDesktop]::GetSystemMetrics(78); $nativeHeight=[RelayDesktop]::GetSystemMetrics(79)
                if ($nativeWidth -lt 1 -or $nativeHeight -lt 1 -or [long]$nativeWidth * $nativeHeight -gt 100000000) { throw 'The Windows desktop is unavailable or exceeds the capture limit.' }
                Assert-Integer $request.maxWidth 1 1280 'maximum screenshot width'
                Assert-Integer $request.maxHeight 1 900 'maximum screenshot height'
                $scale=[math]::Min(1.0, [math]::Min($request.maxWidth/[double]$nativeWidth, $request.maxHeight/[double]$nativeHeight))
                $width=[math]::Max(1, [int][math]::Floor($nativeWidth*$scale)); $height=[math]::Max(1, [int][math]::Floor($nativeHeight*$scale))
                $bitmap=$null; $graphics=$null; $resized=$null; $resizer=$null; $stream=$null
                try {
                    $foreground=@([RelayDesktop]::Windows() | Where-Object { $_.foreground } | Select-Object -First 1)
                    if ($foreground.Count -gt 0) { $result.foregroundWindow=@{id=$foreground[0].handle;handle=$foreground[0].handle;title=$foreground[0].title;pid=$foreground[0].pid} }
                    $bitmap=New-Object System.Drawing.Bitmap($nativeWidth,$nativeHeight,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
                    $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
                    $graphics.CopyFromScreen($originX,$originY,0,0,$bitmap.Size,[System.Drawing.CopyPixelOperation]::SourceCopy)
                    $resized=New-Object System.Drawing.Bitmap($width,$height,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
                    $resizer=[System.Drawing.Graphics]::FromImage($resized); $resizer.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $resizer.DrawImage($bitmap,0,0,$width,$height)
                    $stream=New-Object System.IO.MemoryStream; $resized.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
                    $result.image=@{data=[Convert]::ToBase64String($stream.ToArray());mimeType='image/png';width=$width;height=$height}
                    $result.coordinates=@{width=$width;height=$height;nativeWidth=$nativeWidth;nativeHeight=$nativeHeight;originX=$originX;originY=$originY;scaleX=$nativeWidth/[double]$width;scaleY=$nativeHeight/[double]$height}
                    $result.text="Read-only Windows desktop screenshot: ${width}x${height}. Use inspect and element refs for actions; screenshot coordinates are never used for input."
                } finally {
                    if ($stream) { $stream.Dispose() }; if ($resizer) { $resizer.Dispose() }; if ($resized) { $resized.Dispose() }; if ($graphics) { $graphics.Dispose() }; if ($bitmap) { $bitmap.Dispose() }
                }
            }
            'windows' {
                $result.windows=@([RelayDesktop]::Windows() | ForEach-Object { @{id=$_.handle;handle=$_.handle;title=$_.title;pid=$_.pid;foreground=$_.foreground;bounds=@{x=$_.x;y=$_.y;width=$_.width;height=$_.height}} })
                $result.text="Found $($result.windows.Count) visible Windows applications. Choose a windowId and inspect its accessibility controls. Listing does not activate a window."
            }
            'inspect' {
                if (-not $request.handle -and -not $request.ref) { throw 'inspect requires a windowId or accessibility ref.' }
                Assert-Integer $request.maxDepth 0 10 'inspection depth'; Assert-Integer $request.maxNodes 1 300 'inspection node limit'
                if ($request.query -isnot [string] -or $request.query.Length -gt 200 -or $request.query.Contains([char]0)) { throw 'Invalid inspection query.' }
                $inspection=[RelayDesktop]::Inspect([string]$request.handle,[string]$request.ref,[int]$request.maxDepth,[int]$request.maxNodes,[string]$request.query)
                $result.windowId=$inspection.windowId; $result.rootRef=$inspection.rootRef; $result.elements=@($inspection.elements); $result.visited=$inspection.visited; $result.truncated=$inspection.truncated
                $result.text="Inspected $($inspection.visited) accessibility controls without activating the application. Use each element's ref and advertised actions. Reinspect after navigation or a stale-reference error."
            }
            'get_text' {
                Assert-Integer $request.maxCharacters 1 12000 'text length limit'
                $result.text=[RelayDesktop]::ReadText([string]$request.ref,[int]$request.maxCharacters); $result.ref=$request.ref
            }
            default {
                if (-not $request.ref -or $request.handle) { throw 'An accessibility action requires a ref from inspect, not a window handle.' }
                $before=[RelayDesktop]::ObserveInput()
                [RelayDesktop]::Act([string]$request.action,[string]$request.ref,[string]$request.value,[string]$request.direction,[int]$request.amount,[string]$request.unit)
                $after=[RelayDesktop]::ObserveInput(); $result.ref=$request.ref
                $result.mechanism=[RelayDesktop]::LastActionMechanism
                $result.observedInput=@{cursorMoved=($before.x -ne $after.x -or $before.y -ne $after.y);foregroundChanged=($before.foreground -ne $after.foreground)}
                $result.text="Completed $($request.action) through the Windows accessibility provider. No physical input or window activation was sent. Inspect to verify the application result."
                if ($result.observedInput.foregroundChanged) { $result.providerNote='The foreground changed during this action. An application provider or concurrent user activity can change focus; Relay did not request focus.' }
            }
        }
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 12 -Compress))
    } catch { [Console]::Out.WriteLine((@{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Depth 3 -Compress)) }
}
if ($Stream) { while ($null -ne ($line=[Console]::In.ReadLine())) { Invoke-RelayDesktop $line } }
else { Invoke-RelayDesktop ([Console]::In.ReadToEnd()) }
