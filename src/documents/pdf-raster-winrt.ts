// PDF 扫描页内建光栅化（需求 20261112-004 / 任务 01 / D1）
//
// 为什么用 Windows.Data.Pdf：Windows 自带一个完整的 PDF 渲染器（Edge / PDF 阅读器同款），
// 经 WinRT 投影即可从 powershell.exe 调用，**零新增 npm 依赖**、不动 package.json 的 engines、
// SEA 单文件打包无影响。备选 @hyzyla/pdfium 3.0 虽然跨平台且快 110ms，但要求 Node ≥22
// （本项目 engines 为 >=20.10）且需额外处理 5~7MB wasm 资源，故本次不引入（演进项）。
//
// 五个已踩实的坑（改动本文件前务必先读）：
//   1. `PdfPage.Size` 的单位是 **DIP（96/英寸）**，不是 PDF 的 pt（72/英寸）。
//      按 `/72*DPI` 换算会多渲 1.33 倍（实测 1646×2346 vs 正确的 1235×1760，PNG 1.57MB vs 944KB）。
//   2. `PdfPage` **没有 `Close()`**，只能 `Dispose()`；直接调 Close() 抛 MethodNotFound 并中断脚本。
//   3. `RenderToStreamAsync` 返回 `IAsyncAction`（无结果），泛型 `AsTask<T>` 无法套用它——
//      必须从 `System.WindowsRuntimeSystemExtensions` 反射取**非泛型** `AsTask(IAsyncAction)` 重载；
//      在 PS 5.1 里轮询 `.Status` 会一直是空值。
//   4. WinRT 类型必须用**程序集限定名**经 `[type]::GetType(..., $true)` 预热，否则 PS 5.1 的类型
//      解析器解析 `[Windows.Data.Pdf.PdfDocument]` 这类字面量时不稳定。
//   5. 脚本必须**纯 ASCII 无 BOM**：目标机（内网 Windows 10，GBK 代码页）会按本地码页解读含中文的
//      .ps1。脚本内所有路径一律 `-LiteralPath`，避免中文/空格路径的通配展开风险。

import { stat } from 'node:fs/promises';
import {
  ensureScriptFile,
  firstFailLine,
  powershellLikelyAvailable,
  runPowerShell,
} from '../util/powershell.js';

/** 默认渲染 DPI（150 对 OCR 足够；再高只放大耗时与体积） */
export const WINRT_PDF_DPI = 150;
/** 默认单页渲染超时（毫秒） */
export const WINRT_PDF_TIMEOUT_MS = 15_000;
/** 进程启动 + WinRT 投影初始化的固定开销余量 */
const PS_STARTUP_ALLOWANCE_MS = 8_000;

/**
 * 内建渲染脚本（**纯 ASCII**，单测会断言这一点）。
 *
 * 退出码契约（Node 侧据此区分「引擎不可用」与「这一页坏了」，见 D8）：
 *   0 = PNG 已写到 -Out
 *   2 = 引擎级不可用（非 Desktop 宿主 / 缺 WindowsRuntime 程序集 / 缺 AsTask 重载 / WinRT 类型加载失败）
 *   3 = 页级失败（PDF 打不开 / 页码越界 / 渲染抛错 / 写文件失败）
 *
 * 失败时向 stdout 打一行 `[FAIL] <code> :: <message>`（ASCII），供 Node 侧原样透出根因。
 */
