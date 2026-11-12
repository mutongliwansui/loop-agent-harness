// OCR 编排层（需求 20261112-002 / 任务 01）
//
// 调用方只有三个（任务 02/03/04），它们都只依赖这里的 runOcr / runOcrOnSource：
//   - ocrImage 工具        → runOcrOnSource(source)
//   - analyzeImage 降级    → runOcr(buffer) + buildOcrResultText()
//   - fileRead 文档图片    → runOcr(buffer)（由 doc-images.ts 批量调度）
//
// 这一层负责：配置读取 → 引擎选择（auto/显式）→ 大小与格式校验 → 缓存 → 结果后处理与截断。
// 引擎内部只负责「拿文本」，不关心缓存与截断策略。

import { readFile, stat } from 'node:fs/promises';
import { configLoader } from '../config/index.js';
import type { OcrConfig } from '../config/schema.js';
import { ocrCache } from './cache.js';
import { httpOcrEngine } from './engine-http.js';
import { probeWinrt, winrtOcrEngine } from './engine-winrt.js';
import { describeImageSize, renderLayout } from './layout.js';
import { postProcessOcrText } from './postprocess.js';
import {
  formatCropArg,
  OcrError,
  sniffImageFormat,
  type OcrEngine,
  type OcrImageSize,
  type OcrLayout,
  type OcrLine,
  type OcrOptions,
  type OcrResult,
} from './types.js';

export interface RunOcrOptions extends OcrOptions {
  /** 注入配置（单测用，跳过 configLoader） */
  config?: OcrConfig;
  /** 跳过缓存 */
  noCache?: boolean;
}

/** 可选版面形态（工具参数校验与配置默认值共用） */
export const OCR_LAYOUTS: readonly OcrLayout[] = ['text', 'table', 'words'];

/** 归一化 layout：非法值回落给定默认（配置默认 'text'，见 D2） */
export function normalizeLayout(value: unknown, fallback: OcrLayout = 'text'): OcrLayout {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (OCR_LAYOUTS as readonly string[]).includes(v) ? (v as OcrLayout) : fallback;
}

/** 归一化 scale：整数 1–4，越界钳制（放大收益非单调，见 D6） */
export function normalizeScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(1, Math.round(n)));
}

/** 归一化 crop：必须是 [x,y,w,h] 且 w/h 为正，否则视为整图 */
export function normalizeCrop(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const nums = value.map((v) => Number(v));
  if (!nums.every((n) => Number.isFinite(n))) return undefined;
  const [x, y, w, h] = nums.map((n) => Math.round(n)) as [number, number, number, number];
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return undefined;
  return [x, y, w, h];
}

/** 读取 OCR 配置（未显式注入则读当前生效配置，支持热更新） */
export function resolveOcrConfig(override?: OcrConfig): OcrConfig {
  if (override) return override;
  const { config } = configLoader.load();
  return config.ocr;
}

/** 引擎按 id 取实例；返回 null 表示该引擎在本机不可配置（如 http 未填端点） */
function engineById(id: string): OcrEngine | null {
  if (id === 'winrt-ocr') return winrtOcrEngine;
  if (id === 'http') return httpOcrEngine;
  return null;
}

/** auto 模式的探测顺序：显式配置优先，配置了 http 端点时自动追加 http 兜底 */
export function resolveEngineOrder(cfg: OcrConfig): string[] {
  const explicit = (cfg.engine ?? 'auto').trim();
  if (explicit && explicit !== 'auto') return [explicit];
  const order = (cfg.enginePriority?.length ? cfg.enginePriority : ['winrt-ocr']).filter(Boolean);
  if (cfg.http?.endpoint?.trim() && !order.includes('http')) order.push('http');
  return order;
}

/** 非 Windows 且未配 http 端点：属演进项，文案要明确说清楚不阻塞其他功能 */
function platformMessage(cfg: OcrConfig, tried: string[]): OcrError {
  const list = tried.length > 0 ? `（已尝试：${tried.join('、')}）` : '';
  if (process.platform !== 'win32') {
    return new OcrError(
      'platform_unsupported',
      `本地 OCR 目前仅支持 Windows（当前平台 ${process.platform}）；` +
        'macOS / Linux 引擎为演进项，可配置 ocr.http.endpoint 接入内网 OCR 服务' +
        list,
    );
  }
  void cfg;
  return new OcrError(
    'engine_missing',
    '本地 OCR 不可用：未探测到可用引擎。Windows 上请安装 OCR 语言包' +
      '（管理员 PowerShell：Add-WindowsCapability -Online -Name "Language.OCR~~~en-US~0.0.1.0"，' +
      '中文需在「设置 → 时间和语言 → 语言」中添加中文语言包并勾选「光学字符识别」）' +
      list,
  );
}

