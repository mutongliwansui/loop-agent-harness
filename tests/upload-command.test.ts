// /upload 命令单测（Task-20261012-001）
// 覆盖：match、带参上传与注入、无会话拒绝、无参弹框三分支、list/clean 渲染
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { COLORS } from '../src/ui/colors.js';
import type { CommandContext } from '../src/commands/registry.js';

const managerMocks = vi.hoisted(() => ({
  copyToUploads: vi.fn(),
  pickFilesViaDialog: vi.fn(),
  listUploads: vi.fn(),
  cleanUploads: vi.fn(),
}));
vi.mock('../src/upload/manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/upload/manager.js')>();
  return { ...actual, ...managerMocks };
});
// clean 的 y/n 确认走 node:readline question，mock 掉避免阻塞
const questionMock = vi.hoisted(() => vi.fn());
vi.mock('node:readline', () => ({
  default: { createInterface: vi.fn(() => ({ question: questionMock, close: vi.fn() })) },
}));

import { uploadCommand } from '../src/commands/upload-command.js';
import type { UploadEntry, UploadResult } from '../src/upload/manager.js';

function makeEntry(fileName: string, bytes = 10): UploadEntry {
  return {
    originalPath: '',
    targetPath: `/root/${fileName}`,
    fileName,
    bytes,
    uploadedAt: '2026-10-12T07:30:01.000Z',
  };
}

