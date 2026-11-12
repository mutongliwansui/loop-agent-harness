/**
 * 视觉缓存与用量统计单测（Task-20261010-001 P1）
 * 覆盖：LRU 淘汰、TTL 过期、key 构造敏感性、用量累计、管道缓存命中/失效
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VisionResultCache, visionCache } from '../src/tools/vision/cache.js';
import { VisionUsageStats, visionStats } from '../src/tools/vision/stats.js';

describe('VisionResultCache 基础行为', () => {
  it('set 后 get 返回原值，size/clear 正确', () => {
    const c = new VisionResultCache();
    expect(c.size()).toBe(0);
    c.set('k1', 'v1', 60000);
    expect(c.get('k1')).toBe('v1');
    expect(c.size()).toBe(1);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get('k1')).toBeNull();
  });

  it('未命中的 key 返回 null', () => {
    const c = new VisionResultCache();
    expect(c.get('missing')).toBeNull();
  });

  it('TTL 过期后返回 null 并清除条目', async () => {
    vi.useFakeTimers();
    try {
      const c = new VisionResultCache();
      c.set('k', 'v', 100);
      expect(c.get('k')).toBe('v');
      vi.advanceTimersByTime(101);
      expect(c.get('k')).toBeNull();
      expect(c.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('LRU 超过 20 条淘汰最旧（未访问的队首）', () => {
    const c = new VisionResultCache();
    for (let i = 0; i < 20; i++) c.set(`k${i}`, `v${i}`, 600000);
    expect(c.size()).toBe(20);
    // 访问 k0 使其变新，k1 成为最旧
    expect(c.get('k0')).toBe('v0');
    c.set('k20', 'v20', 600000);
    expect(c.size()).toBe(20);
    expect(c.get('k1')).toBeNull();
    expect(c.get('k0')).toBe('v0');
    expect(c.get('k20')).toBe('v20');
  });

  it('重复 set 同一 key 刷新值且不超限', () => {
    const c = new VisionResultCache();
    c.set('k', 'a', 600000);
    c.set('k', 'b', 600000);
    expect(c.size()).toBe(1);
    expect(c.get('k')).toBe('b');
  });

  it('buildKey：同输入同 key，模型/种类/参数/图片任一变化即换 key', () => {
    const c = new VisionResultCache();
    const base = c.buildKey('m', 'describe', [], 'fp');
    expect(base).toBe(c.buildKey('m', 'describe', [], 'fp'));
    expect(base).not.toBe(c.buildKey('m2', 'describe', [], 'fp'));
    expect(base).not.toBe(c.buildKey('m', 'ask', [], 'fp'));
    expect(base).not.toBe(c.buildKey('m', 'describe', ['q'], 'fp'));
    expect(base).not.toBe(c.buildKey('m', 'describe', [], 'fp2'));
  });
});

describe('VisionUsageStats 会话累计', () => {
  it('recordSuccess 累加调用次数、tokens 与耗时（无 usage 时补 0）', () => {
    const s = new VisionUsageStats();
    s.recordSuccess({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, 50);
    s.recordSuccess(undefined, 30);
    expect(s.snapshot()).toMatchObject({
      calls: 2,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      elapsedMs: 80,
    });
  });

  it('recordCacheHit / recordError / recordOcrFallback 单独计数，reset 清零', () => {
    const s = new VisionUsageStats();
    s.recordSuccess({ total_tokens: 10 }, 5);
    s.recordCacheHit();
    s.recordCacheHit();
    s.recordError();
    s.recordOcrFallback();
    s.recordDocImageDescribe();
    let snap = s.snapshot();
    expect(snap).toMatchObject({
      calls: 1,
      cacheHits: 2,
      errors: 1,
      ocrFallbacks: 1,
      docImageDescribes: 1,
    });
    s.reset();
    snap = s.snapshot();
    expect(snap).toEqual({
      calls: 0, cacheHits: 0, errors: 0, ocrFallbacks: 0, docImageDescribes: 0,
      promptTokens: 0, completionTokens: 0, totalTokens: 0, elapsedMs: 0,
    });
  });

  it('snapshot 返回副本，外部修改不影响内部状态', () => {
    const s = new VisionUsageStats();
    s.recordCacheHit();
    s.snapshot().calls = 99;
    expect(s.snapshot().calls).toBe(0);
  });
});

// ---------- 管道缓存集成（mock llm 与 config） ----------

const { chatVisionMock } = vi.hoisted(() => ({ chatVisionMock: vi.fn() }));
vi.mock('../src/llm/client.js', () => ({ llm: { chatVision: chatVisionMock } }));

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));
vi.mock('../src/config/index.js', () => ({ configLoader: { load: loadMock } }));

import { analyzeImage } from '../src/tools/vision/tools.js';
import type { VisionConfig, AgentConfig } from '../src/config/schema.js';

function vision(overrides: Partial<VisionConfig> = {}): VisionConfig {
  return {
    enabled: true,
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0,
    maxTokens: 2048,
    timeoutMs: 60000,
    maxImageBytes: 10 * 1024 * 1024,
    maxResultChars: 8000,
    cacheEnabled: true,
    cacheTtlMs: 600000,
    ...overrides,
  };
}

function mockConfig(v: VisionConfig): void {
  loadMock.mockReturnValue({
    config: {
      model: { name: 'main-model', baseUrl: 'https://main.example.com', apiKey: 'main-key' },
      vision: v,
      // 缓存命中路径会经 debug.log 读取 agent.debug
      agent: { debug: false },
    } as unknown as AgentConfig,
  });
}

const IMG_URL = 'https://example.com/pic.png';

describe('管道缓存集成', () => {
  beforeEach(() => {
    chatVisionMock.mockReset();
    loadMock.mockReset();
    visionCache.clear();
    visionStats.reset();
  });

  it('同图同参数第二次调用命中缓存：只实调一次、输出一致、命中计数', async () => {
    mockConfig(vision());
    chatVisionMock.mockResolvedValue({ content: '一只猫', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, elapsedMs: 7 });

    const first = await analyzeImage.execute({ image: IMG_URL });
    const second = await analyzeImage.execute({ image: IMG_URL });

    expect(second).toBe(first);
    expect(chatVisionMock).toHaveBeenCalledTimes(1);
    const stats = visionStats.snapshot();
    expect(stats.calls).toBe(1);
    expect(stats.cacheHits).toBe(1);
    expect(stats.totalTokens).toBe(15);
  });

  it('question 不同即未命中，各自实调', async () => {
    mockConfig(vision());
    chatVisionMock.mockResolvedValue({ content: '答', elapsedMs: 1 });
    await analyzeImage.execute({ image: IMG_URL, question: '问题一' });
    await analyzeImage.execute({ image: IMG_URL, question: '问题二' });
    expect(chatVisionMock).toHaveBeenCalledTimes(2);
    expect(visionStats.snapshot().calls).toBe(2);
  });

  it('cacheEnabled=false 时不查不写缓存，重复调用均实调', async () => {
    mockConfig(vision({ cacheEnabled: false }));
    chatVisionMock.mockResolvedValue({ content: 'x', elapsedMs: 1 });
    await analyzeImage.execute({ image: IMG_URL });
    await analyzeImage.execute({ image: IMG_URL });
    expect(chatVisionMock).toHaveBeenCalledTimes(2);
    expect(visionCache.size()).toBe(0);
  });

  it('超过 TTL 后再次调用重新实调', async () => {
    vi.useFakeTimers();
    try {
      mockConfig(vision({ cacheTtlMs: 100 }));
      chatVisionMock.mockResolvedValue({ content: 'x', elapsedMs: 1 });
      await analyzeImage.execute({ image: IMG_URL });
      vi.advanceTimersByTime(101);
      await analyzeImage.execute({ image: IMG_URL });
      expect(chatVisionMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('调用失败不写缓存，失败计数 +1，重试重新实调', async () => {
    mockConfig(vision());
    chatVisionMock.mockRejectedValueOnce(new Error('服务超时'));
    chatVisionMock.mockResolvedValueOnce({ content: '恢复', elapsedMs: 1 });

    await expect(analyzeImage.execute({ image: IMG_URL })).rejects.toThrow('服务超时');
    const out = await analyzeImage.execute({ image: IMG_URL });

    expect(out).toBe('恢复');
    expect(chatVisionMock).toHaveBeenCalledTimes(2);
    const stats = visionStats.snapshot();
    expect(stats.errors).toBe(1);
    expect(stats.calls).toBe(1);
    expect(visionCache.size()).toBe(1);
  });

  it('本地文件内容变更（size 变化）后缓存自动失效', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vision-cache-'));
    const file = join(dir, 'pic.png');
    await writeFile(file, Buffer.from('aaa'));

    mockConfig(vision());
    chatVisionMock.mockResolvedValue({ content: 'v1', elapsedMs: 1 });
    const first = await analyzeImage.execute({ image: file });

    // 改变文件大小 → 指纹（size-mtime）变化 → key 变化
    await writeFile(file, Buffer.from('aaaaaa'));
    chatVisionMock.mockResolvedValue({ content: 'v2', elapsedMs: 1 });
    const second = await analyzeImage.execute({ image: file });

    expect(first).toBe('v1');
    expect(second).toBe('v2');
    expect(chatVisionMock).toHaveBeenCalledTimes(2);
  });
});
