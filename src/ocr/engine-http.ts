// 可选 HTTP OCR 端点引擎（需求 20261112-002 / P2）
//
// 用途：内网已有 OCR 服务（PaddleOCR / 通用识别网关）时无需改代码即可接入，
// 也覆盖「非 Windows 平台想用 OCR」的过渡需求（macOS/Linux 原生引擎属演进项）。
//
// 契约（与 schema.OcrHttpConfig 对齐）：
//   请求 POST endpoint，JSON { image: <base64>, lang: <lang> }，
//   配了 apiKey 则带 Authorization: Bearer <apiKey>；
//   响应 JSON 的 fieldName 字段（默认 text）取文本，也兼容 data.text / 纯文本响应。

import type { OcrHttpConfig } from '../config/schema.js';
import { OcrError, type OcrEngine, type OcrOptions, type OcrResult } from './types.js';

/** 在响应对象里按字段名取文本，兼容 data 包装 */
export function pickOcrTextField(payload: unknown, fieldName: string): string {
  const dig = (node: unknown, depth: number): string => {
    if (depth > 3 || !node || typeof node !== 'object') return '';
    const rec = node as Record<string, unknown>;
    const direct = rec[fieldName] ?? rec.text ?? rec.result;
    if (typeof direct === 'string') return direct;
    if (Array.isArray(direct)) {
      // 有些服务返回按行/按块的数组
      return direct.filter((v): v is string => typeof v === 'string').join('\n');
    }
    return dig(rec.data, depth + 1);
  };
  return dig(payload, 0);
}

/** 解析端点响应：JSON 取字段，非 JSON 按纯文本 */
export function parseHttpOcrResponse(body: string, fieldName = 'text'): { text: string; lang?: string; confidence?: number } {
  const trimmed = body.trim();
  if (!trimmed) return { text: '' };
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { text: trimmed };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const lang = typeof parsed.lang === 'string' ? parsed.lang : undefined;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : undefined;
    return { text: pickOcrTextField(parsed, fieldName), lang, confidence };
  } catch {
    // JSON 解析失败按纯文本返回，避免整条链路失败
    return { text: trimmed };
  }
}

class HttpOcrEngine implements OcrEngine {
  readonly id = 'http';
  private currentConfig: OcrHttpConfig | null = null;

  /** 由 run-ocr 在选中该引擎前注入当次生效配置 */
  configure(config: OcrHttpConfig | null): void {
    this.currentConfig = config && config.endpoint.trim() ? config : null;
  }

  get langs(): string[] {
    return [];
  }

  async isAvailable(): Promise<boolean> {
    return this.currentConfig !== null;
  }

  async recognize(image: Buffer, opts: OcrOptions = {}): Promise<OcrResult> {
    const config = this.currentConfig;
    if (!config) {
      throw new OcrError('engine_missing', '未配置 OCR HTTP 端点（ocr.http.endpoint 为空）');
    }
    const lang = opts.lang && opts.lang !== 'auto' ? opts.lang : 'auto';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.apiKey.trim()) headers.authorization = `Bearer ${config.apiKey.trim()}`;

    const controller = new AbortController();
    const timeoutMs = Math.max(1000, opts.timeoutMs ?? 20000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ image: image.toString('base64'), lang }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new OcrError('engine_failed', `OCR HTTP 端点返回 ${res.status} ${res.statusText}`);
      }
      const body = await res.text();
      const parsed = parseHttpOcrResponse(body, config.fieldName || 'text');
      return {
        text: parsed.text,
        engine: this.id,
        lang: parsed.lang ?? lang,
        elapsedMs: Date.now() - started,
        confidence: parsed.confidence,
        warnings: [],
      };
    } catch (err) {
      if (err instanceof OcrError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new OcrError('timeout', `OCR HTTP 端点超时（>${Math.round(timeoutMs / 1000)}s）`);
      }
      throw new OcrError('engine_failed', `OCR HTTP 端点调用失败：${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const httpOcrEngine = new HttpOcrEngine();
