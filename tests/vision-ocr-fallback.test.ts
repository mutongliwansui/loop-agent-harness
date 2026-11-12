/**
 * analyzeImage 视觉失败 → 本地 OCR 降级单测（需求 20261112-002 / 任务 03 / D2）
 *
 * 覆盖：判定①（视觉未启用）/ 判定②（调用失败）两条入口、extract 不降级、
 *       原始错误摘要回显、OCR 也失败时两条信息都保留、降级缓存通道隔离、降级计数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import type { AgentConfig } from '../src/config/schema.js';

const state = vi.hoisted(() => ({
  config: null as unknown as AgentConfig,
  chatVision: vi.fn(),
  ocrResult: {
    text: '识别到的文字',
    engine: 'winrt-ocr',
    lang: 'zh-Hans-CN',
    elapsedMs: 50,
    warnings: [] as string[],
  },
  ocrError: null as Error | null,
  ocrCalls: 0,
}));

vi.mock('../src/config/index.js', () => ({
  configLoader: { load: () => ({ config: state.config, sources: {} }) },
}));

vi.mock('../src/llm/client.js', () => ({
  llm: { chatVision: (...a: unknown[]) => state.chatVision(...a) },
}));

vi.mock('../src/ocr/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ocr/index.js')>();
  return {
    ...actual,
    runOcrOnSource: async () => {
      state.ocrCalls++;
      if (state.ocrError) throw state.ocrError;
      return state.ocrResult;
    },
  };
});

const { analyzeImage } = await import('../src/tools/vision/tools.js');
const { summarizeVisionError, composeFallbackError } = await import(
  '../src/tools/vision/ocr-fallback.js'
);
const { visionCache } = await import('../src/tools/vision/cache.js');
const { visionStats } = await import('../src/tools/vision/stats.js');

let dir = '';
let imgPath = '';

function baseConfig(over: {
  visionEnabled?: boolean;
  ocrEnabled?: boolean;
  fallbackFromVision?: boolean;
} = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    vision: { ...DEFAULT_CONFIG.vision, enabled: over.visionEnabled ?? true },
    ocr: {
      ...DEFAULT_CONFIG.ocr,
      enabled: over.ocrEnabled ?? true,
      fallbackFromVision: over.fallbackFromVision ?? true,
    },
  } as AgentConfig;
}

beforeEach(async () => {
  visionCache.clear();
  visionStats.reset();
  state.config = baseConfig();
  state.chatVision.mockReset();
  state.chatVision.mockRejectedValue(new Error('Connection error: HTTP 401 invalid api key'));
  state.ocrError = null;
  state.ocrCalls = 0;

  if (dir) await rm(dir, { recursive: true, force: true });
  dir = await mkdtemp(join(tmpdir(), 'vision-fallback-'));
  imgPath = join(dir, 'shot.png');
  await writeFile(
    imgPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16, 1),
    ]),
  );
});

// ── 一、判定②：chatVision 抛错即降级 ──────────────────────────────────

describe('D2 判定②：视觉调用失败 → 本地 OCR', () => {
  it('降级成功时返回带标注的 OCR 文本，且不抛错', async () => {
    const out = (await analyzeImage.execute({ image: imgPath })) as string;
    expect(out).toContain('[视觉不可用：Connection error: HTTP 401 invalid api key；已降级为本地 OCR（winrt-ocr）]');
    expect(out).toContain('识别到的文字');
    expect(out).toContain('说明：本地 OCR 只提供图片中的文字');
  });

  it('标注里保留原始视觉错误摘要（不静默降级）', async () => {
    const out = (await analyzeImage.execute({ image: imgPath })) as string;
    expect(out.split('\n')[0]).toContain('401');
  });

  it('视觉失败仍计入 errors 统计，降级单独计数', async () => {
    await analyzeImage.execute({ image: imgPath });
    const snap = visionStats.snapshot();
    expect(snap.errors).toBe(1);
    expect(snap.ocrFallbacks).toBe(1);
    expect(snap.calls).toBe(0);
  });

  it('ask 分支同样降级，question 参与降级缓存 key', async () => {
    const a = (await analyzeImage.execute({ image: imgPath, question: '报错码是多少' })) as string;
    expect(a).toContain('识别到的文字');
    await analyzeImage.execute({ image: imgPath, question: '换个问题' });
    // 不同 question → 不同 key，OCR 被调用两次
    expect(state.ocrCalls).toBe(2);
  });

  it('同一图同一问题第二次降级命中缓存，不重复跑 OCR', async () => {
    await analyzeImage.execute({ image: imgPath, question: '看文字' });
    await analyzeImage.execute({ image: imgPath, question: '看文字' });
    expect(state.ocrCalls).toBe(1);
    expect(visionStats.snapshot().ocrFallbacks).toBe(2); // 两次都记降级（含缓存命中）
  });

  it('fallbackFromVision=false 时不降级，原样抛视觉错误', async () => {
    state.config = baseConfig({ fallbackFromVision: false });
    await expect(analyzeImage.execute({ image: imgPath })).rejects.toThrow('401');
    expect(state.ocrCalls).toBe(0);
  });

  it('OCR 也失败时抛错并同时保留视觉错误与 OCR 原因', async () => {
    state.ocrError = new Error('不支持的图片格式');
    const err = await analyzeImage.execute({ image: imgPath }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).toContain('本地 OCR 降级也失败');
    expect((err as Error).message).toContain('不支持的图片格式');
  });
});

// ── 二、extract 分支不降级 ─────────────────────────────────────────────

describe('D2 例外：extract 分支不降级', () => {
  it('extract 失败时抛错并提示改用 ocrImage', async () => {
    const err = await analyzeImage
      .execute({ image: imgPath, fields: ['金额', '日期'] })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).toContain('extract 分支不降级');
    expect((err as Error).message).toContain('ocrImage');
    expect(state.ocrCalls).toBe(0); // 根本没去跑 OCR
  });

  it('extract 成功时不受降级逻辑影响', async () => {
    state.chatVision.mockResolvedValue({
      content: '{"金额":"100"}',
      usage: {},
      elapsedMs: 10,
    });
    const out = (await analyzeImage.execute({ image: imgPath, fields: ['金额'] })) as string;
    expect(out).toContain('"金额": "100"');
  });
});

// ── 三、判定①：视觉未启用 ─────────────────────────────────────────────

describe('D2 判定①：vision.enabled=false 直接走 OCR', () => {
  it('返回降级结果且不调用视觉模型', async () => {
    state.config = baseConfig({ visionEnabled: false });
    const out = (await analyzeImage.execute({ image: imgPath })) as string;
    expect(out).toContain('视觉功能未启用（vision.enabled=false）');
    expect(out).toContain('识别到的文字');
    expect(state.chatVision).not.toHaveBeenCalled();
  });

  it('OCR 也未启用时抛出两者信息', async () => {
    state.config = baseConfig({ visionEnabled: false, ocrEnabled: false });
    const err = await analyzeImage.execute({ image: imgPath }).catch((e: Error) => e);
    expect((err as Error).message).toContain('视觉功能未启用');
    expect((err as Error).message).toContain('ocr.enabled=false');
  });

  it('视觉未启用 + extract：报错并指向 ocrImage', async () => {
    state.config = baseConfig({ visionEnabled: false });
    const err = await analyzeImage
      .execute({ image: imgPath, fields: ['金额'] })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('ocrImage');
  });
});

// ── 四、缓存通道隔离 ───────────────────────────────────────────────────

describe('缓存通道隔离', () => {
  it('同图同分支下 vision 与 ocr 通道 key 不同', () => {
    const v = visionCache.buildKey('m', 'ask', ['q'], 'img');
    const o = visionCache.buildKey('m', 'ask', ['q'], 'img', 'ocr');
    expect(v).not.toBe(o);
  });

  it('视觉通道已有缓存时不会污染降级结果', async () => {
    const vKey = visionCache.buildKey('local-ocr', 'ask', ['q'], 'img', 'vision');
    visionCache.set(vKey, '视觉通道的旧结果', 60000);
    state.config = baseConfig({ visionEnabled: false });
    const out = (await analyzeImage.execute({ image: imgPath, question: 'q' })) as string;
    expect(out).not.toContain('视觉通道的旧结果');
    expect(out).toContain('识别到的文字');
  });

  it('ocr.cacheEnabled=false 时降级不写缓存', async () => {
    state.config = { ...baseConfig(), ocr: { ...DEFAULT_CONFIG.ocr, enabled: true, cacheEnabled: false } };
    await analyzeImage.execute({ image: imgPath, question: 'cache-off' });
    await analyzeImage.execute({ image: imgPath, question: 'cache-off' });
    expect(state.ocrCalls).toBe(2);
  });
});

// ── 五、辅助函数 ───────────────────────────────────────────────────────

describe('summarizeVisionError', () => {
  it('取首个非空行', () => {
    expect(summarizeVisionError(new Error('\n\n第一行错误\n第二行'))).toBe('第一行错误');
  });

  it('超长截断到 160 字符', () => {
    const long = 'x'.repeat(400);
    const s = summarizeVisionError(new Error(long));
    expect(s.length).toBe(161);
    expect(s.endsWith('…')).toBe(true);
  });

  it('空错误与非 Error 值也能给出可读摘要', () => {
    expect(summarizeVisionError(new Error('   '))).toBe('未知错误');
    expect(summarizeVisionError('字符串错误')).toBe('字符串错误');
  });
});

describe('composeFallbackError', () => {
  it('视觉错误在首位，OCR 信息在括号内补充', () => {
    const msg = composeFallbackError(new Error('视觉炸了'), { status: 'failed', reason: 'OCR 炸了' });
    expect(msg).toBe('视觉炸了\n（本地 OCR 降级也失败：OCR 炸了）');
  });

  it('视觉未启用时使用配置指引文案', () => {
    const msg = composeFallbackError(null, { status: 'unavailable', reason: '本地 OCR 未启用' }, {
      visionDisabled: true,
    });
    expect(msg).toContain('/config set vision.enabled true');
    expect(msg).toContain('本地 OCR 未启用');
  });
});
