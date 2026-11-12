// 需求 20261112-004 / 任务 02：文档图片取文「视觉优先 → OCR 兜底」单测
// 覆盖：未启用视觉（纯委托）、视觉成功、视觉失败降级、双失败、超上限、超预算、字符截断、
//       引擎不可用整块降级（D6）、计数矩阵、能力边界文案一致性。

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OcrConfig } from '../src/config/schema.js';
import type { DocumentImage } from '../src/documents/types.js';

const { runOcrMock } = vi.hoisted(() => ({ runOcrMock: vi.fn() }));

vi.mock('../src/ocr/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ocr/index.js')>();
  return { ...actual, runOcr: (...args: unknown[]) => runOcrMock(...args) };
});

const { readDocumentImages, ocrDocumentImages, OCR_CAPABILITY_NOTE } = await import(
  '../src/documents/images.js'
);
const { OcrError } = await import('../src/ocr/types.js');
const { CAPABILITY_NOTE } = await import('../src/tools/vision/ocr-fallback.js');

/** 最小合法 PNG（魔数足够通过 sniffImageFormat） */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function imgs(n: number): DocumentImage[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `word/media/image${i + 1}.png`,
    data: PNG,
    index: i + 1,
    source: 'embedded' as const,
  }));
}

function baseConfig(docPatch: Record<string, unknown> = {}, patch: Partial<OcrConfig> = {}): OcrConfig {
  return {
    enabled: true,
    engine: 'auto',
    enginePriority: ['winrt-ocr'],
    lang: 'auto',
    timeoutMs: 20000,
    maxImageBytes: 10 * 1024 * 1024,
    maxChars: 8000,
    cacheEnabled: false,
    cacheTtlMs: 600000,
    cacheMaxEntries: 64,
    fallbackFromVision: true,
    doc: {
      enabled: true,
      maxImages: 20,
      maxCharsPerImage: 4000,
      timeBudgetMs: 15000,
      pdfScannedPagesOnly: true,
      preferVision: true,
      ...docPatch,
    },
    ...patch,
  } as OcrConfig;
}

function ok(text: string, engine = 'winrt-ocr') {
  return { text, engine, lang: 'zh-Hans-CN', elapsedMs: 10, warnings: [] };
}

/** 视觉成功桩（记录被投喂的 timeoutMs） */
function visionOk(text: string, seen: number[] = []) {
  return async (_img: DocumentImage, timeoutMs: number) => {
    seen.push(timeoutMs);
    return { text, model: 'vision-m1' };
  };
}

let dir = '';
beforeEach(async () => {
  runOcrMock.mockReset();
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'loop-agent-docimg-vision-'));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('能力边界文案', () => {
  it('documents 层与 tools/vision 的说明文案一致（防止两处漂移）', () => {
    expect(OCR_CAPABILITY_NOTE).toBe(CAPABILITY_NOTE);
  });
});

describe('readDocumentImages：未启用视觉（纯委托）', () => {
  it('无 describe 时与 ocrDocumentImages 结果一致（仅补零计数）', async () => {
    runOcrMock.mockResolvedValue(ok('甲'));
    const cfg = baseConfig();
    const images = imgs(1);
    const a = await readDocumentImages(images, cfg);
    const b = await ocrDocumentImages(images, cfg);
    expect(a.text).toBe(b.text);
    expect(a.warnings).toEqual(b.warnings);
    expect(a.ocrDone).toBe(1);
    expect(a.visionDone).toBe(0);
    expect(a.degraded).toBe(0);
  });

  it('preferVision=false 时即使有 describe 也走纯 OCR（不调视觉）', async () => {
    runOcrMock.mockResolvedValue(ok('乙'));
    const describe = vi.fn(visionOk('视觉结果'));
    const out = await readDocumentImages(imgs(1), baseConfig({ preferVision: false }), { describe });
    expect(describe).not.toHaveBeenCalled();
    expect(out.ocrDone).toBe(1);
    expect(out.visionDone).toBe(0);
    expect(out.text).toContain('OCR 文本');
  });

  it('ocr.enabled=false 时不产出任何块', async () => {
    const out = await readDocumentImages(imgs(2), baseConfig({}, { enabled: false }), {
      describe: visionOk('x'),
    });
    expect(out.text).toBe('');
    expect(out.visionDone).toBe(0);
    expect(out.ocrDone).toBe(0);
  });
});

