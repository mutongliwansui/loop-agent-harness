/**
 * 会话记忆隔离矩阵（task-20261106-002）
 *
 * 覆盖：
 * - A/B 会话的 session 级条目互不可见
 * - global 条目对两个会话都可见
 * - 管理检索（scope:'all'）可见全部条目
 * - 双缺失（无 sessionId 无 scope）→ fail-closed 返回空
 * - 写入契约：scope 必填；session 级缺 sessionId 拒绝写入、不产出裸条目
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EpisodicMemory, type AppendOptions } from '../src/memory/episodic.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const MEMORY_DIR = join(tmpdir(), 'loop-agent-tests', 'test-memory-isolation');

function today(): string {
  return new Date().toISOString().split('T')[0];
}

describe('L2 会话隔离矩阵', () => {
  let episodic: EpisodicMemory;

  beforeAll(async () => {
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    mkdirSync(MEMORY_DIR, { recursive: true });
    episodic = new EpisodicMemory(MEMORY_DIR);
    await episodic.init();

    await episodic.appendToday('会话 A 记录：用户喜欢苹果', {
      sessionId: 'sess_A',
      scope: 'session',
      tag: 'tool',
    });
    await episodic.appendToday('会话 B 记录：华锐并购进展机密', {
      sessionId: 'sess_B',
      scope: 'session',
      tag: 'tool',
    });
    await episodic.appendToday('全局知识：项目使用 TypeScript，支持全局共享', {
      scope: 'global',
      tag: 'knowledge',
    });
  });

  afterAll(() => {
    episodic.closeIndex();
    rmSync(MEMORY_DIR, { recursive: true, force: true });
  });

  it('A 会话只能看到自己的 session 级 + global 级', async () => {
    const results = await episodic.search('苹果 并购 全局', 10, { sessionId: 'sess_A' });
    const text = results.map((r) => r.content).join('\n');
    expect(text).toContain('苹果');
    expect(text).toContain('TypeScript');
    expect(text).not.toContain('并购');
  });

  it('B 会话拿不到 A 的 session 级条目', async () => {
    const results = await episodic.search('苹果 并购 全局', 10, { sessionId: 'sess_B' });
    const text = results.map((r) => r.content).join('\n');
    expect(text).toContain('并购');
    expect(text).toContain('TypeScript');
    expect(text).not.toContain('苹果');
  });

  it('上下文首轮（scope=session）只返回当前会话条目', async () => {
    const results = await episodic.search('苹果 并购', 10, { sessionId: 'sess_A', scope: 'session' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('苹果');
  });

  it('管理检索 scope=all 可见全部条目', async () => {
    const results = await episodic.search('苹果 并购 全局', 10, { scope: 'all' });
    const text = results.map((r) => r.content).join('\n');
    expect(text).toContain('苹果');
    expect(text).toContain('并购');
    expect(text).toContain('TypeScript');
  });

  it('双缺失（无 sessionId 无 scope）→ fail-closed 返回空', async () => {
    expect(await episodic.search('苹果 并购 全局', 10)).toEqual([]);
  });

  it('写入契约：无 scope 拒绝写入（不产出裸条目）', async () => {
    const before = await episodic.readDay(today());
    await episodic.appendToday('不应落盘的裸条目', {} as unknown as AppendOptions);
    const after = await episodic.readDay(today());
    expect(after).toBe(before);
    expect(after).not.toContain('不应落盘的裸条目');
  });

  it('写入契约：session 级缺 sessionId 拒绝写入', async () => {
    await episodic.appendToday('不应落盘的 session 条目', { scope: 'session', tag: 'tool' });
    const content = await episodic.readDay(today());
    expect(content).not.toContain('不应落盘的 session 条目');
  });
});
