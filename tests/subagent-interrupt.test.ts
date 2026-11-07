/**
 * 20261107-002 D8：进程重启后 running 子任务卡片标记为 interrupted
 *
 * 覆盖：
 * - markRunningSubAgentsInterrupted 把 status: running 改为 interrupted，并写入中断说明
 * - 已完成 / 失败 / 已取消的卡片不被修改
 * - 返回值等于被修改的卡片数量；无 running 卡片时不写盘
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { SessionStore } from '../src/session/store.js';
import { SUBAGENT_RESULT_CLOSE, SUBAGENT_RESULT_OPEN } from '../src/types.js';

const BASE = join(tmpdir(), 'loop-agent-tests', 'subagent-interrupt');

function cardContent(opts: {
  taskId: string;
  status: 'running' | 'done' | 'failed' | 'aborted';
  task?: string;
  answer?: string;
  error?: string;
}): string {
  return [
    SUBAGENT_RESULT_OPEN,
    `taskId: ${opts.taskId}`,
    `status: ${opts.status}`,
    `task: ${opts.task ?? 'do something'}`,
    `elapsedMs: 0`,
    `iterations: 0`,
    `answer: ${opts.answer ?? ''}`,
    `error: ${opts.error ?? ''}`,
    SUBAGENT_RESULT_CLOSE,
  ].join('\n');
}

describe('markRunningSubAgentsInterrupted', () => {
  beforeAll(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(BASE, { recursive: true });
  });
  afterAll(() => rmSync(BASE, { recursive: true, force: true }));

  it('把 running 卡片改为 interrupted 并写入中断说明', async () => {
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    const created = await store.createSession('hi', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: cardContent({ taskId: 'sub_running_1', status: 'running' }) },
    ]);

    const count = await store.markRunningSubAgentsInterrupted(created.id);
    expect(count).toBe(1);

    const data = await store.loadSession(created.id);
    const card = data.messages.find((m) => m.role === 'user' && m.content?.includes('sub_running_1'));
    expect(card?.content).toContain('status: interrupted');
    expect(card?.content).toContain('error: 进程重启，后台子任务未完成');
    expect(card?.content).not.toContain('status: running');
  });

  it('不修改 done / failed / aborted 卡片', async () => {
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    const created = await store.createSession('hi', [
      { role: 'user', content: cardContent({ taskId: 'sub_done', status: 'done', answer: 'ok' }) },
      { role: 'user', content: cardContent({ taskId: 'sub_failed', status: 'failed', error: 'boom' }) },
      { role: 'user', content: cardContent({ taskId: 'sub_aborted', status: 'aborted' }) },
    ]);

    const count = await store.markRunningSubAgentsInterrupted(created.id);
    expect(count).toBe(0);

    const data = await store.loadSession(created.id);
    const contents = data.messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(contents.some((c) => c?.includes('status: interrupted'))).toBe(false);
    expect(contents.some((c) => c?.includes('status: done'))).toBe(true);
    expect(contents.some((c) => c?.includes('status: failed'))).toBe(true);
    expect(contents.some((c) => c?.includes('status: aborted'))).toBe(true);
  });

  it('混合场景：只标记 running，其余不动', async () => {
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    const created = await store.createSession('hi', [
      { role: 'user', content: cardContent({ taskId: 'sub_a', status: 'running' }) },
      { role: 'user', content: cardContent({ taskId: 'sub_b', status: 'done', answer: 'ok' }) },
      { role: 'user', content: cardContent({ taskId: 'sub_c', status: 'running' }) },
    ]);

    const count = await store.markRunningSubAgentsInterrupted(created.id);
    expect(count).toBe(2);

    const data = await store.loadSession(created.id);
    const get = (tid: string) =>
      data.messages.find((m) => m.role === 'user' && m.content?.includes(`taskId: ${tid}`))?.content;
    expect(get('sub_a')).toContain('status: interrupted');
    expect(get('sub_c')).toContain('status: interrupted');
    expect(get('sub_b')).toContain('status: done');
    expect(get('sub_b')).toContain('answer: ok');
  });

  it('不误替换 task / answer 正文中的 error: 文本', async () => {
    const store = new SessionStore(BASE, false, BASE);
    await store.init();
    // running 卡片的 task 中包含 error: 字样，确保只改真正的 error 字段
    const created = await store.createSession('hi', [
      {
        role: 'user',
        content: cardContent({
          taskId: 'sub_evil',
          status: 'running',
          task: 'check error: foo in log',
        }),
      },
    ]);

    await store.markRunningSubAgentsInterrupted(created.id);
    const data = await store.loadSession(created.id);
    const card = data.messages.find((m) => m.role === 'user' && m.content?.includes('sub_evil'));
    // task 原文保留
    expect(card?.content).toContain('task: check error: foo in log');
    // 真正的 error 字段被置为中断说明
    expect(card?.content).toContain('error: 进程重启，后台子任务未完成');
    // 只有一个 interrupted 状态行
    const statusLines = (card?.content ?? '').match(/^status: .+$/gm) ?? [];
    expect(statusLines).toEqual(['status: interrupted']);
  });
});