describe('readDocumentImages：视觉成功', () => {
  it('块头为「视觉描述」且完全不调用 runOcr', async () => {
    const out = await readDocumentImages(imgs(2), baseConfig(), { describe: visionOk('评审通过') });
    expect(out.visionDone).toBe(2);
    expect(out.ocrDone).toBe(0);
    expect(out.degraded).toBe(0);
    expect(out.text).toContain('[图片 1（word/media/image1.png）：视觉描述]');
    expect(out.text).toContain('评审通过');
    expect(out.text).toContain('[/图片 2]');
    expect(runOcrMock).not.toHaveBeenCalled();
    expect(out.warnings.join()).toContain('视觉模型 2 张');
  });

  it('按 maxCharsPerImage 截断并标注', async () => {
    const out = await readDocumentImages(imgs(1), baseConfig({ maxCharsPerImage: 5 }), {
      describe: visionOk('一二三四五六七八九十'),
    });
    expect(out.text).toContain('已截断至 5 字符');
  });
});

describe('readDocumentImages：视觉失败 → OCR 降级', () => {
  it('降级块含视觉错误摘要 + 能力边界说明，并计入 degraded', async () => {
    runOcrMock.mockResolvedValue(ok('OCR 兜底文本', 'winrt-ocr'));
    const describe = async () => {
      throw new Error('401 Invalid API key\n第二行细节');
    };
    const out = await readDocumentImages(imgs(1), baseConfig(), { describe });
    expect(out.degraded).toBe(1);
    expect(out.ocrDone).toBe(1);
    expect(out.visionDone).toBe(0);
    expect(out.text).toContain('视觉不可用：401 Invalid API key；已降级为本地 OCR（winrt-ocr）');
    expect(out.text).toContain('OCR 兜底文本');
    expect(out.text).toContain(OCR_CAPABILITY_NOTE);
    expect(out.warnings.join()).toContain('1 张为视觉失败降级');
  });

  it('视觉与 OCR 双双失败：两条原因都进块内', async () => {
    runOcrMock.mockRejectedValue(new OcrError('engine_failed', '识别崩了'));
    const describe = async () => {
      throw new Error('视觉超时（20s）');
    };
    const out = await readDocumentImages(imgs(1), baseConfig(), { describe });
    expect(out.text).toContain('取文失败（视觉：视觉超时（20s）；OCR：engine_failed）：识别崩了');
    expect(out.ocrDone).toBe(0);
    expect(out.skipped).toBe(1);
    expect(out.warnings.join()).toContain('1 张图片取文失败');
  });
});

describe('readDocumentImages：预算与 D6 整块降级', () => {
  it('超过 maxImages 的图只留一行「未取文（超过 … 张上限）」', async () => {
    const out = await readDocumentImages(imgs(3), baseConfig({ maxImages: 2 }), {
      describe: visionOk('x'),
    });
    expect(out.visionDone).toBe(2);
    expect(out.skipped).toBe(1);
    expect(out.text).toContain('未取文（超过单文档 2 张上限）');
    expect(out.warnings.join()).toContain('可用 ocr.doc.maxImages 调整');
  });

  it('总预算覆盖视觉耗时：预算耗尽后不再调用视觉', async () => {
    const describe = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return { text: 'x', model: 'm' };
    });
    const out = await readDocumentImages(imgs(3), baseConfig({ timeBudgetMs: 60 }), { describe });
    expect(describe.mock.calls.length).toBeLessThan(3);
    expect(out.text).toContain('时间预算');
    expect(out.warnings.join()).toContain('可用 ocr.doc.timeBudgetMs 调整');
  });

  it('视觉超时按抛错处理（投喂的 timeoutMs 不超过剩余预算）', async () => {
    const seen: number[] = [];
    const out = await readDocumentImages(imgs(1), baseConfig({ timeBudgetMs: 2000 }), {
      describe: visionOk('x', seen),
    });
    expect(out.visionDone).toBe(1);
    expect(seen[0]).toBeLessThanOrEqual(2000);
    expect(seen[0]).toBeGreaterThanOrEqual(1000);
  });

  it('D6：视觉不可用且 OCR 引擎整体不可用 → 整块降级（不留半截块）', async () => {
    runOcrMock.mockRejectedValue(new OcrError('engine_missing', '无 OCR 引擎'));
    const describe = async () => {
      throw new Error('vision disabled by network');
    };
    const out = await readDocumentImages(imgs(2), baseConfig(), { describe });
    expect(out.text).toBe('');
    expect(out.engineUnavailable).toBe(true);
    expect(out.skipped).toBe(2);
    expect(out.warnings.join()).toContain('文档内图片取文不可用，已跳过 2 张图片');
  });

  it('D6 修复：视觉可用而 OCR 引擎不可用 → 仍产出视觉块（旧版会整块丢弃）', async () => {
    runOcrMock.mockRejectedValue(new OcrError('engine_missing', '无 OCR 引擎'));
    const out = await readDocumentImages(imgs(2), baseConfig(), { describe: visionOk('图文内容') });
    expect(out.visionDone).toBe(2);
    expect(out.text).toContain('视觉描述');
    expect(out.text).toContain('图文内容');
    expect(out.engineUnavailable).toBe(false);
  });
});
