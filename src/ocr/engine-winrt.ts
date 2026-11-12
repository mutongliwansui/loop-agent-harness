// Windows 原生 OCR 引擎（WinRT，需求 20261112-002 / 任务 01 / D1 定稿）
//
// 为什么走 PowerShell 而不是原生 addon：
//   WinRT 投影只在 Windows PowerShell 5.1（Desktop 版）里可用，Node 没有零依赖的调用途径；
//   起一个 powershell.exe 进程是唯一「零新增 npm 依赖」的方案（D9-A）。
//
// 三个实现约束（踩坑记录）：
//   1. 内网目标机是 Windows 10（PowerShell 5.1），**不能**用 `[Type]::new()` 之外的三元运算符、
//      `??`、`-join` 之外的 PS7 特性；脚本须保持 5.1 兼容。
//   2. 脚本以 ASCII 写入（无 BOM），识别出的中文只走 OutPath 文件回传；
//      走 stdout 会被控制台代码页（内网机 GBK / 本机 936）改写。
//   3. Windows PowerShell 5.1 不支持反引号续行与 `${}` 之外的花括号变量，脚本里两者都不用。
//   4. 不要用 [Windows.Storage.StorageFile]::FromPathAsync 读图：Win11 26100 的 WinRT 投影里
//      没有这个方法（只有 GetFileFromPathAsync），StorageFile 还会在部分路径上被访问策略拦截。
//      统一走「File.ReadAllBytes → MemoryStream → AsRandomAccessStream」，见脚本 decode 段。

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeBase64Text,
  ensureScriptFile,
  parsePsOutput,
  powershellLikelyAvailable,
  powershellPath,
  runPowerShell,
} from '../util/powershell.js';
import {
  formatCropArg,
  IMAGE_EXT_BY_FORMAT,
  OcrError,
  sniffImageFormat,
  type OcrEngine,
  type OcrImageSize,
  type OcrLine,
  type OcrOptions,
  type OcrResult,
  type OcrWord,
} from './types.js';

// 运行时从 util/powershell.js 复用（需求 20261112-004 / D7），对外导出名保持不变，
// 以免影响既有调用方与单测。
export { parsePsOutput, powershellPath, runPowerShell };
export type { PsRunResult } from '../util/powershell.js';

/**
 * 内嵌 PowerShell 5.1 脚本。
 *
 * 输出协议（stdout，逐行 KEY=VALUE，值一律 ASCII）：
 *   MODE / ENGINE / PSEDITION / PSVERSION / LANGS / LANG / MAXDIM /
 *   ELAPSED_MS（仅 RecognizeAsync）/ T_TRANSFORM_MS（缩放裁剪）/ CHARS / LINES / WORDS /
 *   WIDTH / HEIGHT
 *   STATUS=OK|FAIL，FAIL 时附 ERROR_CODE 与 ERROR_MSG_B64（UTF-8 base64，避免代码页问题）
 * 识别文本写入 OutPath（UTF-8 无 BOM，按引擎行以换行连接）；结构化行与词坐标写入
 * OutJsonPath（`{width,height,lines:[{text,words:[{t,x,y,w,h}]}]}`）。
 */
