/**
 * 模型性能测试历史落盘单测（需求 20261027-003 / 设计方案 §5.4）
 *
 * 覆盖：
 * - hostOf 只留 host（不泄露路径 / 凭证）
 * - 追加 + 读回（原子写替身：临时文件 + rename）
 * - 每模型裁剪到 keep 条，且新记录在前
 * - 文件缺失 / 损坏 → 空表（历史是附属能力，不能让主流程崩）
 * - queryHistory：带 alias 取该模型 N 次；不带 alias 取每模型最近一次
 * - 落盘内容不含 apiKey（新持久化面不引入密钥）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BENCH_HISTORY_KEEP,
  appendBenchHistory,
  benchHistoryPath,
  hostOf,
  pruneRuns,
  queryHistory,
  readBenchHistory,
  type BenchHistoryEntry,
} from '../src/llm/bench-store.js';
import { summarize } from '../src/llm/bench.js';

let root = '';

function entry(alias: string, iso: string, ttftMs = 120): BenchHistoryEntry {
  return {
    runId: `bench_${alias}_${iso}`,
    alias,
    model: `model-${alias}`,
    baseUrlHost: 'api.example.com',
    startedAt: iso,
    finishedAt: iso,
    config: { tier: 'quick', prompts: ['short'], rounds: 1, maxTokens: 256, bustCache: true },
    summary: summarize([{ prompt: 'short', round: 1, ok: true, ttftMs, decodeTps: 42, outTokens: 20 }]),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bench-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('hostOf 地址归一', () => {
  it('正常 URL → host:port', () => {
    expect(hostOf('https://api.deepseek.com/v1')).toBe('api.deepseek.com');
    expect(hostOf('http://127.0.0.1:11434/v1')).toBe('127.0.0.1:11434');
  });

  it('含凭证的 URL 不泄露 user:pass', () => {
    const host = hostOf('https://user:secret@api.example.com/v1/chat');
    expect(host).toBe('api.example.com');
    expect(host).not.toContain('secret');
  });

  it('解析失败的串 → 剪掉凭证段并截断，绝不原样返回完整串', () => {
    const raw = `not a url //user:secret@host/${'x'.repeat(200)}`;
    const host = hostOf(raw);
    expect(host).not.toContain('secret');
    expect(host.length).toBeLessThanOrEqual(64);
  });
});

describe('appendBenchHistory / readBenchHistory', () => {
  it('文件不存在 → 空表（不抛错）', async () => {
    const file = await readBenchHistory(root);
    expect(file.runs).toEqual([]);
    expect(file.version).toBe(1);
  });

  it('追加一条后能读回，字段完整', async () => {
    await appendBenchHistory(root, entry('alpha', '2026-10-27T00:00:00.000Z'));
    const file = await readBenchHistory(root);
    expect(file.runs).toHaveLength(1);
    expect(file.runs[0].alias).toBe('alpha');
    expect(file.runs[0].summary.ttft.p50).toBe(120);
    expect(file.runs[0].config.maxTokens).toBe(256);
    expect(existsSync(benchHistoryPath(root))).toBe(true);
  });

  it('新记录排在最前（数组按新→旧）', async () => {
    await appendBenchHistory(root, entry('alpha', '2026-10-27T00:00:00.000Z', 100));
    await appendBenchHistory(root, entry('alpha', '2026-10-27T01:00:00.000Z', 200));
    const file = await readBenchHistory(root);
    expect(file.runs.map((r) => r.startedAt)).toEqual([
      '2026-10-27T01:00:00.000Z',
      '2026-10-27T00:00:00.000Z',
    ]);
  });

  it('每模型只留最近 keep 条（不同 model 互不影响）', async () => {
    for (let i = 0; i < BENCH_HISTORY_KEEP + 3; i++) {
      await appendBenchHistory(root, entry('alpha', `2026-10-27T00:${String(i).padStart(2, '0')}:00.000Z`), 5);
    }
    const file = await readBenchHistory(root);
    expect(file.runs).toHaveLength(5);
    // 最后追加的（i=22）在最前，最早的已被裁掉
    expect(file.runs[0].startedAt).toContain(':22:');
    expect(file.runs.map((r) => r.startedAt)).not.toContain('2026-10-27T00:00:00.000Z');
  });

  it('文件损坏（非法 JSON）→ 空表，不抛错', async () => {
    writeFileSync(benchHistoryPath(root), '{ this is not json', 'utf-8');
    const file = await readBenchHistory(root);
    expect(file.runs).toEqual([]);
  });

  it('结构缺字段的条目被过滤（isEntry 守卫）', async () => {
    writeFileSync(
      benchHistoryPath(root),
      JSON.stringify({ version: 1, runs: [{ alias: 'no-runid' }, entry('beta', '2026-10-27T00:00:00.000Z')] }),
      'utf-8',
    );
    const file = await readBenchHistory(root);
    expect(file.runs.map((r) => r.alias)).toEqual(['beta']);
  });

  it('落盘内容不含 apiKey（新持久化面不引入密钥）', async () => {
    const e = entry('alpha', '2026-10-27T00:00:00.000Z');
    await appendBenchHistory(root, e);
    const raw = readFileSync(benchHistoryPath(root), 'utf-8');
    expect(raw).not.toContain('sk-');
    expect(raw).not.toContain('apiKey');
    expect(raw).toContain('api.example.com');
  });

  it('不残留 .tmp 临时文件（rename 成功即清理）', async () => {
    await appendBenchHistory(root, entry('alpha', '2026-10-27T00:00:00.000Z'));
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('pruneRuns / queryHistory', () => {
  const runs = [
    entry('alpha', '2026-10-27T03:00:00.000Z'),
    entry('beta', '2026-10-27T02:00:00.000Z'),
    entry('alpha', '2026-10-27T01:00:00.000Z'),
    entry('beta', '2026-10-27T00:00:00.000Z'),
  ];

  it('pruneRuns 按 alias 计数裁剪，保留靠前的（较新）记录', () => {
    const out = pruneRuns(runs, 1);
    expect(out.map((r) => `${r.alias}@${r.startedAt}`)).toEqual([
      'alpha@2026-10-27T03:00:00.000Z',
      'beta@2026-10-27T02:00:00.000Z',
    ]);
  });

  it('queryHistory 带 alias → 该模型最近 N 次', () => {
    const out = queryHistory({ version: 1, runs }, { alias: 'alpha', limit: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].startedAt).toBe('2026-10-27T03:00:00.000Z');
  });

  it('queryHistory 不带 alias → 每模型最近一次（模型页首屏「性能」列）', () => {
    const out = queryHistory({ version: 1, runs });
    expect(out.map((r) => r.alias)).toEqual(['alpha', 'beta']);
    expect(out[0].startedAt).toBe('2026-10-27T03:00:00.000Z');
  });

  it('limit 被 clamp 到 [1, keep]（前端传 999 不会打爆）', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      entry(`m${i}`, `2026-10-27T00:00:${String(i).padStart(2, '0')}.000Z`),
    );
    expect(queryHistory({ version: 1, runs: many }, { limit: 999 })).toHaveLength(BENCH_HISTORY_KEEP);
    expect(queryHistory({ version: 1, runs: many }, { limit: 0 })).toHaveLength(1);
  });
});
