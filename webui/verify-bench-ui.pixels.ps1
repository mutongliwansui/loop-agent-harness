# Pixel-level cross-check for the REAL WebUI bench run (requirement 20261027-003).
# Step 1: node webui/verify-bench-ui.mjs   (writes temp/verify-bench-ui/summary.json + png)
# Step 2: powershell -NoProfile -ExecutionPolicy Bypass -File webui/verify-bench-ui.pixels.ps1
#
# Why a second pass at all: the DOM assertions read computed styles, which still succeed when a
# paint is clipped, stacked under an overlay or never rasterised. Sampling real PNG pixels catches
# exactly that class of bug (and it already did once: the prototype best-bar had width 0 while the
# computed style "looked" fine).
#
# Colour source of truth = webui/src/style.css design tokens, light + dark separately.
# Pure ASCII only (PowerShell 5.1 reads -File scripts as ANSI).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$summaryPath = Join-Path $root 'temp\verify-bench-ui\summary.json'
if (-not (Test-Path $summaryPath)) {
    Write-Host "missing $summaryPath - run node webui/verify-bench-ui.mjs first"
    exit 2
}
$summary = Get-Content -Raw -Encoding UTF8 $summaryPath | ConvertFrom-Json

$checks = 0
$fail = 0

function Get-PixelInfo {
    param([System.Drawing.Bitmap]$Bmp, [double]$X, [double]$Y)
    $ix = [int][Math]::Round($X)
    $iy = [int][Math]::Round($Y)
    if ($ix -lt 0 -or $iy -lt 0 -or $ix -ge $Bmp.Width -or $iy -ge $Bmp.Height) { return $null }
    $c = $Bmp.GetPixel($ix, $iy)
    return [pscustomobject]@{ X = $ix; Y = $iy; R = $c.R; G = $c.G; B = $c.B }
}

