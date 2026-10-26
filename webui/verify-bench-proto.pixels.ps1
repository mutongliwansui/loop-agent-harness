# Pixel-level cross-check for prototype 20261027-003 renders (Windows PowerShell 5.1).
# Step 1: node webui/verify-bench-proto.shot.mjs   (writes temp/verify-bench-proto.summary.json + 10 png)
# Step 2: powershell -NoProfile -ExecutionPolicy Bypass -File webui/verify-bench-proto.pixels.ps1
# Reads element rects from the summary, samples those pixels in the PNG screenshots and
# asserts the sampled RGB equals the design token value (light / dark separately).
# Pure ASCII only (PowerShell 5.1 reads -File scripts as ANSI).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$summaryPath = Join-Path $root 'temp\verify-bench-proto.summary.json'
if (-not (Test-Path $summaryPath)) {
    Write-Host "missing $summaryPath - run node webui/verify-bench-proto.shot.mjs first"
    exit 2
}
$summary = Get-Content -Raw -Encoding UTF8 $summaryPath | ConvertFrom-Json

$fail = 0
$checks = 0

function Get-PixelInfo {
    param([System.Drawing.Bitmap]$Bmp, [double]$X, [double]$Y)
    $ix = [int][Math]::Round($X)
    $iy = [int][Math]::Round($Y)
    if ($ix -lt 0 -or $iy -lt 0 -or $ix -ge $Bmp.Width -or $iy -ge $Bmp.Height) {
        return $null
    }
    $c = $Bmp.GetPixel($ix, $iy)
    return [pscustomobject]@{ X = $ix; Y = $iy; R = $c.R; G = $c.G; B = $c.B }
}