const WINRT_PS1 = `param(
    [string]$Mode = 'probe',
    [string]$ImagePath = '',
    [string]$Language = 'auto',
    [string]$OutPath = '',
    [string]$OutJsonPath = '',
    [int]$Scale = 1,
    [string]$Crop = ''
)

$ErrorActionPreference = 'Stop'

function Emit([string]$Key, [string]$Value) {
    [Console]::Out.WriteLine($Key + '=' + $Value)
}

function Fail([string]$Code, [string]$Message) {
    Emit 'STATUS' 'FAIL'
    Emit 'ERROR_CODE' $Code
    Emit 'ERROR_MSG_B64' ([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Message)))
    exit 2
}

# JSON string escaping for the structure file. Uses char codes so this script stays
# pure ASCII and dodges PS 5.1 backslash quoting pitfalls.
function Escape-Json([string]$s) {
    $bs = [string][char]92
    $q = [string][char]34
    $sb = New-Object System.Text.StringBuilder
    $null = $sb.Append($q)
    if ($null -ne $s) {
        foreach ($ch in $s.ToCharArray()) {
            $code = [int]$ch
            if ($code -eq 34) { $null = $sb.Append($bs + $q) }
            elseif ($code -eq 92) { $null = $sb.Append($bs + $bs) }
            elseif ($code -eq 8) { $null = $sb.Append($bs + 'b') }
            elseif ($code -eq 9) { $null = $sb.Append($bs + 't') }
            elseif ($code -eq 10) { $null = $sb.Append($bs + 'n') }
            elseif ($code -eq 12) { $null = $sb.Append($bs + 'f') }
            elseif ($code -eq 13) { $null = $sb.Append($bs + 'r') }
            elseif ($code -lt 32) { $null = $sb.Append($bs + 'u' + $code.ToString('x4')) }
            else { $null = $sb.Append($ch) }
        }
    }
    $null = $sb.Append($q)
    return $sb.ToString()
}

Emit 'MODE' $Mode
Emit 'ENGINE' 'winrt-ocr'
Emit 'PSEDITION' ([string]$PSVersionTable.PSEdition)
Emit 'PSVERSION' ([string]$PSVersionTable.PSVersion)

# WinRT projection is only available in Windows PowerShell 5.1 (Desktop edition).
# PS7 needs an extra module, so fail fast and let the Node side explain the fallback.
if ([string]$PSVersionTable.PSEdition -ne 'Desktop') {
    Fail 'wrong_host' 'WinRT projection requires Windows PowerShell 5.1 (powershell.exe).'
}

$typeNames = @(
    'Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime',
    'Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime',
    'Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime'
)
foreach ($tn in $typeNames) {
    try {
        $null = [type]::GetType($tn, $true)
    } catch {
        Fail 'types_unavailable' ('Cannot load WinRT type: ' + $tn + ' :: ' + $_.Exception.Message)
    }
}

# AsTask reflection bridge: IAsyncOperation<T> cannot be waited on directly, convert to Task<T>
$script:AsTask = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
    } | Select-Object -First 1)
} catch {
    $script:AsTask = $null
}

function Await-Result($Operation, [Type]$ResultType) {
    if ($null -eq $Operation) { throw 'null async operation' }
    if ($null -ne $script:AsTask) {
        $task = $script:AsTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
        # NOTE: Wait() itself throws AggregateException on a faulted task, and with
        # $ErrorActionPreference='Stop' that would terminate the script before we can
        # unpack the real reason. Swallow Wait() errors and inspect IsFaulted instead.
        $completed = $true
        try { $completed = $task.Wait(60000) } catch { $completed = $true }
        if (-not $completed) { throw 'async operation timeout' }
        if ($task.IsFaulted) {
            # AggregateException.ToString() is just "One or more errors occurred"; Flatten
            # to surface the inner WinRT message (e.g. invalid image format / null pointer).
            $msgs = @()
            foreach ($ie in $task.Exception.Flatten().InnerExceptions) {
                if ($null -ne $ie -and $ie.Message -ne '') { $msgs = $msgs + $ie.Message }
            }
            if ($msgs.Count -eq 0) { throw 'async operation failed' }
            throw ($msgs -join ' | ')
        }
        return $task.Result
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (([string]$Operation.Status) -ne 'Completed') {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'async operation timeout' }
        Start-Sleep -Milliseconds 15
    }
    if (([string]$Operation.Status) -eq 'Error') { throw 'async operation failed' }
    return $Operation.GetResults()
}

try {
    $recognizerLangs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
} catch {
    Fail 'types_unavailable' ('Cannot enumerate OCR languages: ' + $_.Exception.Message)
}

$tags = @()
foreach ($l in $recognizerLangs) { $tags = $tags + [string]$l.LanguageTag }
Emit 'LANGS' ($tags -join ',')
if ($tags.Count -eq 0) {
    Fail 'no_language' 'No OCR recognizer language is installed.'
}

$want = $Language
if ([string]::IsNullOrWhiteSpace($want) -or $want -eq 'auto') {
    $pick = ''
    foreach ($t in $tags) { if ($t -like 'zh-Hans*') { $pick = $t; break } }
    if ($pick -eq '') { foreach ($t in $tags) { if ($t -like 'zh*') { $pick = $t; break } } }
    if ($pick -eq '') { $pick = [string]$tags[0] }
    $want = $pick
}

$engine = $null
try {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($want))
} catch {
    $engine = $null
}
if ($null -eq $engine) {
    try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { $engine = $null }
    if ($null -eq $engine) {
        Fail 'lang_unavailable' ('No OCR engine for language ' + $want + '; available: ' + ($tags -join ','))
    }
    $want = [string]$engine.RecognizerLanguage.LanguageTag
}
Emit 'LANG' $want

$maxDim = 0
try { $maxDim = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension } catch { $maxDim = 0 }
Emit 'MAXDIM' ([string]$maxDim)

if ($Mode -eq 'probe') {
    Emit 'STATUS' 'OK'
    exit 0
}

if ([string]::IsNullOrWhiteSpace($ImagePath)) { Fail 'image_missing' 'ImagePath is required.' }
if (-not (Test-Path -LiteralPath $ImagePath)) { Fail 'image_missing' ('Image not found: ' + $ImagePath) }
if ([string]::IsNullOrWhiteSpace($OutPath)) { Fail 'output_missing' 'OutPath is required.' }

# Do NOT decode via [Windows.Storage.StorageFile]: on Windows 11 26100 the WinRT
# projection exposes GetFileFromPathAsync only (no FromPathAsync), and StorageFile
# also trips file-access policy on network shares / sandboxes.
# Read the bytes ourselves and hand a MemoryStream to the decoder: in-memory only.
try {
    $bytes = [System.IO.File]::ReadAllBytes($ImagePath)
    if ($bytes.Length -eq 0) { Fail 'decode_failed' 'Cannot decode image: file is empty (0 byte).' }
    $ms = New-Object System.IO.MemoryStream
    $ms.Write($bytes, 0, $bytes.Length)
    $ms.Position = 0
    $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
    $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
} catch {
    Fail 'decode_failed' ('Cannot decode image: ' + $_.Exception.Message)
}

# Optional pre-processing: crop a region and/or upscale small text.
# Do NOT use WinRT BitmapTransform here (measured on Windows 11 26100): the projection
# only exposes GetSoftwareBitmapAsync(), (pixelFormat, alphaMode) and
# (pixelFormat, alphaMode, transform, exif, colorManagement) - the transform-only
# overload is missing, and when Bounds is set the ScaledWidth/ScaledHeight pair is
# silently ignored (crop+scale returned the crop size). GetPixelDataAsync honours both
# but needs a 38 MB+ managed buffer plus an AsBuffer bridge.
# So the pixel work is done by GDI+ on an in-memory PNG and handed back to WinRT,
# which then uses the plain no-argument GetSoftwareBitmapAsync() overload.
$swTransform = [System.Diagnostics.Stopwatch]::StartNew()
$imgW = [int]$decoder.PixelWidth
$imgH = [int]$decoder.PixelHeight
$bx = 0
$by = 0
$bw = $imgW
$bh = $imgH
$hasCrop = $false
if (-not [string]::IsNullOrWhiteSpace($Crop)) {
    $parts = $Crop.Split(',')
    if ($parts.Count -ne 4) { Fail 'bad_input' 'Crop must be 4 comma separated integers: x,y,w,h.' }
    $bx = [int]$parts[0]
    $by = [int]$parts[1]
    $bw = [int]$parts[2]
    $bh = [int]$parts[3]
    if ($bx -lt 0 -or $by -lt 0) { Fail 'bad_input' 'Crop x/y must be >= 0.' }
    if ($bw -le 0 -or $bh -le 0) { Fail 'bad_input' 'Crop w/h must be > 0.' }
    if (($bx + $bw) -gt $imgW) { Fail 'bad_input' ('Crop x+w exceeds image width ' + [string]$imgW + '.') }
    if (($by + $bh) -gt $imgH) { Fail 'bad_input' ('Crop y+h exceeds image height ' + [string]$imgH + '.') }
    $hasCrop = $true
}
$scale = [int]$Scale
if ($scale -lt 1) { $scale = 1 }
$outW = $bw * $scale
$outH = $bh * $scale
if ($maxDim -gt 0 -and (($outW -gt $maxDim) -or ($outH -gt $maxDim))) {
    Fail 'image_too_large' ('Target size ' + [string]$outW + 'x' + [string]$outH + ' exceeds OCR limit ' + [string]$maxDim + '; lower scale or crop a smaller region.')
}

try {
    if (($scale -ne 1) -or $hasCrop) {
        Add-Type -AssemblyName System.Drawing
        $srcMs = New-Object System.IO.MemoryStream
        $srcMs.Write($bytes, 0, $bytes.Length)
        $srcMs.Position = 0
        $srcImg = [System.Drawing.Image]::FromStream($srcMs)
        try {
            $dst = New-Object System.Drawing.Bitmap($outW, $outH)
            $g = [System.Drawing.Graphics]::FromImage($dst)
            # HighQualityBicubic belongs to System.Drawing.Drawing2D; WinRT's
            # BitmapInterpolationMode only has NearestNeighbor/Linear/Cubic/Fant
            # (measured: passing the wrong enum resolves to $null and throws).
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $dstRect = New-Object System.Drawing.Rectangle(0, 0, $outW, $outH)
            $srcRect = New-Object System.Drawing.Rectangle($bx, $by, $bw, $bh)
            # One DrawImage does crop and scale together (source rect -> dest rect).
            $g.DrawImage($srcImg, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
            $g.Dispose()
            # PNG keeps it lossless and small (2x full page ~1.2MB vs 38MB for BMP);
            # the stream is then decoded again from memory (measured 2x page: ~340ms).
            $scaledMs = New-Object System.IO.MemoryStream
            $dst.Save($scaledMs, [System.Drawing.Imaging.ImageFormat]::Png)
            $dst.Dispose()
            $scaledMs.Position = 0
            $ras2 = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($scaledMs)
            $decoder2 = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras2)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Await-Result ($decoder2.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        } finally {
            $srcImg.Dispose()
        }
    } else {
        $bitmap = Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    }
} catch {
    Fail 'decode_failed' ('Cannot decode image: ' + $_.Exception.Message)
}
$swTransform.Stop()

$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $result = Await-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
} catch {
    Fail 'recognize_failed' ('OCR failed: ' + $_.Exception.Message)
}
$sw.Stop()

# Keep the plain text file for compatibility, but join the engine's own lines with
# newlines instead of dropping them: Result.Text uses SPACES to join lines and carries
# zero control characters (measured), which made every line-based post-processing rule
# a no-op. Falling back to Text only when the engine reports no lines at all.
$lineTexts = @()
$wordTotal = 0
foreach ($ln in $result.Lines) {
    $lineTexts = $lineTexts + [string]$ln.Text
    $wordTotal = $wordTotal + @($ln.Words).Count
}
$text = $lineTexts -join [string][char]10
if ($lineTexts.Count -eq 0) { $text = [string]$result.Text }
$enc = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($OutPath, $text, $enc)

# Structure file: lines + word bounding boxes. Written by hand because PS 5.1
# ConvertTo-Json degrades single element arrays into scalars.
if (-not [string]::IsNullOrWhiteSpace($OutJsonPath)) {
    $json = New-Object System.Text.StringBuilder
    $null = $json.Append('{"width":' + [string]$outW + ',"height":' + [string]$outH + ',"lines":[')
    $li = 0
    foreach ($ln in $result.Lines) {
        if ($li -gt 0) { $null = $json.Append(',') }
        $null = $json.Append('{"text":' + (Escape-Json ([string]$ln.Text)) + ',"words":[')
        $wi = 0
        foreach ($wd in $ln.Words) {
            if ($wi -gt 0) { $null = $json.Append(',') }
            $r = $wd.BoundingRect
            $rx = ([string]([int][Math]::Round([double]$r.X)))
            $ry = ([string]([int][Math]::Round([double]$r.Y)))
            $rw = ([string]([int][Math]::Round([double]$r.Width)))
            $rh = ([string]([int][Math]::Round([double]$r.Height)))
            $null = $json.Append('{"t":' + (Escape-Json ([string]$wd.Text)) + ',"x":' + $rx + ',"y":' + $ry + ',"w":' + $rw + ',"h":' + $rh + '}')
            $wi = $wi + 1
        }
        $null = $json.Append(']}')
        $li = $li + 1
    }
    $null = $json.Append(']}')
    [System.IO.File]::WriteAllText($OutJsonPath, $json.ToString(), $enc)
}

Emit 'ELAPSED_MS' ([string]$sw.ElapsedMilliseconds)
Emit 'T_TRANSFORM_MS' ([string]$swTransform.ElapsedMilliseconds)
Emit 'CHARS' ([string]$text.Length)
Emit 'LINES' ([string]@($result.Lines).Count)
Emit 'WORDS' ([string]$wordTotal)
Emit 'WIDTH' ([string]$outW)
Emit 'HEIGHT' ([string]$outH)
Emit 'STATUS' 'OK'
exit 0
`;

