// PDF 扫描页光栅化（需求 20261112-002 / 任务 04，D8）
//
// 用途：PDF 没有文本层（扫描件）时，把页渲染成 PNG 交给 OCR 引擎。
// 安全范式与 external.ts 一致：
// - spawn 参数数组、无 shell、固定参数；自定义模板只做「占位符替换 + 简单分词」；
// - 每页独立超时（到点 kill 进程树）；
// - 输出文件大小上限，超限丢弃；
// - 临时目录每次唯一（mkdtemp），无论成功失败都清理。
//
// 探测顺序：ocr.pdfRasterizer 自定义模板 → pdftoppm → mutool → gs。
// 三者都不存在时返回空数组，由调用方保持原有「扫描件」错误提示（含安装指引）。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 单次光栅化最多处理的页数（防扫描件 500 页 × 每页数 MB 把磁盘/内存打满） */
export const MAX_RASTER_PAGES = 5;
/** 默认渲染 DPI：150 对 OCR 足够（再高只会放大耗时与体积） */
const RASTER_DPI = 150;
/** 单页 PNG 大小上限 */
const MAX_PAGE_IMAGE_BYTES = 12 * 1024 * 1024;
/** 单页渲染超时（毫秒） */
const PAGE_TIMEOUT_MS = 15_000;
/** 探测超时（毫秒） */
const PROBE_TIMEOUT_MS = 2000;

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

/** 内置光栅化工具判定 */
type BuiltinTool = 'pdftoppm' | 'mutool' | 'gs';

/** 探测可用的内置工具，返回 null 表示都没有 */
export function detectPdfRasterizer(): BuiltinTool | null {
  if (commandRuns('pdftoppm', ['-v'])) return 'pdftoppm';
  if (commandRuns('mutool', ['-v'])) return 'mutool';
  if (commandRuns('gs', ['--version'])) return 'gs';
  return null;
}

/** 是否具备光栅化能力（自定义模板非空时视为具备，由实际执行结果决定） */
export function pdfRasterizerAvailable(customTemplate?: string): boolean {
  if (customTemplate && customTemplate.trim()) return true;
  return detectPdfRasterizer() !== null;
}

/** 无可用工具时的安装指引（进错误提示，供用户自助补齐） */
export const RASTERIZER_HINT =
  'PDF 扫描页需要光栅化工具：请安装 poppler（pdftoppm）、MuPDF（mutool）或 Ghostscript（gs），' +
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

/** 内置工具单页命令 */
function buildBuiltinArgs(tool: BuiltinTool, input: string, page: number, output: string): string[] {
  switch (tool) {
    case 'pdftoppm':
      return ['-r', String(RASTER_DPI), '-png', '-f', String(page), '-l', String(page), '-singlefile', input, output];
    case 'mutool':
      return ['draw', '-q', '-r', String(RASTER_DPI), '-o', output, input, String(page)];
    case 'gs':
      return [
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
  /** 取消信号 */
  signal?: AbortSignal;
}

export interface RasterizeResult {
  pages: RasterizedPage[];
  /** 实际使用的工具标识（'pdftoppm' / 'mutool' / 'gs' / 'custom'）；无可用工具时为 null */
  tool: string | null;
  /** 可读告警（工具缺失、单页失败、超限等） */
  warnings: string[];
}

/**
 * 把指定页渲染为 PNG。
 * 单页失败不影响其余页；页数超过 MAX_RASTER_PAGES 时只渲染前 MAX_RASTER_PAGES 页并告警。
 */
export async function rasterizePdfPages(
  absPath: string,
  pages: number[],
  opts: RasterizeOptions = {},
): Promise<RasterizeResult> {
  const warnings: string[] = [];
  const custom = opts.customTemplate?.trim() || '';
  const tool: string | null = custom ? 'custom' : detectPdfRasterizer();
  if (!tool) {
    return { pages: [], tool: null, warnings: [RASTERIZER_HINT] };
  }

  let targets = [...new Set(pages)].filter((p) => Number.isInteger(p) && p >= 1).sort((a, b) => a - b);
  if (targets.length > MAX_RASTER_PAGES) {
    warnings.push(
      `PDF 无文本层页共 ${targets.length} 页，仅渲染前 ${MAX_RASTER_PAGES} 页（扫描件页数上限）`,
    );
    targets = targets.slice(0, MAX_RASTER_PAGES);
  }
  if (targets.length === 0) return { pages: [], tool, warnings };

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
      const args = custom
        ? buildCustomArgs(custom, { input: absPath, page, output })
        : buildBuiltinArgs(tool as BuiltinTool, absPath, page, output);
      const cmd = args.shift() as string;
      const ok = await runCommand(cmd, args, timeoutMs);
      if (!ok) {
        warnings.push(`第 ${page} 页渲染失败（${tool} 返回非零或超时）`);
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

  return { pages: out, tool, warnings };
}
