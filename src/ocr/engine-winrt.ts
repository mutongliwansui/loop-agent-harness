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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IMAGE_EXT_BY_FORMAT,
  OcrError,
  sniffImageFormat,
  type OcrEngine,
  type OcrOptions,
  type OcrResult,
} from './types.js';

/**
 * 内嵌 PowerShell 5.1 脚本。
 *
 * 输出协议（stdout，逐行 KEY=VALUE，值一律 ASCII）：
 *   MODE / ENGINE / PSEDITION / PSVERSION / LANGS / LANG / MAXDIM / ELAPSED_MS / CHARS / LINES
 *   STATUS=OK|FAIL，FAIL 时附 ERROR_CODE 与 ERROR_MSG_B64（UTF-8 base64，避免代码页问题）
 * 识别文本写入 OutPath（UTF-8 无 BOM）。
 */
const WINRT_PS1 = `param(
    [string]$Mode = 'probe',
    [string]$ImagePath = '',
    [string]$Language = 'auto',
    [string]$OutPath = ''
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

Emit 'MODE' $Mode
Emit 'ENGINE' 'winrt-ocr'
Emit 'PSEDITION' ([string]$PSVersionTable.PSEdition)
Emit 'PSVERSION' ([string]$PSVersionTable.PSVersion)

# WinRT 投影只在 Windows PowerShell 5.1（Desktop）可用；PS7 需额外模块，直接判错让 Node 侧回退说明
if ([string]$PSVersionTable.PSEdition -ne 'Desktop') {
    Fail 'wrong_host' 'WinRT projection requires Windows PowerShell 5.1 (powershell.exe).'
}

$typeNames = @(
    'Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime',
    'Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime',
    'Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime',
    'Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime'
)
foreach ($tn in $typeNames) {
    try {
        $null = [type]::GetType($tn, $true)
    } catch {
        Fail 'types_unavailable' ('Cannot load WinRT type: ' + $tn + ' :: ' + $_.Exception.Message)
    }
}

# AsTask 反射桥：IAsyncOperation<T> 无法直接 Wait，需转成 Task<T>
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
        if (-not $task.Wait(60000)) { throw 'async operation timeout' }
        if ($task.IsFaulted) { throw $task.Exception.GetBaseException().Message }
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

try {
    $file = Await-Result ([Windows.Storage.StorageFile]::FromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream = Await-Result ($file.OpenAsync(0)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
} catch {
    Fail 'decode_failed' ('Cannot decode image: ' + $_.Exception.Message)
}

if ($maxDim -gt 0 -and (($decoder.PixelWidth -gt $maxDim) -or ($decoder.PixelHeight -gt $maxDim))) {
    Fail 'image_too_large' ('Image dimension exceeds OCR limit ' + [string]$maxDim + '.')
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $result = Await-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
} catch {
    Fail 'recognize_failed' ('OCR failed: ' + $_.Exception.Message)
}
$sw.Stop()

$text = [string]$result.Text
$text = $text.Replace([string][char]13, '')
$enc = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($OutPath, $text, $enc)

Emit 'ELAPSED_MS' ([string]$sw.ElapsedMilliseconds)
Emit 'CHARS' ([string]$text.Length)
Emit 'LINES' ([string]@($result.Lines).Count)
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

interface PsRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
}

/** powershell.exe 路径：优先环境变量覆盖（单测/特殊部署），否则取系统目录 */
export function powershellPath(): string {
  const override = process.env.LOOP_AGENT_POWERSHELL;
  if (override && override.trim()) return override.trim();
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * 同步零成本可用性判断（不 spawn）。
 * CLI 启动阶段用它决定要不要注册 ocrImage 工具，避免每次启动多 0.7s。
 */
export function winrtOcrLikelyAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  return existsSync(powershellPath());
}

/**
 * 脚本落盘路径（进程内只写一次）。
 * 为什么不用 stdin（`-Command -`）：stdin 需要管道喂入，且 Windows PowerShell 5.1 从管道读脚本
 * 容易与控制台代码页/编码纠缠；写临时 .ps1 后 `-File` 调用最稳，脚本内容全 ASCII 无 BOM。
 */
let scriptFilePromise: Promise<string> | null = null;

function ensureScriptFile(): Promise<string> {
  scriptFilePromise ??= (async () => {
    const dir = join(tmpdir(), 'loop-agent-ocr-script');
    await mkdir(dir, { recursive: true });
    const stamp = createHash('sha1').update(WINRT_PS1).digest('hex').slice(0, 12);
    const file = join(dir, `winrt-ocr-${stamp}.ps1`);
    if (!existsSync(file)) {
      await writeFile(file, WINRT_PS1, 'utf8');
    }
    return file;
  })();
  return scriptFilePromise;
}

function runPowerShell(args: string[], timeoutMs: number): Promise<PsRunResult> {  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const child = spawn(powershellPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 进程可能已退出 */
      }
    }, Math.max(1000, timeoutMs));

    child.stdout?.on('data', (chunk: Buffer) => {
      // 输出协议很小（状态行），超过 64KB 视为异常直接丢弃尾部
      if (stdoutBytes < 64 * 1024) {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < 8 * 1024) {
        stderr.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        timedOut,
        spawnError,
      });
    };

    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });
}

/** 解析脚本的 KEY=VALUE 输出 */
export function parsePsOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Z_]+$/.test(key)) continue;
    out[key] = line.slice(idx + 1).trim();
  }
  return out;
}

function decodeBase64Text(b64: string | undefined): string | null {
  if (!b64) return null;
  try {
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
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
    const script = await ensureScriptFile();
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
    try {
      await writeFile(imagePath, image);
      const script = await ensureScriptFile();
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
      const elapsedMs = Number(kv.ELAPSED_MS ?? '') || Date.now() - started;
      return {
        text,
        engine: this.id,
        lang: kv.LANG ?? wantLang,
        elapsedMs,
        warnings: [],
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
  return ensureScriptFile();
}