/** 探测结果（进程内缓存：powershell 启动约 0.7s，不能每次工具调用都探） */
export interface WinrtProbe {
  ok: boolean;
  /** 可用语言标签列表 */
  langs: string[];
  /** 引擎实际选定语言（'auto' 解析后） */
  lang: string | null;
  /** 引擎允许的最大边长（像素），0 表示未知 */
  maxDim: number;
  /** 失败时的脚本错误码 */
  errorCode: string | null;
  /** 失败时的详细说明（英文，来自脚本） */
  errorDetail: string | null;
  /** 探测耗时 */
  elapsedMs: number;
}

/**
 * 同步零成本可用性判断（不 spawn）。
 * CLI 启动阶段用它决定要不要注册 ocrImage 工具，避免每次启动多 0.7s。
 */
export function winrtOcrLikelyAvailable(): boolean {
  return powershellLikelyAvailable();
}

/**
 * OCR 脚本落盘路径（进程内只写一次，由 util/powershell.js 按内容哈希缓存）。
 * 为什么不用 stdin（`-Command -`）：stdin 需要管道喂入，且 Windows PowerShell 5.1 从管道读脚本
 * 容易与控制台代码页/编码纠缠；写临时 .ps1 后 `-File` 调用最稳，脚本内容全 ASCII 无 BOM。
 */