/** 选定引擎：按顺序 isAvailable()，全失败抛 OcrError */
export async function pickOcrEngine(cfg: OcrConfig): Promise<OcrEngine> {
  const order = resolveEngineOrder(cfg);
  const tried: string[] = [];
  for (const id of order) {
    const engine = engineById(id);
    if (!engine) {
      tried.push(`${id}（未知引擎）`);
      continue;
    }
    if (id === 'http') {
      // http 引擎的可用性来自当次配置，不是探测结果
      httpOcrEngine.configure(cfg.http ?? null);
    }
    if (await engine.isAvailable()) return engine;
    tried.push(`${id}（不可用）`);
  }
  throw platformMessage(cfg, tried);
}

/**
 * 结果字符截断（超出部分丢弃并留说明，避免把整页文字塞进上下文）。
 *
 * 按**整行**截断：把一行切成两半会让模型看到残句（D7）。若第一行本身就超限
 * （极窄上限，如 maxChars=3），退化为字符截断——不能因为一行都放不下就返回空。
 */
export function truncateOcrText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; droppedLines?: number } {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return { text, truncated: false };
  if (text.length <= maxChars) return { text, truncated: false };
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const add = (kept.length > 0 ? 1 : 0) + line.length;
    if (used + add > maxChars) break;
    kept.push(line);
    used += add;
  }
  if (kept.length === 0) {
    // 首行即超限：只能切字，否则会返回空串
    return withDropped({ text: text.slice(0, maxChars), truncated: true }, Math.max(0, lines.length - 1));
  }
  return withDropped({ text: kept.join('\n'), truncated: true }, lines.length - kept.length);
}

/** droppedLines 为 0 时不输出该字段（保持简单结果的形状稳定） */
function withDropped(
  base: { text: string; truncated: boolean },
  droppedLines: number,
): { text: string; truncated: boolean; droppedLines?: number } {
  return droppedLines > 0 ? { ...base, droppedLines } : base;
}

/** 缓存快照：引擎**原始**输出（未渲染），使同一张图切 layout 不必重跑 OCR（D9） */
interface OcrSnapshot {
  text: string;
  engine: string;
  lang: string;
  elapsedMs: number;
  /** 纯识别耗时；与 elapsedMs 之差为进程与解码开销（D8） */
  recognizeMs?: number;
  warnings: string[];
  lines?: OcrLine[];
  imageSize?: OcrImageSize;
}

