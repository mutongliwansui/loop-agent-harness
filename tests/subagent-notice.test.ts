// 需求 20261108-001：后台子任务完成通知——超长结果落盘 tmp，通知带路径 + 预览
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSubAgentWakeNotice, SUBAGENT_WAKE_PREFIX } from '../src/api/subagent-notice.js';
import { setTmpDirForTest } from '../src/tools/output-governor.js';

let testRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'loop-subagent-notice-test-'));
  setTmpDirForTest(testRoot);
});

afterEach(() => {
  setTmpDirForTest(undefined);
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const BASE = {
  taskId: 'sub_test123',
  task: 'README 中英文比对',
  status: 'done',
  iterations: 5,
  elapsedMs: 335000,
  sessionId: 'sess_test',
};

describe('buildSubAgentWakeNotice（需求 20261108-001）', () => {
  it('短结果：原样进通知，不落盘', async () => {
    const notice = await buildSubAgentWakeNotice({ ...BASE, answer: '比对完成，全部一致' });
    expect(notice).toContain(`${SUBAGENT_WAKE_PREFIX} sub_test123 已完成（335.0s · 5 轮）`);
    expect(notice).toContain('任务：README 中英文比对');
    expect(notice).toContain('结果：比对完成，全部一致');
    expect(notice).not.toContain('已落盘');
    expect(notice).not.toContain('结果过长已截断');
  });

  it('超长结果：完整落盘，通知带路径 + 预览，文件内容与结果全文一致', async () => {
    const long = 'A'.repeat(1500) + 'B'.repeat(1500); // 3000 字符 > 2000
    const notice = await buildSubAgentWakeNotice({ ...BASE, answer: long });

    // 通知不再出现旧的截断标记，改为落盘提示
    expect(notice).not.toContain('（结果过长已截断）');
    expect(notice).toContain('完整内容已落盘');
    expect(notice).toContain('文件大小:');
    expect(notice).toContain('fileRead');

    // 从通知中提取路径并校验文件真实存在、内容为全文
    const m = notice.match(/路径: (.+)/);
    expect(m).not.toBeNull();
    const path = m![1].trim();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(long);

    // 预览为结果开头（前 400 字符）
    expect(notice).toContain('A'.repeat(100));
    // 落盘目录按会话隔离、文件名带 subagent 前缀
    expect(path).toContain(join('sess_test'));
    expect(path).toContain('subagent-');
  });

  it('落盘失败：降级为 2000 字符截断并如实声明', async () => {
    // 把 tmp 目录指到一个已存在的文件上，使写入必然失败
    const blocker = join(testRoot, 'not-a-dir');
    writeFileSync(blocker, 'x', 'utf-8');
    setTmpDirForTest(blocker);

    const long = 'X'.repeat(3000);
    const notice = await buildSubAgentWakeNotice({ ...BASE, answer: long });

    expect(notice).toContain('结果过长已截断');
    expect(notice).toContain('完整内容落盘失败');
    // 截断保留前 2000 字符
    expect(notice).toContain('X'.repeat(50));
  });

  it('error 优先于 answer；aborted 状态文案正确', async () => {
    const notice = await buildSubAgentWakeNotice({
      ...BASE,
      status: 'failed',
      answer: '不应出现',
      error: 'boom',
    });
    expect(notice).toContain('结果：boom');
    expect(notice).not.toContain('不应出现');
    expect(notice).toContain('失败');

    const aborted = await buildSubAgentWakeNotice({ ...BASE, status: 'aborted' });
    expect(aborted).toContain('已取消');
  });

  it('空结果：显示（无输出）占位', async () => {
    const notice = await buildSubAgentWakeNotice({ ...BASE });
    expect(notice).toContain('结果：（无输出）');
  });
});