function resolveScript(): Promise<string> {
  return ensureScriptFile(WINRT_PS1, 'winrt-ocr');
}

/** 脚本错误码 → 面向用户的中文说明（设计方案 §7 错误文案） */
export function explainWinrtError(code: string | null, detail: string | null, langs: string[]): string {
  const tail = detail ? `（${detail}）` : '';
  switch (code) {
    case 'wrong_host':
      return '本地 OCR 需要 Windows PowerShell 5.1（powershell.exe），当前宿主程序不可用；可设置 LOOP_AGENT_POWERSHELL 指向系统 powershell.exe' + tail;
    case 'types_unavailable':
      return '未找到 Windows OCR 组件（WinRT 类型加载失败），请确认系统为 Windows 10/11 且未裁剪 WinRT 组件' + tail;
    case 'no_language':
      return (
        '本机未安装任何 OCR 语言包，本地 OCR 不可用。安装方式（管理员 PowerShell）：' +
        'Add-WindowsCapability -Online -Name "Language.OCR~~~en-US~0.0.1.0"；' +
        '中文需同时在「设置 → 时间和语言 → 语言」添加中文语言包并勾选「光学字符识别」'
      );
    case 'lang_unavailable':
      return `请求的 OCR 语言不可用，本机可用语言：${langs.length > 0 ? langs.join('、') : '（无）'}` + tail;
    case 'image_too_large':
      return '图片尺寸超过 Windows OCR 允许的最大边长，请先缩小图片' + tail;
    case 'decode_failed':
      return '图片无法被 Windows OCR 解码（可能格式不受支持或文件损坏）' + tail;
    case 'image_missing':
      return '图片文件不存在或不可读' + tail;
    case 'recognize_failed':
      return 'Windows OCR 识别失败' + tail;
    default:
      return 'Windows OCR 调用失败' + tail;
  }
}