function makeCtx(overrides: Partial<{ sessionId: string | null; noSessionStore: boolean }> = {}) {
  const agent = {
    currentSessionId: ('sessionId' in overrides ? overrides.sessionId : 'sess-1') as string | null,
    appendContextNote: vi.fn(),
    setCurrentSessionId: vi.fn((id: string | null) => {
      agent.currentSessionId = id;
    }),
  };
  const sessionStore = overrides.noSessionStore
    ? null
    : { createSession: vi.fn(async () => ({ id: 'sess-new' })) };
  const ctx = {
    agent,
    out: { log: vi.fn(), blank: vi.fn(), error: vi.fn() },
    rl: {},
    configLoader: {},
    configWriter: {},
    mcpManager: {},
    registry: {},
    skillLoader: {},
    sessionStore,
    colors: COLORS,
  };
  return { ctx: ctx as unknown as CommandContext, agent, out: ctx.out, sessionStore };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('match', () => {
  it('匹配 /upload 及子命令，不误匹配 /uploadx', () => {
    expect(uploadCommand.match('/upload')).toBe(true);
    expect(uploadCommand.match('/upload list')).toBe(true);
    expect(uploadCommand.match('/upload D:\\a.png')).toBe(true);
    expect(uploadCommand.match('/UPLOAD x')).toBe(true);
    expect(uploadCommand.match('/uploadx')).toBe(false);
    expect(uploadCommand.match('/up')).toBe(false);
  });
});

describe('带参上传', () => {
  it('复制后按成功项注入上下文，失败项打印原因', async () => {
    const { ctx, agent, out } = makeCtx();
    const result: UploadResult = {
      succeeded: [makeEntry('20261012-a.txt', 100)],
      failed: [{ path: 'nope.txt', reason: '文件不存在' }],
    };
    managerMocks.copyToUploads.mockResolvedValue(result);
    await uploadCommand.execute('/upload "D:\\a.txt" nope.txt', ctx);

    expect(managerMocks.copyToUploads).toHaveBeenCalledWith(
      ['D:\\a.txt', 'nope.txt'],
      { sessionKey: 'sess-1' },
    );
    expect(agent.appendContextNote).toHaveBeenCalledTimes(1);
    expect(agent.appendContextNote.mock.calls[0][0]).toContain('[文件上传] 20261012-a.txt');
    const printed = out.log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('✓');
    expect(printed).toContain('文件不存在');
    expect(printed).toContain('已注入会话上下文');
  });

  it('仅失败时不注入上下文', async () => {
    const { ctx, agent } = makeCtx();
    managerMocks.copyToUploads.mockResolvedValue({ succeeded: [], failed: [{ path: 'x', reason: '文件不存在' }] });
    await uploadCommand.execute('/upload x', ctx);
    expect(agent.appendContextNote).not.toHaveBeenCalled();
  });

  it('无活动会话时按需创建会话再上传（D10），不再报错', async () => {
    const { ctx, agent, sessionStore } = makeCtx({ sessionId: null });
    managerMocks.copyToUploads.mockResolvedValue({ succeeded: [], failed: [] });
    await uploadCommand.execute('/upload a.txt', ctx);
    expect(sessionStore!.createSession).toHaveBeenCalledTimes(1);
    expect(agent.setCurrentSessionId).toHaveBeenCalledWith('sess-new');
    expect(managerMocks.copyToUploads).toHaveBeenCalledWith(['a.txt'], { sessionKey: 'sess-new' });
    expect(agent.currentSessionId).toBe('sess-new');
  });

  it('会话功能不可用（sessionStore=null）时拒绝', async () => {
    const { ctx, out } = makeCtx({ sessionId: null, noSessionStore: true });
    await uploadCommand.execute('/upload a.txt', ctx);
    expect(managerMocks.copyToUploads).not.toHaveBeenCalled();
    expect(out.log.mock.calls.flat().join(' ')).toContain('会话功能未启用');
  });
});

describe('无参弹框（D9）', () => {
  it('选中路径进入上传链路', async () => {
    const { ctx } = makeCtx();
    managerMocks.pickFilesViaDialog.mockResolvedValue({ paths: ['/tmp/a.png', '/tmp/b.png'] });
    managerMocks.copyToUploads.mockResolvedValue({ succeeded: [], failed: [] });
    await uploadCommand.execute('/upload', ctx);
    expect(managerMocks.copyToUploads).toHaveBeenCalledWith(['/tmp/a.png', '/tmp/b.png'], { sessionKey: 'sess-1' });
  });

  it('取消提示「已取消」且不上传', async () => {
    const { ctx, out } = makeCtx();
    managerMocks.pickFilesViaDialog.mockResolvedValue({ paths: [], reason: 'cancelled' });
    await uploadCommand.execute('/upload', ctx);
    expect(managerMocks.copyToUploads).not.toHaveBeenCalled();
    expect(out.log.mock.calls.flat().join(' ')).toContain('已取消');
  });

  it('环境不可用给降级提示（拖拽 / 路径参数）', async () => {
    const { ctx, out } = makeCtx();
    managerMocks.pickFilesViaDialog.mockResolvedValue({ paths: [], reason: 'unavailable' });
    await uploadCommand.execute('/upload', ctx);
    expect(out.log.mock.calls.flat().join(' ')).toContain('拖拽文件到终端');
  });
});

describe('list / clean', () => {
  it('list 渲染条目（原名剥时间戳前缀、大小）', async () => {
    const { ctx, out } = makeCtx();
    managerMocks.listUploads.mockResolvedValue([
      makeEntry('20261012-153001-报告 v2.xlsx', 2048),
      makeEntry('20261012-153001-250-b.png'),
    ]);
    await uploadCommand.execute('/upload list', ctx);
    const printed = out.log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('报告 v2.xlsx');
    expect(printed).toContain('b.png');
    expect(printed).toContain('2.0KB');
    expect(managerMocks.listUploads).toHaveBeenCalledWith(expect.any(String), 'sess-1');
  });

  it('list 空目录友好提示', async () => {
    const { ctx, out } = makeCtx();
    managerMocks.listUploads.mockResolvedValue([]);
    await uploadCommand.execute('/upload list', ctx);
    expect(out.log.mock.calls.flat().join(' ')).toContain('暂无上传文件');
  });

  it('clean：y 确认后调用清理', async () => {
    const { ctx, out } = makeCtx();
    questionMock.mockImplementation((_q: string, cb: (a: string) => void) => cb('y'));
    managerMocks.cleanUploads.mockResolvedValue(true);
    await uploadCommand.execute('/upload clean', ctx);
    expect(managerMocks.cleanUploads).toHaveBeenCalledWith(expect.any(String), 'sess-1');
    expect(out.log.mock.calls.flat().join(' ')).toContain('已清理');
  });

  it('clean：n 取消不清理；无内容提示', async () => {
    const { ctx } = makeCtx();
    questionMock.mockImplementation((_q: string, cb: (a: string) => void) => cb('n'));
    await uploadCommand.execute('/upload clean', ctx);
    expect(managerMocks.cleanUploads).not.toHaveBeenCalled();

    questionMock.mockImplementation((_q: string, cb: (a: string) => void) => cb('y'));
    managerMocks.cleanUploads.mockResolvedValue(false);
    const ctx2 = makeCtx();
    await uploadCommand.execute('/upload clean', ctx2.ctx);
    expect(ctx2.out.log.mock.calls.flat().join(' ')).toContain('无上传文件');
  });

  it('list 无会话时按需创建会话再查询（D10）', async () => {
    const { ctx, sessionStore } = makeCtx({ sessionId: null });
    managerMocks.listUploads.mockResolvedValue([]);
    await uploadCommand.execute('/upload list', ctx);
    expect(sessionStore!.createSession).toHaveBeenCalledTimes(1);
    expect(managerMocks.listUploads).toHaveBeenCalledWith(expect.any(String), 'sess-new');
  });
});