export const WINRT_PDF_PS1 = `# Windows.Data.Pdf based PDF page rasterizer (built-in WinRT renderer).
# Exit codes: 0 = PNG written, 2 = renderer unavailable, 3 = page-level failure.
# This script is pure ASCII on purpose: target machines use the GBK code page.
param(
    [Parameter(Mandatory=$true)][string]$Pdf,
    [Parameter(Mandatory=$true)][int]$Page,
    [Parameter(Mandatory=$true)][string]$Out,
    [double]$Dpi = 150
)

$ErrorActionPreference = 'Stop'

function FailEngine([string]$Code, [string]$Message) {
    Write-Output ('[FAIL] ' + $Code + ' :: ' + $Message)
    exit 2
}

function FailPage([string]$Code, [string]$Message) {
    Write-Output ('[FAIL] ' + $Code + ' :: ' + $Message)
    exit 3
}

# Gate 1: the WinRT projection only resolves from Windows PowerShell 5.1 (Desktop).
if ([string]$PSVersionTable.PSEdition -ne 'Desktop') {
    FailEngine 'wrong_host' 'WinRT projection requires Windows PowerShell 5.1 (powershell.exe).'
}

# Gate 2: a missing/unreadable PDF is a page-level problem, not a missing engine.
if ([string]::IsNullOrWhiteSpace($Pdf)) { FailPage 'pdf_missing' 'Pdf is required.' }
if (-not (Test-Path -LiteralPath $Pdf)) { FailPage 'pdf_missing' 'PDF not found.' }
$Pdf = (Resolve-Path -LiteralPath $Pdf).Path

# Gate 3: AsTask reflection bridge. IAsyncOperation<T> needs the generic overload while
# IAsyncAction needs the NON-generic one; using the wrong one silently never completes.
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
} catch {
    FailEngine 'no_winrt_runtime' ('System.Runtime.WindowsRuntime not loadable: ' + $_.Exception.Message)
}

$script:AsTaskGeneric = $null
$script:AsTaskAction = $null
foreach ($m in [System.WindowsRuntimeSystemExtensions].GetMethods()) {
    if ($m.Name -ne 'AsTask') { continue }
    if ($m.GetParameters().Count -ne 1) { continue }
    $pt = $m.GetParameters()[0].ParameterType.Name
    if ($pt -like 'IAsyncOperation*' -and $pt -notlike '*WithProgress*') {
        if ($null -eq $script:AsTaskGeneric) { $script:AsTaskGeneric = $m }
    } elseif ($pt -eq 'IAsyncAction') {
        if ($null -eq $script:AsTaskAction) { $script:AsTaskAction = $m }
    }
}
if ($null -eq $script:AsTaskGeneric) { FailEngine 'no_astask_generic' 'AsTask(IAsyncOperation<T>) not found.' }
if ($null -eq $script:AsTaskAction) { FailEngine 'no_astask_action' 'AsTask(IAsyncAction) not found.' }

function Unwrap-Fault($Task) {
    $msgs = @()
    foreach ($ie in $Task.Exception.Flatten().InnerExceptions) {
        if ($null -ne $ie -and $ie.Message -ne '') { $msgs = $msgs + $ie.Message }
    }
    if ($msgs.Count -eq 0) { return 'async operation failed' }
    return ($msgs -join ' | ')
}

function Await-Result($Operation, [Type]$ResultType) {
    if ($null -eq $Operation) { throw 'null async operation' }
    $task = $script:AsTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    # Wait() throws AggregateException on a faulted task; with $ErrorActionPreference='Stop'
    # that aborts the script before the inner WinRT message can be surfaced. Swallow it.
    $completed = $true
    try { $completed = $task.Wait(60000) } catch { $completed = $true }
    if (-not $completed) { throw 'async operation timeout' }
    if ($task.IsFaulted) { throw (Unwrap-Fault $task) }
    return $task.Result
}

function Await-Action($Operation) {
    if ($null -eq $Operation) { throw 'null async action' }
    $task = $script:AsTaskAction.Invoke($null, @($Operation))
    $completed = $true
    try { $completed = $task.Wait(60000) } catch { $completed = $true }
    if (-not $completed) { throw 'async operation timeout' }
    if ($task.IsFaulted) { throw (Unwrap-Fault $task) }
}

# Gate 4: preload WinRT projections with assembly-qualified names (PS 5.1 requirement).
$typeNames = @(
    'Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime',
    'Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime',
    'Windows.Data.Pdf.PdfPage, Windows.Data.Pdf, ContentType=WindowsRuntime',
    'Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType=WindowsRuntime',
    'Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime',
    'Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime'
)
foreach ($tn in $typeNames) {
    try {
        $null = [type]::GetType($tn, $true)
    } catch {
        FailEngine 'types_unavailable' ('Cannot load WinRT type: ' + $tn + ' :: ' + $_.Exception.Message)
    }
}

# Load the document (page-level failure on error: encrypted/corrupt PDFs land here).
try {
    $sf = Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Pdf)) ([Windows.Storage.StorageFile])
    $doc = Await-Result ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($sf)) ([Windows.Data.Pdf.PdfDocument])
} catch {
    FailPage 'load_failed' ('Cannot open PDF: ' + $_.Exception.Message)
}

$pageCount = [int]$doc.PageCount
if ($Page -lt 1 -or $Page -gt $pageCount) {
    FailPage 'page_out_of_range' ('page ' + [string]$Page + ' outside 1..' + [string]$pageCount)
}

try {
    $pg = $doc.GetPage([uint32]($Page - 1))
} catch {
    FailPage 'page_failed' ('GetPage failed: ' + $_.Exception.Message)
}

# PdfPage.Size is in DIPs (96 per inch), NOT points (72 per inch). Dividing by 72 renders
# 1.33x too large (measured: 1646x2346 instead of 1235x1760, PNG 1.57MB instead of 944KB).
$size = $pg.Size
$opts = [Windows.Data.Pdf.PdfPageRenderOptions]::new()
$opts.DestinationWidth = [uint32][math]::Round([double]$size.Width / 96.0 * $Dpi)
$opts.DestinationHeight = [uint32][math]::Round([double]$size.Height / 96.0 * $Dpi)

$errCode = ''
$errMsg = ''
$stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
$reader = $null
try {
    try {
        Await-Action ($pg.RenderToStreamAsync($stream, $opts))
    } catch {
        $errCode = 'render_failed'
        $errMsg = 'RenderToStreamAsync failed: ' + $_.Exception.Message
    }

    if ($errCode -eq '') {
        $len = [int]$stream.Size
        if ($len -le 0) {
            $errCode = 'render_empty'
            $errMsg = 'Renderer produced an empty stream.'
        } else {
            try {
                $stream.Seek(0)
                $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
                Await-Result ($reader.LoadAsync([uint32]$len)) ([uint32]) | Out-Null
                $bytes = New-Object 'byte[]' $len
                $reader.ReadBytes($bytes)
                [System.IO.File]::WriteAllBytes($Out, $bytes)
            } catch {
                $errCode = 'write_failed'
                $errMsg = 'Cannot write PNG: ' + $_.Exception.Message
            }
        }
    }
} finally {
    if ($null -ne $reader) { $reader.Dispose() }
    # PdfPage exposes no Close(); only dispose when it implements IDisposable.
    if ($pg -is [System.IDisposable]) { $pg.Dispose() }
    $stream.Dispose()
}

if ($errCode -ne '') { FailPage $errCode $errMsg }

Write-Output ('OK_BYTES=' + [string](Get-Item -LiteralPath $Out).Length)
exit 0
`;