let probeCache: Promise<WinrtProbe> | null = null;

/** 探测本机 WinRT OCR 可用性（结果在进程内缓存；失败也缓存，避免反复起进程） */
export function probeWinrt(): Promise<WinrtProbe> {
  probeCache ??= (async (): Promise<WinrtProbe> => {
    const started = Date.now();
    if (process.platform !== 'win32') {
      return {
        ok: false,
        langs: [],
        lang: null,
        maxDim: 0,
        errorCode: 'wrong_platform',
        errorDetail: `platform is ${process.platform}`,
        elapsedMs: 0,
      };
    }
    const script = await resolveScript();
    const run = await runPowerShell(
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', 'probe'],
      20000,
    );
    const elapsedMs = Date.now() - started;
    if (run.spawnError) {
      return {
        ok: false,
        langs: [],
        lang: null,
        maxDim: 0,
        errorCode: 'wrong_host',
        errorDetail: run.spawnError,
        elapsedMs,
      };
    }
    if (run.timedOut) {
      return { ok: false, langs: [], lang: null, maxDim: 0, errorCode: 'timeout', errorDetail: 'probe timed out', elapsedMs };
    }
    const kv = parsePsOutput(run.stdout);
    const langs = (kv.LANGS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (kv.STATUS === 'OK' && langs.length > 0) {
      return {
        ok: true,
        langs,
        lang: kv.LANG ?? null,
        maxDim: Number(kv.MAXDIM ?? '0') || 0,
        errorCode: null,
        errorDetail: null,
        elapsedMs,
      };
    }
    return {
      ok: false,
      langs,
      lang: kv.LANG ?? null,
      maxDim: 0,
      errorCode: kv.ERROR_CODE ?? (kv.STATUS === 'OK' ? 'no_language' : 'engine_failed'),
      errorDetail: decodeBase64Text(kv.ERROR_MSG_B64) ?? (run.stderr.trim() || null),
      elapsedMs,
    };
  })();
  return probeCache;
}

/** 清空探测缓存（单测与「设置页改了语言包」后的手动刷新用） */
export function resetWinrtProbeCache(): void {
  probeCache = null;
}

/** 脚本 out.json 的原始形态（字段全部可选：解析失败即视为无结构数据） */
interface ScriptJson {
  width?: number;
  height?: number;
  lines?: Array<{
    text?: string;
    words?: Array<{ t?: string; x?: number; y?: number; w?: number; h?: number }>;
  }>;
}

/** 把脚本 out.json 规整为引擎结构；任何异常一律返回 null（由调用方回落纯文本） */
export function parseScriptJson(raw: string): { lines: OcrLine[]; imageSize: OcrImageSize } | null {
  let parsed: ScriptJson;
  try {
    parsed = JSON.parse(raw) as ScriptJson;
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.lines)) return null;
  const lines: OcrLine[] = [];
  for (const line of parsed.lines) {
    if (!line || !Array.isArray(line.words)) continue;
    const words: OcrWord[] = [];
    for (const word of line.words) {
      if (!word || typeof word.t !== 'string') continue;
      const x = Number(word.x);
      const y = Number(word.y);
      const w = Number(word.w);
      const h = Number(word.h);
      if (![x, y, w, h].every((n) => Number.isFinite(n))) continue;
      words.push({ t: word.t, x, y, w, h });
    }
    lines.push({ text: typeof line.text === 'string' ? line.text : words.map((w) => w.t).join(' '), words });
  }
  const width = Number(parsed.width);
  const height = Number(parsed.height);
  return {
    lines,
    imageSize: Number.isFinite(width) && Number.isFinite(height) ? { width, height } : { width: 0, height: 0 },
  };
}

