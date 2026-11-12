// PDF 扫描页光栅化（需求 20261112-002 / 任务 04，D8；需求 20261112-004 / 任务 01 增加内建后端）
//
// 用途：PDF 没有文本层（扫描件）时，把页渲染成 PNG 交给 OCR / 视觉模型。
// 安全范式与 external.ts 一致：
// - spawn 参数数组、无 shell、固定参数；自定义模板只做「占位符替换 + 简单分词」；
// - 每页独立超时（到点 kill 进程树）；
// - 输出文件大小上限，超限丢弃；
// - 临时目录每次唯一（mkdtemp），无论成功失败都清理。
//
// 探测顺序（D2）：ocr.pdfRasterizer 自定义模板 → Windows 内建渲染器（Windows.Data.Pdf）
//   → pdftoppm → mutool → gs。用户显式配置的模板永远优先；内建渲染器零安装、无 PATH 依赖，
//   故排在外部工具之前。全都没有时返回空数组，由调用方保持原有「扫描件」错误提示（含安装指引）。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderPdfPageWinrt,
  winrtPdfLikelyAvailable,
  WINRT_PDF_DPI,
  WINRT_PDF_TIMEOUT_MS,
} from './pdf-raster-winrt.js';
import type { PdfRasterEngine } from '../config/schema.js';

/** 单次光栅化最多处理的页数（防扫描件 500 页 × 每页数 MB 把磁盘/内存打满） */
export const MAX_RASTER_PAGES = 5;
/** 默认渲染 DPI：150 对 OCR 足够（再高只会放大耗时与体积） */
const RASTER_DPI = WINRT_PDF_DPI;
/** 单页 PNG 大小上限 */
const MAX_PAGE_IMAGE_BYTES = 12 * 1024 * 1024;
/** 单页渲染超时（毫秒） */
const PAGE_TIMEOUT_MS = WINRT_PDF_TIMEOUT_MS;
/** 探测超时（毫秒） */
const PROBE_TIMEOUT_MS = 2000;

/** 外部光栅化工具标识 */
type BuiltinTool = 'pdftoppm' | 'mutool' | 'gs';

/** 实际生效的渲染器标识（写进 RasterizeResult.tool，便于日志与诊断区分） */
export type RasterizerId = 'custom' | 'winrt' | BuiltinTool;

/** 渲染引擎策略（ocr.pdfRasterEngine，D6）：类型定义在 config/schema 中，此处转出便于 documents 层引用 */
export type { PdfRasterEngine };

/** 光栅化工具探测结果（进程内缓存；按工具名分别缓存以支持自定义模板切换） */
const probeCache = new Map<string, boolean>();

/** 测试钩子：重置探测缓存 */
export function resetRasterizerProbeCache(): void {
  probeCache.clear();
}

