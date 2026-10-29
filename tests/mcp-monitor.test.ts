// McpMonitor 调度逻辑单测：配置 diff / 失败退避 / 退避到期重试
//
// 不建立真实 MCP 连接：用伪 MCPManager + 伪 ConfigLoader 驱动 pump，
// 通过 snapshot() 观察状态机（探活分支依赖真实 registry 连接，此处不覆盖）。
import { describe, it, expect, vi } from 'vitest';
import { McpMonitor } from '../src/config/mcp-monitor.js';
import type { ConfigLoader } from '../src/config/loader.js';
import type { MCPManager } from '../src/config/mcp-manager.js';
import type { MCPServerConfig } from '../src/tools/mcp/client.js';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function loaderWith(servers: Record<string, MCPServerConfig>): ConfigLoader {
  return { load: () => ({ config: { tools: { mcpServers: servers } } }) } as unknown as ConfigLoader;
}

function managerWith(loadServer: (name: string, cfg: MCPServerConfig) => Promise<string[]>): MCPManager {
  return { loadServer } as unknown as MCPManager;
}

const stdio = { type: 'stdio', command: 'node' } as MCPServerConfig;

describe('McpMonitor：失败退避', () => {
  it('连接失败 → failed + 指数退避，退避窗口内不重复连接', async () => {
    let calls = 0;
    const loadServer = vi.fn(async () => {
      calls += 1;
      throw new Error('boom');
    });
    const mon = new McpMonitor(managerWith(loadServer), loaderWith({ a: stdio }), {
      intervalMs: 15,
      retryBaseMs: 60_000,
      log: () => {},
    });
    mon.start();
    await wait(80);
    mon.stop();

    expect(calls).toBe(1);
    const st = mon.statusOf('a');
    expect(st?.state).toBe('failed');
    expect(st?.retries).toBe(1);
    expect(st?.lastError).toContain('boom');
    expect(st?.nextRetryAt).toBeGreaterThan(Date.now());
  });

  it('退避到期后自动重试（retries 递增）', async () => {
    let calls = 0;
    const loadServer = async (): Promise<string[]> => {
      calls += 1;
      throw new Error('still down');
    };
    const mon = new McpMonitor(managerWith(loadServer), loaderWith({ a: stdio }), {
      intervalMs: 20,
      retryBaseMs: 20,
      retryMaxMs: 20,
      log: () => {},
    });
    mon.start();
    await wait(120);
    mon.stop();

    const st = mon.statusOf('a');
    expect(calls).toBeGreaterThan(1);
    expect(st?.retries).toBeGreaterThan(1);
  });

  it('配置移除后从快照消失，不再重连', async () => {
    const servers: Record<string, MCPServerConfig> = { a: stdio };
    let calls = 0;
    const loadServer = async (): Promise<string[]> => {
      calls += 1;
      throw new Error('boom');
    };
    // loader 返回可变引用：模拟配置文件被删
    const loader = { load: () => ({ config: { tools: { mcpServers: servers } } }) } as unknown as ConfigLoader;
    const mon = new McpMonitor(managerWith(loadServer), loader, {
      intervalMs: 20,
      retryBaseMs: 20,
      log: () => {},
    });
    mon.start();
    await wait(40);
    delete servers.a;
    await wait(60);
    mon.stop();

    expect(mon.snapshot()).toEqual([]);
  });
});