function parseSnapshot(raw: string): OcrSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as OcrSnapshot;
    if (!parsed || typeof parsed.text !== 'string' || typeof parsed.engine !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 快照 → 最终结果：版面渲染 → 后处理 → 按行截断。
 * 缓存命中与直算走同一条路径，保证两者逐字节一致（D10 幂等）。
 */
function finalizeOcr(
  snapshot: OcrSnapshot,
  opts: { layout: OcrLayout; cached: boolean; maxChars: number },
): OcrResult {
  const warnings = [...snapshot.warnings];
  if (opts.cached) warnings.push('缓存命中');

  const lines = snapshot.lines;
  const hasLines = Array.isArray(lines) && lines.length > 0;
  let body = snapshot.text;
  let applied: OcrLayout = 'text';
  let lineCount: number | undefined;
  let wordCount: number | undefined;

  if (hasLines) {
    const rendered = renderLayout(lines, opts.layout);
    body = rendered.text;
    applied = rendered.applied;
    lineCount = rendered.lineCount;
    wordCount = rendered.wordCount;
    // 回落说明只记一条，避免同一件事重复两遍
    if (rendered.warning) warnings.push(rendered.warning);
  } else if (opts.layout !== 'text') {
    warnings.push('当前引擎不提供坐标，已按纯文本输出');
  }

  // words 是几何数据（TSV），不能被 CJK 合并/空白收敛改写；其余形态统一后处理
  const skipPost = hasLines && applied === 'words';
  const processed = skipPost ? body : postProcessOcrText(body);
  const clipped = truncateOcrText(processed, opts.maxChars);
  if (clipped.truncated) {
    warnings.push(
      clipped.droppedLines && clipped.droppedLines > 0
        ? `识别结果已截断至 ${opts.maxChars} 字符（丢弃 ${clipped.droppedLines} 行）`
        : `识别结果已截断至 ${opts.maxChars} 字符`,
    );
  }
  if (!clipped.text.trim()) {
    warnings.push('未识别到文字（图片可能不含文本或分辨率过低）');
  }

  const result: OcrResult = {
    text: clipped.text,
    engine: snapshot.engine,
    lang: snapshot.lang,
    elapsedMs: opts.cached ? 0 : snapshot.elapsedMs,
    warnings,
    layout: applied,
  };
  if (!opts.cached && snapshot.recognizeMs !== undefined) result.recognizeMs = snapshot.recognizeMs;
  if (hasLines) {
    result.lines = lines;
    result.lineCount = lineCount;
    result.wordCount = wordCount;
  }
  if (snapshot.imageSize) result.imageSize = snapshot.imageSize;
  return result;
}

/** 对内存中的图片字节做 OCR */
export async function runOcr(image: Buffer, opts: RunOcrOptions = {}): Promise<OcrResult> {
  const cfg = resolveOcrConfig(opts.config);
  if (!cfg.enabled) {
    throw new OcrError('engine_missing', '本地 OCR 已在配置中关闭（ocr.enabled=false）');
  }
  if (image.length === 0) {
    throw new OcrError('bad_input', '图片内容为空');
  }
  if (cfg.maxImageBytes > 0 && image.length > cfg.maxImageBytes) {
    throw new OcrError(
      'image_too_large',
      `图片大小 ${(image.length / 1024 / 1024).toFixed(2)}MB 超过上限 ${(cfg.maxImageBytes / 1024 / 1024).toFixed(0)}MB，请先压缩`,
    );
  }
  if (!sniffImageFormat(image)) {
    throw new OcrError('unsupported_format', '不支持的图片格式（支持 png / jpeg / bmp / gif / webp / tiff）');
  }

  const engine = await pickOcrEngine(cfg);
  const lang = opts.lang ?? cfg.lang ?? 'auto';
  const layout = normalizeLayout(opts.layout ?? cfg.layout);
  const scale = normalizeScale(opts.scale);
  const crop = normalizeCrop(opts.crop);
  // maxChars 语义（D7）：配置值是**默认值**，调用方可上调，但不得突破硬上限
  const hardLimit = cfg.maxCharsHardLimit > 0 ? cfg.maxCharsHardLimit : 200000;
  const requested =
    typeof opts.maxChars === 'number' && Number.isFinite(opts.maxChars) && opts.maxChars > 0
      ? Math.round(opts.maxChars)
      : cfg.maxChars;
  const maxChars = Math.min(requested, hardLimit);
  const cacheKey = ocrCache.buildKey(engine.id, lang, image, { scale, crop: formatCropArg(crop) });

  let snapshot: OcrSnapshot | null = null;
  let cached = false;
  if (cfg.cacheEnabled && !opts.noCache) {
    const hit = ocrCache.get(cacheKey);
    if (hit !== null) {
      snapshot = parseSnapshot(hit);
      cached = snapshot !== null;
    }
  }

  if (!snapshot) {
    const raw = await engine.recognize(image, {
      lang,
      timeoutMs: opts.timeoutMs ?? cfg.timeoutMs,
      layout,
      scale,
      crop,
    });
    snapshot = {
      text: raw.text,
      engine: engine.id,
      lang: raw.lang || lang,
      elapsedMs: raw.elapsedMs,
      ...(raw.recognizeMs !== undefined ? { recognizeMs: raw.recognizeMs } : {}),
      warnings: [...raw.warnings],
      lines: raw.lines,
      imageSize: raw.imageSize,
    };
    if (cfg.cacheEnabled && !opts.noCache && raw.text.trim()) {
      try {
        ocrCache.set(cacheKey, JSON.stringify(snapshot), cfg.cacheTtlMs, cfg.cacheMaxEntries);
      } catch {
        /* 快照不可序列化时跳过缓存，不影响本次结果 */
      }
    }
  }

  return finalizeOcr(snapshot, { layout, cached, maxChars });
}

/**
 * 对「来源」做 OCR：本地路径 / file:// / dataURI。
 * http(s) URL 明确拒绝（不静默下载，避免 SSRF 与不可控耗时）；该能力列演进项。
 */
export async function runOcrOnSource(source: string, opts: RunOcrOptions = {}): Promise<OcrResult> {
  const cfg = resolveOcrConfig(opts.config);
  const raw = (source ?? '').trim();
  if (!raw) {
    throw new OcrError('bad_input', '图片参数不能为空');
  }
  if (/^data:image\//i.test(raw)) {
    const comma = raw.indexOf(',');
    if (comma < 0) throw new OcrError('bad_input', 'dataURI 格式不正确');
    const meta = raw.slice(0, comma);
    const payload = raw.slice(comma + 1);
    const buf = /;base64/i.test(meta)
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'binary');
    return runOcr(buf, opts);
  }
  if (/^https?:\/\//i.test(raw)) {
    throw new OcrError(
      'bad_input',
      'OCR 暂不支持 http(s) 图片地址，请先下载到工作空间（或改用视觉工具 analyzeImage）；远程抓取为演进项',
    );
  }
  const filePath = raw.replace(/^file:\/\/\/?/i, '');
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new OcrError('bad_input', `图片不存在或不可读：${filePath}`);
  }
  if (!info.isFile()) {
    throw new OcrError('bad_input', `不是文件：${filePath}`);
  }
  if (cfg.maxImageBytes > 0 && info.size > cfg.maxImageBytes) {
    throw new OcrError(
      'image_too_large',
      `图片大小 ${(info.size / 1024 / 1024).toFixed(2)}MB 超过上限 ${(cfg.maxImageBytes / 1024 / 1024).toFixed(0)}MB，请先压缩`,
    );
  }
  const buf = await readFile(filePath);
  return runOcr(buf, opts);
}