/** 同步可用性判断：Windows 且 powershell.exe 存在（不 spawn，不验证组件齐全） */
export function winrtPdfLikelyAvailable(): boolean {
  return powershellLikelyAvailable();
}

export interface WinrtRasterRequest {
  /** 源 PDF 绝对路径（脚本内用 -LiteralPath，中文/空格安全） */
  input: string;
  /** 页码，1-based */
  page: number;
  /** 输出 PNG 路径（调用方在 mkdtemp 目录内指定） */
  output: string;
  /** 目标 DPI，默认 150 */
  dpi?: number;
  /** 单页超时（毫秒），默认 15000 */
  timeoutMs?: number;
}

export interface WinrtRasterOutcome {
  ok: boolean;
  /** true = 引擎级不可用（应回落外部工具）；false = 页级失败 */
  engineUnavailable: boolean;
  /** 失败原因（ok=false 时给可读文案，含脚本回传的错误码） */
  error?: string;
  /** 脚本退出码（诊断用；spawn 失败时为 null） */
  exitCode: number | null;
  /** 耗时（毫秒，含进程启动） */
  elapsedMs: number;
}

/** 把 `[FAIL] code :: message` 整理成一句可读中文前缀文案 */
function asError(prefix: string, detail: string | null, code: string): string {
  const tail = detail ? `：${detail}` : '';
  return `${prefix}（退出码 ${code}）${tail}`;
}