function Assert-Color {
    param([string]$Name, $Pix, [int]$R, [int]$G, [int]$B, [int]$Tol = 6)
    $script:checks++
    if ($null -eq $Pix) {
        Write-Host ("  X  {0}  <out of image bounds>" -f $Name)
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

function Assert-True {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    $script:checks++
    if ($Condition) { Write-Host ("  ok {0}  {1}" -f $Name, $Detail) }
    else {
        Write-Host ("  X  {0}  {1}" -f $Name, $Detail)
        $script:fail++
    }
}

# Scan a rect for any pixel close to the expected colour: proves a badge/bar was really painted
# (text glyphs are thin, so sampling one random point inside a pill would be flaky).
function Find-ColorInRect {
    param([System.Drawing.Bitmap]$Bmp, $Rect, [int]$R, [int]$G, [int]$B, [int]$Tol = 6)
    $x0 = [int][Math]::Max(0, [Math]::Round($Rect.x))
    $x1 = [int][Math]::Min($Bmp.Width - 1, [Math]::Round($Rect.x + $Rect.w))
    $y0 = [int][Math]::Max(0, [Math]::Round($Rect.y))
    $y1 = [int][Math]::Min($Bmp.Height - 1, [Math]::Round($Rect.y + $Rect.h))
    for ($y = $y0; $y -le $y1; $y += 2) {
        for ($x = $x0; $x -le $x1; $x += 2) {
            $c = $Bmp.GetPixel($x, $y)
            if ([Math]::Abs($c.R - $R) -le $Tol -and [Math]::Abs($c.G - $G) -le $Tol -and [Math]::Abs($c.B - $B) -le $Tol) {
                return [pscustomobject]@{ X = $x; Y = $y; R = $c.R; G = $c.G; B = $c.B }
            }
        }
    }
    return $null
}

# style.css tokens (light / dark)
# maskOverBg = page bg blended with .drawer-mask rgba(17,24,39,.32): 0.68*base + 0.32*mask
$expect = @{
    'light' = @{ ok = @(5, 150, 105); okWeak = @(209, 250, 229); brand = @(14, 159, 110); panel = @(255, 255, 255);
        bg = @(246, 247, 249); danger = @(220, 38, 38); dimWeak = @(241, 243, 245); maskOverBg = @(173, 176, 182) }
    'dark'  = @{ ok = @(52, 211, 153); okWeak = @(20, 53, 40); brand = @(52, 211, 153); panel = @(27, 31, 38);
        bg = @(20, 23, 28); danger = @(248, 113, 113); dimWeak = @(34, 39, 47); maskOverBg = @(19, 23, 32) }
}

# Content-area probe points on a 1600x1000 viewport: x=800/1500 y=985 sit in the page
# background (the nav rail at x<=208 is --panel white), so they also reveal whether the
# drawer mask is really painted over the page.
$PAGE_PROBE = @(800, 985)
$NAV_PROBE = @(40, 960)

# ---------------------------------------------------------------------------
# 1) completed run: metric status bar / best compare bar / drawer panel
# ---------------------------------------------------------------------------
foreach ($shot in @(
        @{ key = 'done-light'; theme = 'light'; label = 'completed run' },
        @{ key = 'done-dark'; theme = 'dark'; label = 'completed run (dark)' })) {
    $entry = $summary.($shot.key)
    if ($null -eq $entry) {
        Write-Host ("`n!!! summary missing key {0}" -f $shot.key)
        $fail++
        continue
    }
    $bmp = [System.Drawing.Bitmap]::FromFile($entry.png)
    $t = $expect[$shot.theme]
    Write-Host ("`n=== {0} / {1}  {2}  image {3}x{4} ===" -f $shot.key, $shot.theme, (Split-Path $entry.png -Leaf), $bmp.Width, $bmp.Height)

    $checks++
    if ($bmp.Width -eq [int]$entry.viewport.w -and $bmp.Height -eq [int]$entry.viewport.h) {
        Write-Host ("  ok screenshot size == viewport ({0}x{1})" -f $bmp.Width, $bmp.Height)
    }
    else {
        Write-Host ("  X  screenshot {0}x{1} != viewport {2}x{3}" -f $bmp.Width, $bmp.Height, $entry.viewport.w, $entry.viewport.h)
        $fail++
    }

    # metric card left 3px status bar (::before). Scan the left 8px strip instead of one
    # pixel: rect edges are fractional and the border is antialiased, so a single sample
    # can land on the blend seam (that is exactly how the first run produced false reds).
    $m = $entry.anchors.metricGoodBar
    $strip = [pscustomobject]@{ x = $m.x; y = $m.y; w = 8; h = $m.h }
    $barHit = Find-ColorInRect $bmp $strip $t.ok[0] $t.ok[1] $t.ok[2]
    Assert-True "metric.good status bar ($($shot.theme))" ($null -ne $barHit) $(if ($barHit) { "rgb($($barHit.R),$($barHit.G),$($barHit.B)) at ($($barHit.X),$($barHit.Y))" } else { 'no --ok pixel inside left 8px strip' })
    # just inside the card: card body must be panel, i.e. the bar is not bleeding into the card
    Assert-Color "metric.good card body ($($shot.theme))" (Get-PixelInfo $bmp ($m.x + 40) ($m.y + $m.h / 2)) $t.panel[0] $t.panel[1] $t.panel[2]

    # drawer panel background (top-right corner, above the header divider)
    $d = $entry.anchors.drawer
    Assert-Color "drawer panel bg ($($shot.theme))" (Get-PixelInfo $bmp ($d.x + $d.w - 12) ($d.y + 40)) $t.panel[0] $t.panel[1] $t.panel[2]

    if ($null -ne $entry.anchors.bestBar) {
        $b = $entry.anchors.bestBar
        $tr = $entry.anchors.bestTrack
        Assert-Color "compare best bar fill ($($shot.theme))" (Get-PixelInfo $bmp ($b.x + $b.w / 2) ($b.y + $b.h / 2)) $t.brand[0] $t.brand[1] $t.brand[2]
        Assert-True "best bar does not overflow track ($($shot.theme))" ($b.w -le $tr.w + 0.5) ("bar={0} track={1}" -f $b.w, $tr.w)
    }

    # drawer open => the page underneath must be dimmed by .drawer-mask rgba(17,24,39,.32);
    # the expected pixel is the bg token blended with that overlay (computed above).
    Assert-Color "page under drawer is masked ($($shot.theme))" (Get-PixelInfo $bmp $PAGE_PROBE[0] $PAGE_PROBE[1]) $t.maskOverBg[0] $t.maskOverBg[1] $t.maskOverBg[2] 4

    $bmp.Dispose()
}

# ---------------------------------------------------------------------------
# 2) failed run (light): the red card must actually be red
# ---------------------------------------------------------------------------
$e = $summary.'error-light'
if ($null -ne $e) {
    $bmp = [System.Drawing.Bitmap]::FromFile($e.png)
    Write-Host ("`n=== error-light  {0} ===" -f (Split-Path $e.png -Leaf))
    $m = $e.anchors.metricBadBar
    $strip = [pscustomobject]@{ x = $m.x; y = $m.y; w = 8; h = $m.h }
    $hit = Find-ColorInRect $bmp $strip 220 38 38
    Assert-True 'metric.bad status bar (light)' ($null -ne $hit) $(if ($hit) { "rgb($($hit.R),$($hit.G),$($hit.B)) at ($($hit.X),$($hit.Y))" } else { 'no --danger pixel inside left 8px strip' })
    $bmp.Dispose()
}

# ---------------------------------------------------------------------------
# 3) compare run (light): best bar must be the brand colour, not the neutral track fill
# ---------------------------------------------------------------------------
$c = $summary.'compare-light'
if ($null -ne $c) {
    $bmp = [System.Drawing.Bitmap]::FromFile($c.png)
    Write-Host ("`n=== compare-light  {0} ===" -f (Split-Path $c.png -Leaf))
    $b = $c.anchors.bestBar
    Assert-Color 'compare best bar (multi-model)' (Get-PixelInfo $bmp ($b.x + $b.w / 2) ($b.y + $b.h / 2)) 14 159 110
    $bmp.Dispose()
}

# ---------------------------------------------------------------------------
# 4) model table: "performance" column badges are painted (not white-on-white)
# ---------------------------------------------------------------------------
$before = $summary.'table-light'
if ($null -ne $before) {
    $bmp = [System.Drawing.Bitmap]::FromFile($before.png)
    Write-Host ("`n=== table-light (before any bench)  {0} ===" -f (Split-Path $before.png -Leaf))
    # drawer closed here => unmasked tokens are directly observable
    Assert-Color 'page bg token (drawer closed)' (Get-PixelInfo $bmp $PAGE_PROBE[0] $PAGE_PROBE[1]) 246 247 249
    Assert-Color 'nav rail panel token' (Get-PixelInfo $bmp $NAV_PROBE[0] $NAV_PROBE[1]) 255 255 255
    $rb = $before.anchors.perfBadge
    if ($null -ne $rb) {
        $hit = Find-ColorInRect $bmp $rb 241 243 245 8
        Assert-True 'untested badge painted with dim token' ($null -ne $hit) $(if ($hit) { "rgb($($hit.R),$($hit.G),$($hit.B)) at ($($hit.X),$($hit.Y))" } else { 'no dim pixel found' })
    }
    $bmp.Dispose()
}

$after = $summary.'table-after'
if ($null -ne $after) {
    $bmp = [System.Drawing.Bitmap]::FromFile($after.png)
    Write-Host ("`n=== table-after (bench history filled in)  {0} ===" -f (Split-Path $after.png -Leaf))
    foreach ($k in @('fastBadge', 'slowBadge')) {
        $rb = $after.anchors.$k
        if ($null -eq $rb) {
            Assert-True ("{0} rect present" -f $k) $false 'rect missing'
            continue
        }
        $hit = Find-ColorInRect $bmp $rb 209 250 229 8
        Assert-True ("{0} painted with ok-weak token" -f $k) ($null -ne $hit) $(if ($hit) { "rgb($($hit.R),$($hit.G),$($hit.B)) at ($($hit.X),$($hit.Y))" } else { 'no ok-weak pixel found' })
    }
    $bmp.Dispose()
}

Write-Host ("`npixel checks: {0}, failed: {1}" -f $checks, $fail)
if ($fail -gt 0) { exit 1 } else { exit 0 }