/** 把脚本执行错误映射为 OcrError（按错误码区分可纠正性） */
function toOcrError(kv: Record<string, string>, langs: string[], stderr: string): OcrError {
  const code = kv.ERROR_CODE ?? 'engine_failed';
  const detail = decodeBase64Text(kv.ERROR_MSG_B64) ?? (stderr.trim() || null);
  const message = explainWinrtError(code, detail, langs);
  switch (code) {
    case 'image_too_large':
      return new OcrError('image_too_large', message);
    case 'lang_unavailable':
      return new OcrError('lang_unsupported', message);
    case 'decode_failed':
      return new OcrError('unsupported_format', message);
    case 'image_missing':
      return new OcrError('bad_input', message);
    default:
      return new OcrError('engine_failed', message);
  }
}

/** Windows WinRT OCR 引擎（唯一正式引擎；其他平台为演进项） */
class WinrtOcrEngine implements OcrEngine {
  readonly id = 'winrt-ocr';
  private lastProbe: WinrtProbe | null = null;

  get langs(): string[] {
    return this.lastProbe?.langs ?? [];
  }

  async isAvailable(): Promise<boolean> {
    if (!winrtOcrLikelyAvailable()) return false;
    const probe = await probeWinrt();
    this.lastProbe = probe;
    return probe.ok;
  }

