/**
 * Phase 5 验收测试：可配置向量检索 + 混合检索（BM25 + 向量 RRF 融合）
 *
 * 覆盖验收项：
 * - 5.1 未配置向量 → 行为与 Phase 4 完全一致（不启用向量，不影响功能）
 * - 5.2 embedding 服务不可用 → 自动降级 BM25/文件检索，不抛错
 * - 5.3 配置可用 → 混合检索生效：向量召回语义相关但无关键词的条目
 * - 5.4 RRF 融合：两个来源都命中的条目排最前
 * - 5.5 rebuildVectorIndex：从 Markdown 全量重建向量索引
 * - 5.6 cosine 单元测试
 * - 5.7 Session 隔离在混合检索下仍生效
 * - 5.8 向量维度不匹配 → 静默降级
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EpisodicMemory } from '../src/memory/episodic.js';
import { VectorMemory, cosine } from '../src/memory/vector.js';
import { rrfMerge } from '../src/memory/hybrid.js';
import type { IndexedEntry } from '../src/memory/fts.js';
import type { VectorSearchConfig } from '../src/memory/types.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const BASE_DIR = join(tmpdir(), 'loop-agent-tests', 'test-memory-phase5');

/** Windows 上文件句柄释放可能延迟，rmSync 失败时短延时重试 */
async function rmSyncRetry(target: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      if (i === attempts - 1) throw new Error(`rmSync 失败: ${target}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

function makeConfig(overrides: Partial<VectorSearchConfig> = {}): VectorSearchConfig {
  return {
    enabled: true,
    provider: 'openai-compatible',
    model: 'mock-model',
    dimension: 4,
    endpoint: '',
    apiKey: '',
    timeoutMs: 2000,
    batchSize: 4,
    ...overrides,
  };
}

/** mock 向量映射：含"华锐"→[1,0,0,0]，含"供应商"→[0.9,0.1,0,0]（语义相近），否则无关向量 */
function mockVector(text: string): number[] {
  if (text.includes('华锐')) return [1, 0, 0, 0];
  if (text.includes('供应商')) return [0.9, 0.1, 0, 0];
  return [0, 0, 1, 0];
}

/** 启动 OpenAI 兼容 /v1/embeddings mock 服务，返回 URL 与关闭函数 */
async function startMockEmbedServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { input } = JSON.parse(body) as { input: string[] };
        const data = (input ?? []).map((text, i) => ({
          embedding: mockVector(text),
          index: i,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data }));
      } catch {
        res.writeHead(400);
        res.end('bad request');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/v1/embeddings`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('Phase 5 配置与降级（5.1/5.2/5.8）', () => {
  const base = join(BASE_DIR, 'cfg');

  beforeAll(async () => {
    await rmSyncRetry(base);
    mkdirSync(base, { recursive: true });
  });

  afterAll(async () => {
    await rmSyncRetry(base);
  });

  it('5.1 未配置向量 → 不启用向量，行为与 Phase 4 一致', async () => {
    const epi = new EpisodicMemory(join(base, 'no-vector'));
    await epi.init();
    expect(epi.isVectorReady()).toBe(false);
    // FTS 索引仍正常
    expect(epi.isIndexReady()).toBe(true);
    await epi.appendToday('记录：华锐报价 12.5 元');
    const results = await epi.search('华锐', 5);
    expect(results.length).toBe(1);
    epi.closeIndex();
  });

  it('5.2 embedding 服务不可用 → 首次检索自动降级（不抛错、返回 BM25 结果）', async () => {
    // 直接写文件（绕过 append 的增量嵌入），仅触发 search 时的惰性构建
    const dir = join(base, 'unreachable');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-08-16.md'),
      '## [t1] [scope: global]\n- 华锐报价 12.5 元',
      'utf-8',
    );

    // 端口 1 通常拒绝连接 → embedding 失败
    const epi = new EpisodicMemory(dir, makeConfig({ endpoint: 'http://127.0.0.1:1/v1/embeddings', timeoutMs: 1000 }));
    await epi.init();
    // 表可打开（网络只在调用时），首次 search 触发构建失败 → 降级
    const results = await epi.search('华锐', 5);
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('12.5');
    // 构建失败后向量索引标记不可用
    expect(epi.isVectorReady()).toBe(false);
    epi.closeIndex();
  });

  it('5.2b append 时 embedding 失败 → 静默降级，文件写入不受影响', async () => {
    const epi = new EpisodicMemory(
      join(base, 'unreachable2'),
      makeConfig({ endpoint: 'http://127.0.0.1:1/v1/embeddings', timeoutMs: 1000 }),
    );
    await epi.init();
    // append 内部 addEntry 网络失败 → markBroken，但文件已写入
    await epi.appendToday('降级测试：华锐报价 100 元');
    expect(epi.isVectorReady()).toBe(false);
    const results = await epi.search('华锐', 5);
    expect(results.length).toBe(1); // 走文件检索
    epi.closeIndex();
  });

  it('5.8 向量维度不匹配 → 静默降级', async () => {
    const { url, close } = await startMockEmbedServer();
    try {
      const dir = join(base, 'dim-mismatch');
      const epi = new EpisodicMemory(dir, makeConfig({ endpoint: url, dimension: 8 }));
      await epi.init();
      // mock 返回 4 维，配置期望 8 维 → embed 抛错 → markBroken
      await epi.appendToday('维度测试：华锐报价');
      expect(epi.isVectorReady()).toBe(false);
      // 降级后 FTS 检索仍正常
      const results = await epi.search('华锐', 5);
      expect(results.length).toBe(1);
      epi.closeIndex();
    } finally {
      await close();
    }
  });
});

describe('混合检索（5.3/5.4/5.5/5.6/5.7）', () => {
  const base = join(BASE_DIR, 'hybrid');
  let embedUrl = '';
  let stopServer: () => Promise<void>;

  beforeAll(async () => {
    await rmSyncRetry(base);
    mkdirSync(base, { recursive: true });
    const server = await startMockEmbedServer();
    embedUrl = server.url;
    stopServer = server.close;
  });

  afterAll(async () => {
    await stopServer();
    await rmSyncRetry(base);
  });

  it('5.6 cosine 相似度', () => {
    expect(cosine([1, 0, 0, 0], [1, 0, 0, 0])).toBeCloseTo(1);
    expect(cosine([1, 0, 0, 0], [0, 1, 0, 0])).toBeCloseTo(0);
    expect(cosine([1, 0, 0, 0], [0.9, 0.1, 0, 0])).toBeGreaterThan(0.9);
    // 维度不一致 → 0
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });

  it('5.4 RRF 融合：两个来源都命中的条目排最前', () => {
    const mk = (content: string): IndexedEntry => ({ day: 'd', content });
    const bm25 = [mk('A 华锐'), mk('C 无关')];
    const vector = [mk('A 华锐'), mk('B 语义相关')];
    const merged = rrfMerge(bm25, vector, 60, 5);
    expect(merged[0].content).toBe('A 华锐'); // 双命中排第一
    expect(merged.length).toBe(3);
  });

  it('5.3 混合检索：向量召回语义相关但无关键词的条目', async () => {
    const epi = new EpisodicMemory(join(base, 'hybrid1'), makeConfig({ endpoint: embedUrl }));
    await epi.init();
    expect(epi.isVectorReady()).toBe(true);

    // A：BM25 命中"华锐"；B：无"华锐"关键词但语义相关（mock 判定相近）；C：无关
    await epi.appendToday('A 华锐报价 12.5 元', { scope: 'global' });
    await epi.appendToday('B 供应商在华东区域的报价谈判', { scope: 'global' });
    await epi.appendToday('C 完全无关的天气记录', { scope: 'global' });

    const results = await epi.search('华锐', 5);
    // BM25 召回 A
    expect(results.some((r) => r.content.includes('华锐报价'))).toBe(true);
    // 向量语义召回 B（无共同关键词，纯 BM25 不可能命中）
    expect(results.some((r) => r.content.includes('供应商'))).toBe(true);
    // A（双来源）排在最前
    expect(results[0].content).toContain('华锐报价');
    // C 不出现
    expect(results.some((r) => r.content.includes('天气'))).toBe(false);
    epi.closeIndex();
  });

  it('5.7 Session 隔离在混合检索下仍生效', async () => {
    const epi = new EpisodicMemory(join(base, 'hybrid2'), makeConfig({ endpoint: embedUrl }));
    await epi.init();
    // session 级条目属于 sess_A
    await epi.appendToday('机密：华锐并购进展', { sessionId: 'sess_A', scope: 'session' });
    await epi.appendToday('供应商公开信息', { scope: 'global' });

    // Session B 看不到 sess_A 的 session 条目（即使向量召回）
    const fromB = await epi.search('华锐', 5, { sessionId: 'sess_B' });
    expect(fromB.some((r) => r.content.includes('并购'))).toBe(false);
    expect(fromB.some((r) => r.content.includes('供应商'))).toBe(true);
    epi.closeIndex();
  });

  it('5.5 rebuildVectorIndex：从 Markdown 全量重建', async () => {
    const dir = join(base, 'rebuild');
    mkdirSync(dir, { recursive: true });
    // 绕过 append 直接写文件
    writeFileSync(
      join(dir, '2026-08-01.md'),
      '## [t1] [scope: global]\n- 华锐季度财报发布\n\n## [t2] [scope: global]\n- 供应商质量评估',
      'utf-8',
    );

    const epi = new EpisodicMemory(dir, makeConfig({ endpoint: embedUrl }));
    await epi.init();
    const count = await epi.rebuildVectorIndex();
    expect(count).toBe(2);
    expect(epi.isVectorReady()).toBe(true);

    // 重建后可语义检索（供应商与"华锐相关"语义召回）
    const results = await epi.search('华锐', 5);
    expect(results.some((r) => r.content.includes('财报'))).toBe(true);
    epi.closeIndex();
  });
});
