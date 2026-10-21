# Package the rendered BLACKICE SVG into one multi-resolution Windows icon.
# Render desktop/icon.svg to desktop/icon.png first (512x512, transparent).
# This script does not modify user profiles, shortcuts, or installed applications.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$png = Join-Path $PSScriptRoot 'icon.png'
$ico = Join-Path $PSScriptRoot 'icon.ico'
if (-not (Test-Path -LiteralPath $png -PathType Leaf)) { throw 'Render desktop/icon.svg to desktop/icon.png before making the icon.' }
$source = [Drawing.Bitmap]::FromFile($png)
if ($source.Width -ne 512 -or $source.Height -ne 512) { $source.Dispose(); throw 'The icon input must be 512x512.' }
$frames = @()
try {
  foreach ($size in @(16,24,32,48,64,128,256)) {
    $bitmap = [Drawing.Bitmap]::new($size,$size,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([Drawing.Color]::Transparent)
      $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.DrawImage($source,([Drawing.Rectangle]::new(0,0,$size,$size)),([Drawing.Rectangle]::new(0,0,512,512)),[Drawing.GraphicsUnit]::Pixel)
      $buffer = [IO.MemoryStream]::new()
      try {
        $bitmap.Save($buffer,[Drawing.Imaging.ImageFormat]::Png)
        $frames += ,@($size,$buffer.ToArray())
      } finally { $buffer.Dispose() }
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
  }
} finally { $source.Dispose() }
$staging = "$ico.stage"
$stream = [IO.File]::Create($staging)
$writer = [IO.BinaryWriter]::new($stream)
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
  $offset = 6 + 16 * $frames.Count
  foreach ($frame in $frames) {
    $pixel = if ($frame[0] -eq 256) { 0 } else { [int]$frame[0] }
    $writer.Write([byte]$pixel);$writer.Write([byte]$pixel)
    $writer.Write([byte]0);$writer.Write([byte]0)
    $writer.Write([uint16]1);$writer.Write([uint16]32)
    $writer.Write([uint32]$frame[1].Length);$writer.Write([uint32]$offset)
    $offset += $frame[1].Length
  }
  foreach($frame in $frames){$writer.Write([byte[]]$frame[1])}
} finally {$writer.Dispose();$stream.Dispose()}
Move-Item -LiteralPath $staging -Destination $ico -Force
Write-Output ("BLACKICE Windows icon ready: "+$frames.Count+" resolutions.")
