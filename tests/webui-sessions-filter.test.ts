/**
 * 侧栏 0 会话分组前端防御性收敛（需求 20261113-002 D7）
 *
 * 后端 GET /workspaces 已按 D5 过滤 0 会话空间，前端 `filteredGroups` 再兜一层，
 * 覆盖「前端缓存了旧响应 / 连的是旧版后端」的窗口期：
 * - 无关键词时也丢弃 0 会话分组（旧实现只在有关键词时丢弃）；
 * - 关键词命中空间名/路径仍保留整组；命中标题则按条目过滤，空组丢弃。
 *
 * 本测试只测纯计算属性，不触达网络（client / toast / chat-stream 全部 mock）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../webui/src/api/client.js', () => ({
  api: vi.fn(async () => ({ workspaces: [] })),
  AuthError: class AuthError extends Error {},
}));
vi.mock('../webui/src/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../webui/src/chat-stream.js', () => ({
  drop: vi.fn(),
  dropAndBroadcast: vi.fn(),
}));

type Mod = typeof import('../webui/src/sessions.js');
let mod: Mod;

function group(path: string, name: string, titles: string[]) {
  return {
    id: path.replace(/\W/g, '').slice(-16) || path,
    name,
    path,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastAccessedAt: '2026-01-01T00:00:00.000Z',
    sessions: titles.map((title, i) => ({
      id: `sess_${path}_${i}`,
      title,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 1,
    })),
  };
}

beforeEach(async () => {
  mod = await import('../webui/src/sessions.js');
  mod.sessKw.value = '';
  mod.workspaces.value = [];
});

describe('D7：filteredGroups 无关键词时也丢弃 0 会话分组', () => {
  it('幽灵空组不出现；有会话的组原样保留', () => {
    mod.workspaces.value = [
      group('C:\\Users\\muton', 'muton', []),
      group('D:\\trae_workspace\\loop-agent-command', 'loop-agent-command', ['会话 A']),
    ] as never;

    const out = mod.filteredGroups.value;
    expect(out.length).toBe(1);
    expect(out[0].path).toBe('D:\\trae_workspace\\loop-agent-command');
    expect(out[0].sessions.length).toBe(1);
  });

  it('全为 0 会话分组 → 空列表（侧栏走「空态」而非一排空组）', () => {
    mod.workspaces.value = [
      group('C:\\Users\\muton', 'muton', []),
      group('D:\\tmp\\empty', 'empty', []),
    ] as never;
    expect(mod.filteredGroups.value).toEqual([]);
  });

  it('原始 workspaces 不被就地修改（过滤是纯派生）', () => {
    mod.workspaces.value = [
      group('C:\\Users\\muton', 'muton', []),
      group('D:\\w', 'w', ['x']),
    ] as never;
    void mod.filteredGroups.value;
    expect(mod.workspaces.value.length).toBe(2);
  });

  it('有关键词：命中空间名保留整组（含 0 会话组仍被丢弃）', () => {
    mod.workspaces.value = [
      group('C:\\Users\\muton', 'muton', []),
      group('D:\\work\\muton-project', 'muton-project', ['任务一', '任务二']),
    ] as never;
    mod.sessKw.value = 'muton';

    const out = mod.filteredGroups.value;
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('muton-project');
    expect(out[0].sessions.length).toBe(2);
  });

  it('有关键词：命中标题按条目过滤，无命中条目的组丢弃', () => {
    mod.workspaces.value = [
      group('D:\\a', 'a', ['登录问题', '导出报表']),
      group('D:\\b', 'b', ['无关话题']),
    ] as never;
    mod.sessKw.value = '登录';

    const out = mod.filteredGroups.value;
    expect(out.length).toBe(1);
    expect(out[0].path).toBe('D:\\a');
    expect(out[0].sessions.map((s) => s.title)).toEqual(['登录问题']);
  });
});