function Assert-Color {
    param([string]$Name, $Pix, [int]$R, [int]$G, [int]$B, [int]$Tol = 6)
    $script:checks++
    if ($null -eq $Pix) {
        Write-Host ("  X {0}  <out of image bounds>" -f $Name)
        $script:fail++
        return
    }
    $dr = [Math]::Abs($Pix.R - $R)
    $dg = [Math]::Abs($Pix.G - $G)
    $db = [Math]::Abs($Pix.B - $B)
    if ($dr -le $Tol -and $dg -le $Tol -and $db -le $Tol) {
        Write-Host ("  ok {0}  rgb({1},{2},{3}) at ({4},{5})" -f $Name, $Pix.R, $Pix.G, $Pix.B, $Pix.X, $Pix.Y)
    }
    else {
        Write-Host ("  X  {0}  got rgb({1},{2},{3}) want rgb({4},{5},{6}) at ({7},{8})" -f `
                $Name, $Pix.R, $Pix.G, $Pix.B, $R, $G, $B, $Pix.X, $Pix.Y)
        $script:fail++
    }
}

$expect = @{
    # maskOverBg = page bg blended under the drawer mask rgba(17,24,39,.32)
    'light' = @{ ok = @(5, 150, 105); brand = @(14, 159, 110); panel = @(255, 255, 255); bg = @(246, 247, 249); maskOverBg = @(172, 175, 182) }
    'dark'  = @{ ok = @(52, 211, 153); brand = @(52, 211, 153); panel = @(27, 31, 38); bg = @(20, 23, 28); maskOverBg = @(18, 23, 32) }
}

foreach ($theme in @('light', 'dark')) {
    $entry = $summary."done-$theme"
    $png = $entry.png
    $bmp = [System.Drawing.Bitmap]::FromFile($png)
    Write-Host ("`n=== done/$theme  {0}  image {1}x{2} ===" -f (Split-Path $png -Leaf), $bmp.Width, $bmp.Height)

    $script:checks++
    if ($bmp.Width -eq $entry.viewport.w -and $bmp.Height -eq $entry.viewport.h) {
        Write-Host ("  ok screenshot size == viewport ({0}x{1})" -f $bmp.Width, $bmp.Height)
    }
    else {
        Write-Host ("  X  screenshot size {0}x{1} != viewport {2}x{3}" -f $bmp.Width, $bmp.Height, $entry.viewport.w, $entry.viewport.h)
        $script:fail++
    }

    # 1) metric card left 3px status bar (pseudo element ::before)
    $m = $entry.anchors.metricGoodBar
    $p1 = Get-PixelInfo $bmp ($m.x + 2) ($m.y + $m.h / 2)
    Assert-Color "metric.good status bar ($theme)" $p1 $expect[$theme].ok[0] $expect[$theme].ok[1] $expect[$theme].ok[2]

    # just inside the card body (should be panel white / dark panel)
    $p2 = Get-PixelInfo $bmp ($m.x + 40) ($m.y + $m.h / 2)
    Assert-Color "metric.good card body ($theme)" $p2 $expect[$theme].panel[0] $expect[$theme].panel[1] $expect[$theme].panel[2]

    # 2) best comparison bar fill
    $b = $entry.anchors.bestBar
    $p3 = Get-PixelInfo $bmp ($b.x + $b.w / 2) ($b.y + $b.h / 2)
    Assert-Color "compare best bar ($theme)" $p3 $expect[$theme].brand[0] $expect[$theme].brand[1] $expect[$theme].brand[2]

    # 3) drawer panel background (a point above the drawer header border)
    $d = $entry.anchors.drawer
    $p4 = Get-PixelInfo $bmp ($d.x + $d.w - 12) ($d.y + 40)
    Assert-Color "drawer panel bg ($theme)" $p4 $expect[$theme].panel[0] $expect[$theme].panel[1] $expect[$theme].panel[2]

    # 4) page area left of the drawer: masked bg (mask overlay drawn over page bg)
    $p5 = Get-PixelInfo $bmp 300 940
    Assert-Color "page bg under mask ($theme)" $p5 $expect[$theme].maskOverBg[0] $expect[$theme].maskOverBg[1] $expect[$theme].maskOverBg[2]

    # 5) the bar must not be wider than its track (geometric sanity on pixels)
    $script:checks++
    $rightEdge = $b.x + $b.w
    $p6 = Get-PixelInfo $bmp ($rightEdge + 6) ($b.y + $b.h / 2)
    if ($null -ne $p6 -and -not ($p6.R -eq $expect[$theme].brand[0] -and $p6.G -eq $expect[$theme].brand[1] -and $p6.B -eq $expect[$theme].brand[2])) {
        Write-Host ("  ok bar ends near x={0} (outside sample rgb({1},{2},{3}))" -f $rightEdge, $p6.R, $p6.G, $p6.B)
    }
    else {
        Write-Host ("  X  best bar seems to extend past x={0}" -f $rightEdge)
        $script:fail++
    }

    $bmp.Dispose()
}

# 6) table state: the new "performance" pills must actually be painted (not white-on-white)
foreach ($theme in @('light', 'dark')) {
    $entry = $summary."table-$theme"
    $bmp = [System.Drawing.Bitmap]::FromFile($entry.png)
    Write-Host ("`n=== table/$theme  {0} ===" -f (Split-Path $entry.png -Leaf))
    $cells = $entry.text.perfCol
    $script:checks++
    if ($cells.Count -eq 4) {
        Write-Host ("  ok perf column rendered 4 cells: {0}" -f ($cells -join ' | '))
    }
    else {
        Write-Host ("  X  perf column cells = {0}" -f $cells.Count)
        $script:fail++
    }
    # scan a horizontal band where the perf column lives and make sure some pixel
    # differs from the panel background (i.e. badges are actually drawn)
    $band = $null
    $script:checks++
    $found = $false
    for ($y = 380; $y -lt 700 -and -not $found; $y += 3) {
        for ($x = 900; $x -lt 1500 -and -not $found; $x += 3) {
            $px = Get-PixelInfo $bmp $x $y
            if ($null -ne $px) {
                $bg = $expect[$theme].panel
                if ([Math]::Abs($px.R - $bg[0]) -gt 12 -or [Math]::Abs($px.G - $bg[1]) -gt 12 -or [Math]::Abs($px.B - $bg[2]) -gt 12) {
                    $band = $px
                    $found = $true
                }
            }
        }
    }
    if ($found) {
        Write-Host ("  ok non-background pixel in table band at ({0},{1}) rgb({2},{3},{4})" -f $band.X, $band.Y, $band.R, $band.G, $band.B)
    }
    else {
        Write-Host "  X  table band looks empty (badges not painted?)"
        $script:fail++
    }
    # unmasked page background proves the token is applied (no mask here: drawer closed)
    $pbg = Get-PixelInfo $bmp 300 940
    Assert-Color "page bg unmasked ($theme)" $pbg $expect[$theme].bg[0] $expect[$theme].bg[1] $expect[$theme].bg[2]
    $bmp.Dispose()
}

Write-Host ("`npixel checks: {0}, failed: {1}" -f $checks, $fail)
if ($fail -gt 0) { exit 1 } else { exit 0 }