/**
 * 耗时展示（D8）：端到端耗时为主，进程与解码开销 ≥100ms 时拆开写，
 * 让用户体感（1.1s）与显示（0.3s）不再冲突。
 */
function formatElapsed(result: OcrResult): string {
  const total = (result.elapsedMs / 1000).toFixed(1);
  const rec = result.recognizeMs;
  if (rec === undefined || rec <= 0) return `耗时: ${total}s`;
  const overhead = result.elapsedMs - rec;
  if (overhead < 100) return `耗时: ${total}s`;
  return `耗时: ${total}s（识别 ${(rec / 1000).toFixed(1)}s + 进程与解码 ${(overhead / 1000).toFixed(1)}s）`;
}

/**
 * 结果标注头（D6）：OCR 结果必须显式标明来源通道，避免与视觉模型描述混淆。
 * 形如 `[OCR 引擎: winrt-ocr | 语言: zh-Hans-CN | 布局: text | 行数: 23 | 词数: 120 | 耗时: 1.1s]`，
 * 后接换行与正文。行数/词数只在引擎提供坐标时出现。
 */
export function buildOcrResultText(
  result: OcrResult,
  opts: { cached?: boolean; note?: string } = {},
): string {
  const isCached = opts.cached || result.warnings.includes('缓存命中');
  const parts = [`OCR 引擎: ${result.engine}`, `语言: ${result.lang}`];
  if (result.layout) parts.push(`布局: ${result.layout}`);
  const size = describeImageSize(result.imageSize);
  if (size) parts.push(`尺寸: ${size}`);
  if (result.lineCount !== undefined) parts.push(`行数: ${result.lineCount}`);
  if (result.wordCount !== undefined) parts.push(`词数: ${result.wordCount}`);
  parts.push(isCached ? '耗时: 0s（缓存）' : formatElapsed(result));
  if (result.confidence !== undefined) parts.push(`置信度: ${result.confidence.toFixed(3)}`);
  if (isCached) parts.push('缓存命中');
  if (opts.note) parts.push(opts.note);
  const header = `[${parts.join(' | ')}]`;
  const body = result.text.trim() ? result.text : '（未识别到文字）';
  const tail = result.warnings.filter((w) => w !== '缓存命中').length > 0
    ? `\n\n提示：${result.warnings.filter((w) => w !== '缓存命中').join('；')}`
    : '';
  return `${header}\n${body}${tail}`;
}

/** 探测摘要（设置页「OCR 诊断」与 `ocr` CLI 用） */
export async function describeOcrStatus(cfg?: OcrConfig): Promise<{
  platform: string;
  enabled: boolean;
  engine: string;
  available: boolean;
  langs: string[];
  detail: string;
}> {
  const conf = resolveOcrConfig(cfg);
  if (process.platform !== 'win32') {
    return {
      platform: process.platform,
      enabled: conf.enabled,
      engine: conf.engine,
      available: Boolean(conf.http?.endpoint?.trim()),
      langs: [],
      detail: `本地 OCR 仅支持 Windows（当前 ${process.platform}）；可配置 ocr.http.endpoint 接入内网服务`,
    };
  }
  const probe = await probeWinrt();
  return {
    platform: process.platform,
    enabled: conf.enabled,
    engine: conf.engine,
    available: probe.ok,
    langs: probe.langs,
    detail: probe.ok
      ? `已就绪，识别语言 ${probe.lang ?? 'auto'}`
      : `不可用：${probe.errorCode ?? 'unknown'}`,
  };
}

/** 清空 OCR 缓存（单测与「配置变更」时调用） */
export function clearOcrCache(): void {
  ocrCache.clear();
}
