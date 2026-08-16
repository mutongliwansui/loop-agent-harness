/**
 * Phase 2 验收测试：ToolMemoryCallback（工具结果自动写入 L2）
 *
 * 覆盖验收项：
 * - 2.3 工具结果自动记录（带 sessionId + scope 标签）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EpisodicMemory } from '../src/memory/episodic.js';
import { ToolMemoryCallback } from '../src/memory/callback.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const MEMORY_DIR = join(tmpdir(), 'loop-agent-tests', 'test-memory-callback');

describe('ToolMemoryCallback', () => {
  let episodic: EpisodicMemory;
  let callback: ToolMemoryCallback;

  beforeAll(async () => {
    rmSync(MEMORY_DIR, { recursive: true, force: true });
    mkdirSync(MEMORY_DIR, { recursive: true });
    episodic = new EpisodicMemory(MEMORY_DIR);
    await episodic.init();
    callback = new ToolMemoryCallback(episodic);
  });

  afterAll(async () => {
    episodic.closeIndex();
    rmSync(MEMORY_DIR, { recursive: true, force: true });
  });

  it('2.3 工具结果写入 L2：带 sessionId 和 scope=session 标签', async () => {
    callback.setSessionId('sess_abc');
    await callback.log('fileRead', { path: 'a.txt' }, '文件内容：华锐报价 12.5 元');

    const day = new Date().toISOString().split('T')[0];
    const content = await episodic.readDay(day);

    // 内容写入
    expect(content).toContain('[tool:fileRead]');
    expect(content).toContain('华锐报价');
    // 元数据标签
    expect(content).toContain('[sessionId: sess_abc]');
    expect(content).toContain('[scope: session]');
    expect(content).toContain('[tag: tool]');
  });

  it('2.3b 无 sessionId 时仍写入（无 session/scope 标签）', async () => {
    callback.setSessionId(null);
    await callback.log('grep', { pattern: 'x' }, '匹配 3 行');

    const day = new Date().toISOString().split('T')[0];
    const content = await episodic.readDay(day);
    // 定位本条记录（grep 条目）
    const grepEntry = content.split('## ').find((s) => s.includes('[tool:grep]')) ?? '';
    expect(grepEntry).toContain('[tool:grep]');
    // 本条记录不带 sessionId/scope 标签
    expect(grepEntry).not.toContain('[sessionId:');
    expect(grepEntry).not.toContain('[scope:');
  });

  it('2.3c logError 记录工具错误', async () => {
    callback.setSessionId('sess_err');
    await callback.logError('fileRead', '文件不存在');

    const day = new Date().toISOString().split('T')[0];
    const content = await episodic.readDay(day);
    expect(content).toContain('ERROR:');
    expect(content).toContain('文件不存在');
    expect(content).toContain('[sessionId: sess_err]');
  });

  it('2.3d logGlobal 写入全局记忆（跨会话可见）', async () => {
    await callback.logGlobal('项目技术栈：TypeScript', 'project');

    const day = new Date().toISOString().split('T')[0];
    const content = await episodic.readDay(day);
    expect(content).toContain('项目技术栈：TypeScript');
    expect(content).toContain('[scope: global]');
    expect(content).toContain('[tag: project]');
  });

  it('2.3e 长输出截断到 200 字符', async () => {
    callback.setSessionId('sess_long');
    const longOutput = 'z'.repeat(500);
    await callback.log('commandRun', {}, longOutput);

    const day = new Date().toISOString().split('T')[0];
    const content = await episodic.readDay(day);
    // 内容截断 + ... 后缀
    expect(content).toContain('...');
  });

  it('2.3f 写入失败静默丢弃（不抛错）', async () => {
    // 用一个同名文件占位，导致 mkdir/appendFile 失败
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(MEMORY_DIR, 'blocked'), 'file', 'utf-8');

    const blocked = new EpisodicMemory(join(MEMORY_DIR, 'blocked'));
    const failing = new ToolMemoryCallback(blocked);
    failing.setSessionId('sess_fail');
    await expect(failing.log('fileRead', {}, 'data')).resolves.toBeUndefined();
  });
});
