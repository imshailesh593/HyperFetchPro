<#
  Generates the app icon from code (no design tool needed):
    apps\windows\DownloadManager\Assets\app.ico   (16, 24, 32, 48, 64, 128, 256 px, PNG-compressed)
    apps\windows\DownloadManager\Assets\logo.png  (64 px, used in the title bar)
    apps\extension\icons\icon16.png, icon32.png, icon48.png, icon128.png
  A rounded square in the brand gradient (cyan to blue to purple) with a white download arrow.
  Usage: .\scripts\make-icons.ps1
#>
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$assets = Join-Path $root 'apps\windows\DownloadManager\Assets'
$extIcons = Join-Path $root 'apps\extension\icons'
New-Item -ItemType Directory -Force $assets, $extIcons | Out-Null

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)

  # rounded square background
  $pad = [Math]::Max(0.5, $size * 0.03)
  $w = $size - 2 * $pad
  $r = $size * 0.22
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($pad, $pad, 2 * $r, 2 * $r, 180, 90)
  $path.AddArc($pad + $w - 2 * $r, $pad, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($pad + $w - 2 * $r, $pad + $w - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $path.AddArc($pad, $pad + $w - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $path.CloseFigure()

  $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 6, 182, 212), [System.Drawing.Color]::FromArgb(255, 121, 40, 202), 45.0)
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend(3)
  $blend.Colors = @([System.Drawing.Color]::FromArgb(255, 6, 182, 212), [System.Drawing.Color]::FromArgb(255, 37, 99, 235), [System.Drawing.Color]::FromArgb(255, 121, 40, 202))
  $blend.Positions = @(0.0, 0.55, 1.0)
  $brush.InterpolationColors = $blend
  $g.FillPath($brush, $path)

  # white download arrow: shaft + head, resting on a base line
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $cx = $size / 2.0
  $shaftW = $size * 0.16
  $shaftTop = $size * 0.20
  $headTop = $size * 0.45
  $tip = $size * 0.68
  $headHalf = $size * 0.23
  $g.FillRectangle($white, $cx - $shaftW / 2, $shaftTop, $shaftW, $headTop - $shaftTop + 1)
  $head = @(
    (New-Object System.Drawing.PointF(($cx - $headHalf), $headTop)),
    (New-Object System.Drawing.PointF(($cx + $headHalf), $headTop)),
    (New-Object System.Drawing.PointF($cx, $tip))
  )
  $g.FillPolygon($white, $head)
  $baseH = [Math]::Max(1.0, $size * 0.075)
  $baseW = $size * 0.50
  $g.FillRectangle($white, $cx - $baseW / 2, $size * 0.76, $baseW, $baseH)

  $g.Dispose(); $brush.Dispose(); $white.Dispose(); $path.Dispose()
  return $bmp
}

function ConvertTo-PngBytes($bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  return , $ms.ToArray()
}

# --- .ico with PNG-compressed images (supported by Windows Vista and later)
$sizes = 16, 24, 32, 48, 64, 128, 256
$images = foreach ($s in $sizes) { $b = New-IconBitmap $s; [pscustomobject]@{ Size = $s; Bytes = (ConvertTo-PngBytes $b) }; $b.Dispose() }

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
  $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$img.Bytes.Length); $bw.Write([uint32]$offset)
  $offset += $img.Bytes.Length
}
foreach ($img in $images) { $bw.Write($img.Bytes) }
$bw.Flush()
[IO.File]::WriteAllBytes((Join-Path $assets 'app.ico'), $ms.ToArray())

# --- PNGs
$logo = New-IconBitmap 64; $logo.Save((Join-Path $assets 'logo.png'), [System.Drawing.Imaging.ImageFormat]::Png); $logo.Dispose()
foreach ($s in 16, 32, 48, 128) {
  $b = New-IconBitmap $s; $b.Save((Join-Path $extIcons "icon$s.png"), [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
}
"Wrote app.ico ($($images.Count) sizes), logo.png and extension icons."
