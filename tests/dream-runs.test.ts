/**
 * Task-20261026-003-01 单测：运行历史持久化（方案 D7、D8）
 *
 * 覆盖：
 * - 环形裁剪到 limit（新 → 旧）
 * - limit=0 完全不落盘（enabled=false）
 * - 文件缺失 / JSON 损坏 / 结构不符 → 空列表，不抛
 * - 原子写：落盘后无残留 .tmp
 * - clear 返回删除条数且保留空结构
 * - truncateError 截断 200 字符并去换行
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DreamRunLog, truncateError, type DreamRunRecord } from '../src/memory/dream-runs.js';

const ROOT = join(tmpdir(), 'loop-agent-tests', 'test-dream-runs');

function file(): string {
  return join(ROOT, '.dreaming-runs.json');
}

/** 造一条记录（序号写进 durationMs 便于断言顺序） */
function rec(seq: number, patch: Partial<DreamRunRecord> = {}): DreamRunRecord {
  return {
    startedAt: new Date(Date.UTC(2026, 9, 26, 19, 0, seq)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 9, 26, 19, 2, seq)).toISOString(),
    durationMs: 120_000 + seq,
    reason: 'schedule',
    ok: true,
    daysBack: 3,
    promoted: 1,
    skipped: 1,
    errors: 0,
    ...patch,
  };
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('DreamRunLog 基本读写', () => {
  it('append 后 list 返回，且新记录在最前', () => {
    const log = new DreamRunLog({ file: file(), limit: 20 });
    log.append(rec(1));
    log.append(rec(2));
    const runs = log.list();
    expect(runs).toHaveLength(2);
    expect(runs[0].durationMs).toBe(120_002);
    expect(runs[1].durationMs).toBe(120_001);
  });

  it('空文件缺失时 list 返回空数组', () => {
    const log = new DreamRunLog({ file: join(ROOT, '不存在.json'), limit: 20 });
    expect(log.list()).toEqual([]);
  });

  it('落盘结构含 version 与 runs，且无残留 .tmp', () => {
    const log = new DreamRunLog({ file: file(), limit: 20 });
    log.append(rec(1));
    const raw = JSON.parse(readFileSync(file(), 'utf-8')) as { version: number; runs: unknown[] };
    expect(raw.version).toBe(1);
    expect(raw.runs).toHaveLength(1);
    expect(existsSync(`${file()}.tmp`)).toBe(false);
  });

  it('list(limit) 可临时收窄（不改文件内容）', () => {
    const log = new DreamRunLog({ file: file(), limit: 20 });
    for (let i = 0; i < 5; i++) log.append(rec(i));
    expect(log.list(2)).toHaveLength(2);
    expect(log.list()).toHaveLength(5);
  });
});

describe('DreamRunLog 环形裁剪与关闭', () => {
  it('超过 limit 时淘汰最旧的', () => {
    const log = new DreamRunLog({ file: file(), limit: 3 });
    for (let i = 0; i < 5; i++) log.append(rec(i));
    const runs = log.list();
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.durationMs)).toEqual([120_004, 120_003, 120_002]);
  });

  it('limit=0 → enabled=false，append/list/clear 全为 no-op 且不建文件', () => {
    const log = new DreamRunLog({ file: file(), limit: 0 });
    expect(log.enabled).toBe(false);
    log.append(rec(1));
    expect(log.list()).toEqual([]);
    expect(log.clear()).toBe(0);
    expect(existsSync(file())).toBe(false);
  });

  it('负值 / NaN limit 视为关闭', () => {
    expect(new DreamRunLog({ file: file(), limit: -5 }).enabled).toBe(false);
    expect(new DreamRunLog({ file: file(), limit: Number.NaN }).enabled).toBe(false);
  });
});

describe('DreamRunLog 容错', () => {
  it('文件内容不是 JSON → list 空数组，append 后可重建', () => {
    writeFileSync(file(), '这不是 JSON {{{', 'utf-8');
    const log = new DreamRunLog({ file: file(), limit: 20 });
    expect(log.list()).toEqual([]);
    log.append(rec(7));
    expect(log.list()).toHaveLength(1);
    expect(log.list()[0].durationMs).toBe(120_007);
  });

  it('JSON 结构不符（runs 不是数组）→ 空列表', () => {
    writeFileSync(file(), JSON.stringify({ version: 1, runs: 'oops' }), 'utf-8');
    expect(new DreamRunLog({ file: file(), limit: 20 }).list()).toEqual([]);
  });

  it('runs 数组里的坏元素被过滤掉（缺 startedAt）', () => {
    writeFileSync(
      file(),
      JSON.stringify({ version: 1, runs: [{ durationMs: 1 }, rec(3)] }),
      'utf-8',
    );
    const runs = new DreamRunLog({ file: file(), limit: 20 }).list();
    expect(runs).toHaveLength(1);
    expect(runs[0].durationMs).toBe(120_003);
  });

  it('文件内含超量记录时按 limit 截断（外部手改后的自愈）', () => {
    const many = Array.from({ length: 50 }, (_, i) => rec(i));
    writeFileSync(file(), JSON.stringify({ version: 1, runs: many }), 'utf-8');
    expect(new DreamRunLog({ file: file(), limit: 20 }).list()).toHaveLength(20);
  });
});

describe('DreamRunLog.clear', () => {
  it('返回删除条数并把文件重置为空 runs', () => {
    const log = new DreamRunLog({ file: file(), limit: 20 });
    log.append(rec(1));
    log.append(rec(2));
    expect(log.clear()).toBe(2);
    expect(log.list()).toEqual([]);
    const raw = JSON.parse(readFileSync(file(), 'utf-8')) as { version: number; runs: unknown[] };
    expect(raw).toMatchObject({ version: 1, runs: [] });
  });

  it('对不存在的文件 clear 返回 0 且不抛', () => {
    const log = new DreamRunLog({ file: join(ROOT, 'nothing.json'), limit: 20 });
    expect(log.clear()).toBe(0);
  });
});

describe('truncateError', () => {
  it('去换行并压成单行', () => {
    expect(truncateError('第一行\n第二行\r\n第三行')).toBe('第一行 第二行 第三行');
  });

  it('超过 200 字符截断并加省略号', () => {
    const out = truncateError('x'.repeat(500));
    expect(out).toHaveLength(201);
    expect(out.endsWith('…')).toBe(true);
  });

  it('短文本原样返回', () => {
    expect(truncateError('  429 限流  ')).toBe('429 限流');
  });
});
