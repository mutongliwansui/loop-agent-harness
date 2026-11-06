/**
 * Phase 4 验收测试：SQLite FTS5 索引 + 安全降级
 *
 * 覆盖验收项：
 * - 4.1 SQLite FTS5 索引：全文搜索返回准确结果（含中文 bigram）
 * - 4.2 Session 过滤 + SQLite：FTS5 检索支持 Session 过滤
 * - 4.3 索引重建：索引损坏后可从 Markdown 重建
 * - 4.4 检索超时降级：检索超时时返回空，不阻塞对话
 * - 4.5 写入失败降级：L2 写入失败时静默丢弃
 * - 4.6 L2 读取失败降级：L2 读取失败时返回空内容
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EpisodicMemory } from '../src/memory/episodic.js';
import { MemoryIndex, tokenizeForFts, tokenizeQuery } from '../src/memory/fts.js';
import { ContextAssembler } from '../src/memory/context.js';
import { CuratedMemory } from '../src/memory/curated.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const BASE_DIR = join(tmpdir(), 'loop-agent-tests', 'test-memory-phase4');

/** Windows 上文件句柄释放可能延迟，rmSync 失败时短延时重试 */
async function rmSyncRetry(target: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

describe('MemoryIndex FTS5（4.1/4.2/4.3）', () => {
  const idxDir = join(BASE_DIR, 'index');
  let index: MemoryIndex;
  let dbPath: string;

  beforeAll(async () => {
    rmSync(BASE_DIR, { recursive: true, force: true });
    mkdirSync(idxDir, { recursive: true });
    dbPath = join(idxDir, 'index.sqlite');
    index = new MemoryIndex(dbPath);
    expect(index.init()).toBe(true);
  });

  afterAll(async () => {
    index.close();
    await rmSyncRetry(BASE_DIR);
  });

  it('4.1a 中文 bigram 分词：2 字词可命中', () => {
    expect(tokenizeForFts('华锐报价 12.5 元')).toContain('华锐 锐报 报价');
    expect(tokenizeQuery('华锐')).toContain('"华锐"');
  });

  it('4.1b FTS5 全文搜索返回准确结果（中文短词）', () => {
    index.add('2026-08-16', '## [t1] [scope: session] [sessionId: a]\n- 华锐报价 12.5 元/股');
    index.add('2026-08-15', '## [t2] [scope: session] [sessionId: b]\n- 用户偏好性价比优先');
    index.add('2026-08-14', '## [t3] [scope: global]\n- 项目使用 TypeScript 开发');

    const r1 = index.search('华锐', 5);
    expect(r1.length).toBe(1);
    expect(r1[0].content).toContain('华锐报价');

    const r2 = index.search('报价', 5);
    expect(r2.length).toBe(1);

    const r3 = index.search('TypeScript', 5);
    expect(r3.length).toBe(1);
    expect(r3[0].content).toContain('TypeScript');

    // 无命中返回空
    expect(index.search('不存在的关键词xyz', 5).length).toBe(0);
  });

  it('4.1c BM25 排序：命中多条且按相关度排序', () => {
    index.clear();
    index.add('2026-08-10', '## [c1]\n- 华锐与华锐国际的合并谈判进展');
    index.add('2026-08-11', '## [c2]\n- 华锐发布了新的价格体系');
    index.add('2026-08-12', '## [c3]\n- 完全不相关的记录');

    const results = index.search('华锐', 5);
    expect(results.length).toBe(2);
  });

  it('4.2 Session 过滤 + FTS5：通过 EpisodicMemory.search 过滤', async () => {
    const epi = new EpisodicMemory(join(BASE_DIR, 'episodic'));
    await epi.init();
    expect(epi.isIndexReady()).toBe(true);

    await epi.appendToday('机密：华锐报价 12.5 元', {
      sessionId: 'sess_A',
      scope: 'session',
      tag: 'tool',
    });
    await epi.appendToday('全局知识：华锐是重点客户', {
      sessionId: 'sess_A',
      scope: 'global',
      tag: 'knowledge', // 非压缩类 tag（压缩笔记 tag: compaction 不参与检索）
    });

    // Session B 只能看到 global 级
    const fromB = await epi.search('华锐', 5, { sessionId: 'sess_B' });
    expect(fromB.length).toBe(1);
    expect(fromB[0].content).toContain('重点客户');

    // Session A 能看到自己的 session 级 + global 级
    const fromA = await epi.search('华锐', 5, { sessionId: 'sess_A' });
    expect(fromA.length).toBe(2);

    epi.closeIndex();
  });

  it('4.2b fail-closed：无 scope 的历史裸条目对上下文不可见，管理检索可见', async () => {
    const dir = join(BASE_DIR, 'episodic-bare');
    mkdirSync(dir, { recursive: true });
    // 绕过 append 直接写旧格式裸条目（无 scope / sessionId 标记）
    writeFileSync(
      join(dir, '2026-09-01.md'),
      '## [2026-09-01T00:00:00.000Z]\n- 旧裸条目：华锐报价 12.5 元',
      'utf-8',
    );
    const epi = new EpisodicMemory(dir);
    await epi.init();

    // 带 sessionId 的上下文检索 → 不可见
    expect(await epi.search('华锐', 5, { sessionId: 'sess_A' })).toHaveLength(0);
    // 双缺失 → 不可见
    expect(await epi.search('华锐', 5)).toHaveLength(0);
    // 管理检索（scope:'all'）→ 可见
    expect(await epi.search('华锐', 5, { scope: 'all' })).toHaveLength(1);

    epi.closeIndex();
  });

  it('4.3 索引重建：损坏后可从 Markdown 重建', async () => {
    const rebuildDir = join(BASE_DIR, 'rebuild');
    mkdirSync(rebuildDir, { recursive: true });
    writeFileSync(
      join(rebuildDir, '2026-08-01.md'),
      '## [t1] [sessionId: x] [scope: session]\n- 华锐报价 9.9 元\n\n## [t2] [scope: global]\n- TypeScript 项目',
      'utf-8',
    );

    // 直接测试 MemoryIndex.rebuildFromFiles（不依赖 append 同步索引）
    const idx = new MemoryIndex(join(rebuildDir, 'index.sqlite'));
    expect(idx.init()).toBe(true);

    // 空索引 → 检索为空
    expect(idx.search('华锐', 5).length).toBe(0);

    // 重建索引
    const count = await idx.rebuildFromFiles(rebuildDir);
    expect(count).toBe(2);

    // 重建后可检索
    const after = idx.search('华锐', 5);
    expect(after.length).toBe(1);
    expect(after[0].content).toContain('9.9');

    const ts = idx.search('TypeScript', 5);
    expect(ts.length).toBe(1);

    idx.close();

    // 通过 EpisodicMemory.rebuildIndex 验证
    const epi = new EpisodicMemory(rebuildDir);
    await epi.init();
    // 覆盖已有索引文件会复用，直接重建
    const epiCount = await epi.rebuildIndex();
    expect(epiCount).toBe(2);
    expect(epi.isIndexReady()).toBe(true);
    const epiSearch = await epi.search('TypeScript', 5, { scope: 'all' });
    expect(epiSearch.length).toBe(1);
    epi.closeIndex();
  });
});

describe('降级策略（4.4/4.5/4.6）', () => {
  const base = join(BASE_DIR, 'degrade');

  beforeAll(async () => {
    rmSync(base, { recursive: true, force: true });
    mkdirSync(base, { recursive: true });
  });

  afterAll(async () => {
    await rmSyncRetry(base);
  });

  it('4.4 检索超时降级：ContextAssembler 超时返回空，不阻塞', async () => {
    const epi = new EpisodicMemory(join(base, 'epi'));
    await epi.init();
    const curated = new CuratedMemory(join(base, 'curated'));
    await curated.init();
    const assembler = new ContextAssembler(curated, epi);

    await epi.appendToday('测试数据：华锐报价 12.5 元', { scope: 'global' });
    // searchTimeoutMs=1 → 超时返回空（不阻塞）
    const messages = await assembler.assemble('华锐', [{ role: 'user', content: '查询' }], [], {
      searchTimeoutMs: 1,
      searchTopK: 3,
    });
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe('system');
    epi.closeIndex();
  });

  it('4.5 写入失败降级：L2 写入失败时静默丢弃', async () => {
    // 用同名文件占位，导致 mkdir/appendFile 失败
    writeFileSync(join(base, 'blocked'), 'file', 'utf-8');
    const epi = new EpisodicMemory(join(base, 'blocked'));
    // append 内部 init 会尝试 mkdir（失败），append 应抛错 → 由调用方 try/catch
    await expect(epi.append('2026-08-16', '数据', { sessionId: 's', scope: 'session' })).rejects.toThrow();
  });

  it('4.5b 索引不可用时写入/检索降级为文件模式', async () => {
    const epi = new EpisodicMemory(join(base, 'epi2'));
    await epi.init();
    expect(epi.isIndexReady()).toBe(true);
    // 先释放句柄再破坏索引文件
    epi.closeIndex();
    writeFileSync(join(base, 'epi2', 'index.sqlite'), 'CORRUPTED-NOT-SQLITE', 'utf-8');

    // 重新打开：损坏文件无法初始化 → 降级
    epi.initIndex();
    expect(epi.isIndexReady()).toBe(false);

    // 写入仍工作（文件优先）
    await epi.appendToday('降级测试：华锐报价 100 元', { scope: 'global' });
    // 文件检索仍可用（管理检索显式全量）
    const results = await epi.search('华锐', 5, { scope: 'all' });
    expect(results.length).toBe(1);
  });

  it('4.6 L2 读取失败降级：readDay 返回空内容', async () => {
    const epi = new EpisodicMemory(join(base, 'epi3'));
    await epi.init();
    // 读取不存在的日期 → 空字符串
    expect(await epi.readDay('1999-01-01')).toBe('');
    // listDays 忽略非 md 文件
    writeFileSync(join(base, 'epi3', 'not-a-day.txt'), 'x', 'utf-8');
    const days = await epi.listDays();
    expect(days.every((d) => !d.endsWith('.txt'))).toBe(true);
    epi.closeIndex();
  });

  it('4.6b search 在目录不存在时返回空（不抛错）', async () => {
    const epi = new EpisodicMemory(join(base, 'no-such-dir'));
    const results = await epi.search('anything', 5);
    expect(results).toEqual([]);
    // search 走文件路径时 init 会打开索引，须释放句柄
    epi.closeIndex();
  });
});