  async recognize(image: Buffer, opts: OcrOptions = {}): Promise<OcrResult> {
    const probe = await probeWinrt();
    this.lastProbe = probe;
    if (process.platform !== 'win32') {
      throw new OcrError('platform_unsupported', '当前平台不支持 Windows 原生 OCR（macOS/Linux 引擎为演进项）');
    }
    if (!probe.ok) {
      throw new OcrError('engine_missing', explainWinrtError(probe.errorCode, probe.errorDetail, probe.langs));
    }

    const format = sniffImageFormat(image);
    if (!format) {
      throw new OcrError('unsupported_format', '不支持的图片格式（支持 png / jpeg / bmp / gif / webp / tiff）');
    }

    const wantLang = opts.lang && opts.lang !== 'auto' ? opts.lang : (probe.lang ?? 'auto');
    if (wantLang !== 'auto' && probe.langs.length > 0) {
      const matched = probe.langs.some((t) => t.toLowerCase() === wantLang.toLowerCase());
      if (!matched) {
        throw new OcrError(
          'lang_unsupported',
          `请求的 OCR 语言 ${wantLang} 不可用，本机可用语言：${probe.langs.join('、')}`,
        );
      }
    }

    const timeoutMs = Math.max(1000, opts.timeoutMs ?? 20000);
    const dir = await mkdtemp(join(tmpdir(), 'loop-ocr-'));
    const imagePath = join(dir, `input${IMAGE_EXT_BY_FORMAT[format]}`);
    const outPath = join(dir, 'out.txt');
    const outJsonPath = join(dir, 'out.json');
    const scale = Math.min(4, Math.max(1, Math.round(opts.scale ?? 1))) || 1;
    const cropArg = formatCropArg(opts.crop);
    try {
      await writeFile(imagePath, image);
      const script = await resolveScript();
      const started = Date.now();
      const run = await runPowerShell(
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-Mode',
          'ocr',
          '-ImagePath',
          imagePath,
          '-Language',
          wantLang,
          '-OutPath',
          outPath,
          '-OutJsonPath',
          outJsonPath,
          '-Scale',
          String(scale),
          '-Crop',
          cropArg,
        ],
        // 进程启动 + 引擎初始化的固定开销，额外给 8s 余量
        timeoutMs + 8000,
      );
      if (run.spawnError) {
        throw new OcrError('engine_failed', `无法启动 powershell.exe：${run.spawnError}`);
      }
      if (run.timedOut) {
        throw new OcrError('timeout', `本地 OCR 超时（>${Math.round(timeoutMs / 1000)}s），请缩小图片或降低 DPI`);
      }
      const kv = parsePsOutput(run.stdout);
      if (kv.STATUS !== 'OK') {
        throw toOcrError(kv, probe.langs, run.stderr);
      }
      let text = '';
      try {
        text = await readFile(outPath, 'utf8');
      } catch {
        text = '';
      }
      // 结构化数据是行还原的前提；解析失败绝不丢结果，回落纯文本并记告警
      const warnings: string[] = [];
      let structured: { lines: OcrLine[]; imageSize: OcrImageSize } | null = null;
      try {
        structured = parseScriptJson(await readFile(outJsonPath, 'utf8'));
      } catch {
        structured = null;
      }
      if (!structured) {
        warnings.push('结构化数据解析失败，已退化为纯文本（行还原能力受限）');
      }
      // D8：端到端耗时（含进程启动、解码、预处理），识别耗时单列，避免「体感 1.1s 显示 0.3s」
      const recognizeMs = Number(kv.ELAPSED_MS ?? '') || 0;
      const elapsedMs = Math.max(Date.now() - started, recognizeMs);
      const transformMs = Number(kv.T_TRANSFORM_MS ?? '') || 0;
      if (transformMs >= 50) {
        warnings.push(`预处理（缩放/裁剪）耗时 ${(transformMs / 1000).toFixed(1)}s`);
      }
      return {
        text,
        engine: this.id,
        lang: kv.LANG ?? wantLang,
        elapsedMs,
        ...(recognizeMs > 0 ? { recognizeMs } : {}),
        warnings,
        ...(structured ? { lines: structured.lines, imageSize: structured.imageSize } : {}),
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export const winrtOcrEngine: OcrEngine = new WinrtOcrEngine();

/** 供单测/诊断引用脚本原文 */
export const WINRT_SCRIPT = WINRT_PS1;

/** 脚本落盘位置（诊断时可直接 `powershell -NoProfile -File <path> -Mode probe`） */
export async function resolveWinrtScriptPath(): Promise<string> {
  return resolveScript();
}