/** 探测某个命令能否启动（与 external.ts 的 pdftotext 探测同款宽松判定） */
function commandRuns(cmd: string, versionArgs: string[]): boolean {
  const cacheKey = `${cmd} ${versionArgs.join(' ')}`;
  const hit = probeCache.get(cacheKey);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    const r = spawnSync(cmd, versionArgs, { timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' });
    // 多数工具 -v/--version 的退出码是非 0，只要能启动即视为可用
    ok = r.error == null;
  } catch {
    ok = false;
  }
  probeCache.set(cacheKey, ok);
  return ok;
}

/**
 * 探测可用的外部工具，返回 null 表示都没有。
 * 内建渲染器不参与本函数（见 winrtRasterizerUsable），保持「只探测外部命令」的原语义。
 */
export function detectPdfRasterizer(): BuiltinTool | null {
  if (commandRuns('pdftoppm', ['-v'])) return 'pdftoppm';
  if (commandRuns('mutool', ['-v'])) return 'mutool';
  if (commandRuns('gs', ['--version'])) return 'gs';
  return null;
}

/**
 * 内建渲染器是否可用（同步、零 spawn：只判断 win32 + powershell.exe 存在）。
 * 结果走同一份 probeCache，resetRasterizerProbeCache() 可一并清空。
 */
function winrtRasterizerUsable(engine: PdfRasterEngine): boolean {
  if (engine === 'external') return false;
  const hit = probeCache.get('winrt');
  if (hit !== undefined) return hit;
  const ok = winrtPdfLikelyAvailable();
  probeCache.set('winrt', ok);
  return ok;
}

/** 选择实际使用的渲染器（D2：自定义模板 → 内建 → 外部工具） */
function selectRasterizer(custom: string, engine: PdfRasterEngine): RasterizerId | null {
  if (custom) return 'custom';
  if (winrtRasterizerUsable(engine)) return 'winrt';
  // 显式要求内建时不再回落外部工具：这是现场排障时「只想走某条路径」的开关
  if (engine === 'winrt') return null;
  return detectPdfRasterizer();
}

/** 是否具备光栅化能力（自定义模板非空时视为具备，由实际执行结果决定） */
export function pdfRasterizerAvailable(
  customTemplate?: string,
  engine: PdfRasterEngine = 'auto',
): boolean {
  if (customTemplate && customTemplate.trim()) return true;
  if (winrtRasterizerUsable(engine)) return true;
  if (engine === 'winrt') return false;
  return detectPdfRasterizer() !== null;
}

/** 无可用工具时的安装指引（进错误提示，供用户自助补齐） */
export const RASTERIZER_HINT =
  'PDF 扫描页需要光栅化能力：Windows 上通常由系统内建 PDF 渲染器提供' +
  '（若被裁剪或已用 ocr.pdfRasterEngine=external 关闭，可安装 poppler（pdftoppm）、' +
  'MuPDF（mutool）或 Ghostscript（gs））；其他平台请安装上述任一工具，' +
  '或在配置 ocr.pdfRasterizer 指定自定义命令模板（占位符 {input} {page} {page0} {output}）';

/** 按空格分词，支持双引号包裹含空格参数（不做 shell 解释） */
export function splitCommandTemplate(template: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of template) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** 自定义模板占位符替换 */
export function buildCustomArgs(
  template: string,
  vars: { input: string; page: number; output: string },
): string[] {
  return splitCommandTemplate(template).map((tok) =>
    tok
      .replace(/\{input\}/g, vars.input)
      .replace(/\{page0\}/g, String(vars.page - 1))
      .replace(/\{page\}/g, String(vars.page))
      .replace(/\{output\}/g, vars.output),
  );
}

/** 内置工具单页命令（首元素固定为命令名，调用方 shift 取用） */
function buildBuiltinArgs(tool: BuiltinTool, input: string, page: number, output: string): string[] {
  switch (tool) {
    case 'pdftoppm':
      return ['pdftoppm', '-r', String(RASTER_DPI), '-png', '-f', String(page), '-l', String(page), '-singlefile', input, output];
    case 'mutool':
      return ['mutool', 'draw', '-q', '-r', String(RASTER_DPI), '-o', output, input, String(page)];
    case 'gs':
      return [
        'gs',
        '-q',
        '-dNOPAUSE',
        '-dBATCH',
        '-dSAFER',
        `-sDEVICE=png16m`,
        `-r${RASTER_DPI}`,
        `-dFirstPage=${page}`,
        `-dLastPage=${page}`,
        `-sOutputFile=${output}`,
        input,
      ];
  }
}

/** 执行单个命令，返回是否成功（失败/超时都返回 false，不抛） */
function runCommand(cmd: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        // 已退出
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    try {
      child = spawn(cmd, args, { stdio: 'ignore' });
    } catch {
      finish(false);
      return;
    }
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/** 光栅化结果：页号 → PNG 字节 */
export interface RasterizedPage {
  page: number;
  data: Buffer;
}

export interface RasterizeOptions {
  /** 每页渲染超时（毫秒） */
  timeoutMs?: number;
  /** 自定义命令模板（ocr.pdfRasterizer） */
  customTemplate?: string;
  /** 渲染引擎策略（ocr.pdfRasterEngine），默认 'auto' */
  engine?: PdfRasterEngine;
  /** 取消信号 */
  signal?: AbortSignal;
}

export interface RasterizeResult {
  pages: RasterizedPage[];
  /**
   * 实际使用的渲染器标识（'custom' / 'winrt' / 'pdftoppm' / 'mutool' / 'gs'）；
   * 无可用工具时为 null。中途回落时报告**最终生效**的那个。
   */
  tool: string | null;
  /** 可读告警（工具缺失、单页失败、超限、回落等） */
  warnings: string[];
}

/** 单页渲染的中间结果（统一内建与外部两条路径的失败语义） */
interface PageRenderOutcome {
  ok: boolean;
  /** true 表示「这台机器没有这个能力」，而非「这一页坏了」 */
  engineUnavailable: boolean;
  error?: string;
}

/** 用指定渲染器渲染一页 */
async function renderOnePage(
  kind: RasterizerId,
  custom: string,
  absPath: string,
  page: number,
  output: string,
  timeoutMs: number,
): Promise<PageRenderOutcome> {
  if (kind === 'winrt') {
    const r = await renderPdfPageWinrt({
      input: absPath,
      page,
      output,
      dpi: RASTER_DPI,
      timeoutMs,
    });
    return { ok: r.ok, engineUnavailable: r.engineUnavailable, error: r.error };
  }
  const args =
    kind === 'custom'
      ? buildCustomArgs(custom, { input: absPath, page, output })
      : buildBuiltinArgs(kind, absPath, page, output);
  const cmd = args.shift() as string;
  const ok = await runCommand(cmd, args, timeoutMs);
  // 外部工具的失败无法区分「缺能力」与「这页坏了」，一律按页级处理（保持既有语义）
  return { ok, engineUnavailable: false, error: ok ? undefined : `${kind} 返回非零或超时` };
}

/**
 * 把指定页渲染为 PNG。
 * 单页失败不影响其余页；页数超过 MAX_RASTER_PAGES 时只渲染前 MAX_RASTER_PAGES 页并告警。
 * 内建渲染器报「引擎不可用」时，auto 模式整体回落到外部工具并重试当前页（D8）。
 */
export async function rasterizePdfPages(
  absPath: string,
  pages: number[],
  opts: RasterizeOptions = {},
): Promise<RasterizeResult> {
  const warnings: string[] = [];
  const custom = opts.customTemplate?.trim() || '';
  const engine = opts.engine ?? 'auto';
  const selected = selectRasterizer(custom, engine);
  if (!selected) {
    return { pages: [], tool: null, warnings: [RASTERIZER_HINT] };
  }
  let kind: RasterizerId = selected;
  // 记录是否已因内建不可用而整体回落（回落只发生一次，避免每页都重试）
  let fellBack = false;

  let targets = [...new Set(pages)].filter((p) => Number.isInteger(p) && p >= 1).sort((a, b) => a - b);
  if (targets.length > MAX_RASTER_PAGES) {
    warnings.push(
      `PDF 无文本层页共 ${targets.length} 页，仅渲染前 ${MAX_RASTER_PAGES} 页（扫描件页数上限）`,
    );
    targets = targets.slice(0, MAX_RASTER_PAGES);
  }
  if (targets.length === 0) return { pages: [], tool: kind, warnings };

  const timeoutMs = opts.timeoutMs ?? PAGE_TIMEOUT_MS;
  const out: RasterizedPage[] = [];
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'loop-agent-raster-'));
    for (const page of targets) {
      if (opts.signal?.aborted) {
        warnings.push('已取消，剩余页面未渲染');
        break;
      }
      const output = join(dir, `page-${page}.png`);
      let r = await renderOnePage(kind, custom, absPath, page, output, timeoutMs);
      if (!r.ok && r.engineUnavailable && kind === 'winrt' && !fellBack && engine === 'auto') {
        const fallback = detectPdfRasterizer();
        if (fallback) {
          const why = r.error ? `：${r.error}` : '';
          warnings.push(`内建 PDF 渲染不可用，已回落到 ${fallback}${why}`);
          kind = fallback;
          fellBack = true;
          r = await renderOnePage(kind, custom, absPath, page, output, timeoutMs);
        }
      }
      if (!r.ok) {
        warnings.push(`第 ${page} 页渲染失败（${kind}：${r.error ?? '未知原因'}）`);
        if (r.engineUnavailable) {
          // 内建不可用且没有外部工具可回落：终止剩余页并给出安装指引
          warnings.push(RASTERIZER_HINT);
          break;
        }
        continue;
      }
      let size: number;
      try {
        size = (await stat(output)).size;
      } catch {
        warnings.push(`第 ${page} 页渲染无输出文件（命令模板可能未使用 {output}）`);
        continue;
      }
      if (size > MAX_PAGE_IMAGE_BYTES) {
        warnings.push(
          `第 ${page} 页渲染图 ${(size / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_PAGE_IMAGE_BYTES / 1024 / 1024}MB 上限，已跳过`,
        );
        continue;
      }
      try {
        out.push({ page, data: await readFile(output) });
      } catch {
        warnings.push(`第 ${page} 页渲染图读取失败`);
      }
    }
  } catch (e) {
    warnings.push(`临时目录创建失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return { pages: out, tool: kind, warnings };
}
