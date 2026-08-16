# Generuje komplet grafik wymaganych przez pakiet MSIX/AppX (Microsoft Store)
# na podstawie build/icon.png. Uruchom po każdej zmianie ikony:
#   powershell -ExecutionPolicy Bypass -File build\make-appx-assets.ps1

Add-Type -AssemblyName System.Drawing

$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcPath = Join-Path $root 'icon.png'
$outDir  = Join-Path $root 'appx'
New-Item -ItemType Directory -Force $outDir | Out-Null

$src = [System.Drawing.Image]::FromFile($srcPath)
# kolor tła kafelków — ciemne tło aplikacji
$bg = [System.Drawing.Color]::FromArgb(255, 28, 27, 26)

function Save-Logo {
  param(
    [string]$Name,
    [int]$Width,
    [int]$Height,
    [switch]$Transparent   # ikona wypełnia całą powierzchnię, bez tła
  )
  $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'

  if ($Transparent) {
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $Width, $Height)
  } else {
    $g.Clear($bg)
    # ikona wpisana w kwadrat = 66% krótszego boku, wyśrodkowana
    $side = [int]([Math]::Min($Width, $Height) * 0.66)
    $x = [int](($Width - $side) / 2)
    $y = [int](($Height - $side) / 2)
    $g.DrawImage($src, $x, $y, $side, $side)
  }

  $g.Dispose()
  $path = Join-Path $outDir $Name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("  {0,-26} {1}x{2}" -f $Name, $Width, $Height)
}

Write-Output 'Generowanie grafik AppX/MSIX:'
# ikony aplikacji (przezroczyste tło — Windows sam podkłada kolor kafelka)
Save-Logo -Name 'Square44x44Logo.png'   -Width 44   -Height 44   -Transparent
Save-Logo -Name 'Square71x71Logo.png'   -Width 71   -Height 71   -Transparent
Save-Logo -Name 'Square150x150Logo.png' -Width 150  -Height 150  -Transparent
Save-Logo -Name 'Square310x310Logo.png' -Width 310  -Height 310  -Transparent
Save-Logo -Name 'StoreLogo.png'         -Width 50   -Height 50   -Transparent
# kafelek szeroki i ekran powitalny — ikona na tle
Save-Logo -Name 'Wide310x150Logo.png'   -Width 310  -Height 150
Save-Logo -Name 'SplashScreen.png'      -Width 620  -Height 300

$src.Dispose()
Write-Output "Gotowe: $outDir"