/**
 * 用内建 WinRT 渲染器把单页渲成 PNG。
 *
 * 永不抛错：所有失败都以 `ok=false` + `engineUnavailable` 返回，由调用方决定回落还是记告警。
 */
export async function renderPdfPageWinrt(req: WinrtRasterRequest): Promise<WinrtRasterOutcome> {
  const started = Date.now();
  if (!winrtPdfLikelyAvailable()) {
    return {
      ok: false,
      engineUnavailable: true,
      error: '内建 PDF 渲染不可用（非 Windows 平台或未找到 powershell.exe）',
      exitCode: null,
      elapsedMs: 0,
    };
  }

  const dpi = req.dpi ?? WINRT_PDF_DPI;
  const timeoutMs = req.timeoutMs ?? WINRT_PDF_TIMEOUT_MS;
  let script: string;
  try {
    script = await ensureScriptFile(WINRT_PDF_PS1, 'winrt-pdf');
  } catch (e) {
    return {
      ok: false,
      engineUnavailable: true,
      error: `内建 PDF 渲染脚本落盘失败：${e instanceof Error ? e.message : String(e)}`,
      exitCode: null,
      elapsedMs: Date.now() - started,
    };
  }

  const run = await runPowerShell(
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Pdf',
      req.input,
      '-Page',
      String(req.page),
      '-Out',
      req.output,
      '-Dpi',
      String(dpi),
    ],
    timeoutMs + PS_STARTUP_ALLOWANCE_MS,
  );
  const elapsedMs = Date.now() - started;

  if (run.spawnError) {
    return {
      ok: false,
      engineUnavailable: true,
      error: `无法启动 powershell.exe：${run.spawnError}`,
      exitCode: null,
      elapsedMs,
    };
  }
  if (run.timedOut) {
    return {
      ok: false,
      // 超时是「这一页渲不出来」，不是「这台机器没有这个能力」——不该触发整体回落
      engineUnavailable: false,
      error: `内建渲染器超时（>${Math.round(timeoutMs / 1000)}s）`,
      exitCode: run.code,
      elapsedMs,
    };
  }

  if (run.code === 0) {
    let bytes = 0;
    try {
      bytes = (await stat(req.output)).size;
    } catch {
      bytes = 0;
    }
    if (bytes <= 0) {
      return {
        ok: false,
        engineUnavailable: false,
        error: '内建渲染器未产出输出文件',
        exitCode: 0,
        elapsedMs,
      };
    }
    return { ok: true, engineUnavailable: false, exitCode: 0, elapsedMs };
  }

  const detail = firstFailLine(run.stdout, run.stderr);
  const code = run.code === null ? 'unknown' : String(run.code);
  if (run.code === 2) {
    return {
      ok: false,
      engineUnavailable: true,
      error: asError('内建 PDF 渲染不可用', detail, code),
      exitCode: run.code,
      elapsedMs,
    };
  }
  return {
    ok: false,
    engineUnavailable: false,
    error: asError('内建渲染器返回失败', detail, code),
    exitCode: run.code,
    elapsedMs,
  };
}
