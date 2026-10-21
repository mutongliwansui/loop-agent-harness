// /mcp view 单测（MCPManager.viewServer）
// 覆盖：已连接直接读注册表（不重连）、未连接临时连接后断开、连接失败、无工具、前缀过滤
import { describe, it, expect, vi, beforeEach } from 'vitest';

const registryMocks = vi.hoisted(() => ({
  listMCPServers: vi.fn(),
  registerMCPServer: vi.fn(),
  disconnectMCPServer: vi.fn(),
  list: vi.fn(),
}));

vi.mock('../src/tools/registry.js', () => ({ registry: registryMocks }));

import { MCPManager } from '../src/config/mcp-manager.js';

describe('MCPManager.loadServers（D19：stdio cwd 显式化）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registryMocks.listMCPServers.mockReturnValue([]);
    registryMocks.registerMCPServer.mockResolvedValue([]);
  });

  it('stdio 未配置 cwd → 显式补启动目录，不依赖隐式 process.cwd()', async () => {
    const mgr = new MCPManager();
    await mgr.loadServers({ demo: { type: 'stdio', command: 'npx' } });

    expect(registryMocks.registerMCPServer).toHaveBeenCalledWith('demo', {
      type: 'stdio',
      command: 'npx',
      cwd: process.cwd(),
    });
  });

  it('stdio 显式 cwd 保留原值', async () => {
    const mgr = new MCPManager();
    await mgr.loadServers({
      demo: { type: 'stdio', command: 'npx', cwd: '/custom/root' },
    });

    expect(registryMocks.registerMCPServer).toHaveBeenCalledWith('demo', {
      type: 'stdio',
      command: 'npx',
      cwd: '/custom/root',
    });
  });

  it('非 stdio 传输不注入 cwd', async () => {
    const mgr = new MCPManager();
    await mgr.loadServers({
      demo: { type: 'streamableHttp', url: 'https://host/mcp' },
    });

    expect(registryMocks.registerMCPServer).toHaveBeenCalledWith('demo', {
      type: 'streamableHttp',
      url: 'https://host/mcp',
    });
  });
});

describe('MCPManager.viewServer（/mcp view）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('已连接：直接读注册表并按前缀过滤，不重连、不断开', async () => {
    registryMocks.listMCPServers.mockReturnValue(['demo']);
    registryMocks.list.mockReturnValue([
      { name: 'demo__search', description: '搜索' },
      { name: 'demo__create', description: '创建' },
      { name: 'other__x', description: '其他服务的工具' },
    ]);
    const mgr = new MCPManager();

    const res = await mgr.viewServer('demo', { type: 'stdio', command: 'npx' });

    expect(res.ok).toBe(true);
    expect(res.connected).toBe(true);
    expect(res.tools).toEqual([
      { name: 'demo__search', description: '搜索' },
      { name: 'demo__create', description: '创建' },
    ]);
    expect(registryMocks.registerMCPServer).not.toHaveBeenCalled();
    expect(registryMocks.disconnectMCPServer).not.toHaveBeenCalled();
  });

  it('未连接：临时连接查询工具清单后立即断开', async () => {
    registryMocks.listMCPServers.mockReturnValue([]);
    registryMocks.registerMCPServer.mockResolvedValue(['demo__search']);
    registryMocks.list.mockReturnValue([{ name: 'demo__search', description: '搜索' }]);
    const mgr = new MCPManager();

    const res = await mgr.viewServer('demo', { type: 'streamableHttp', url: 'https://host/mcp' });

    expect(res.ok).toBe(true);
    expect(res.connected).toBe(false);
    expect(res.tools).toEqual([{ name: 'demo__search', description: '搜索' }]);
    expect(registryMocks.registerMCPServer).toHaveBeenCalledTimes(1);
    expect(registryMocks.disconnectMCPServer).toHaveBeenCalledWith('demo');
  });

  it('未连接且连接失败：返回 ok:false 与错误信息，不做断开', async () => {
    registryMocks.listMCPServers.mockReturnValue([]);
    registryMocks.registerMCPServer.mockRejectedValue(new Error('连接失败: boom'));
    const mgr = new MCPManager();

    const res = await mgr.viewServer('demo', { type: 'stdio', command: 'npx' });

    expect(res.ok).toBe(false);
    expect(res.connected).toBe(false);
    expect(res.tools).toEqual([]);
    expect(res.message).toContain('boom');
    expect(registryMocks.disconnectMCPServer).not.toHaveBeenCalled();
  });

  it('服务无工具：ok:true 且工具为空数组', async () => {
    registryMocks.listMCPServers.mockReturnValue(['demo']);
    registryMocks.list.mockReturnValue([]);
    const mgr = new MCPManager();

    const res = await mgr.viewServer('demo', { type: 'sse', url: 'https://host/sse' });

    expect(res.ok).toBe(true);
    expect(res.tools).toEqual([]);
  });
});
