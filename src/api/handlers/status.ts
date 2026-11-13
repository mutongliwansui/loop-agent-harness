// GET /status：REPL 内联 /status 的 API 版轻量快照（Task-20261016-002 §3.10）
//
// 组装各模块即时状态，读快照不触发重 IO（skills 扫描、MCP 连接等均不在此触发）。
// session.current 在 API 模式固定 null（无共享 agent 的「当前会话」概念，001 D5 隔离哲学）。

import { readdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext, Route } from '../router.js';
import { sendJson } from '../http-utils.js';
import { registry } from '../../tools/registry.js';
import { getMcpMonitor } from '../../config/mcp-monitor.js';

/** 从 baseUrl 提取 provider 主机名（如 https://api.deepseek.com/v1 → api.deepseek.com） */
export function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

export async function handleStatus(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = ctx.deps.getConfig();
  // 需求 20261113-001 D5：会话数改为**全空间合计**。
  // 原实现取「缺省空间（最近使用）」的会话数——/status 是应用级概览，
  // 用某一个空间的会话数既不完整也会随用户上次活动漂移。
  const [sessionCount, uploadDirs] = await Promise.all([
    ctx.registry
      ? ctx.deps.sessionStore
          .listAllWorkspaces()
          .then((all) => all.reduce((n, w) => n + w.sessions.length, 0))
          .catch(() => 0)
      : ctx.deps.sessionStore.listSessions().then((list) => list.length),
    readdir(ctx.uploadsRoot, { withFileTypes: true }).catch(() => []),
  ]);

  sendJson(res, 200, {
    version: ctx.version ?? '',
    model: {
      alias: cfg.models.active || null,
      provider: hostnameOf(cfg.model.baseUrl),
      model: cfg.model.name,
    },
    session: { current: null, count: sessionCount },
    tools: {
      total: registry.list().length,
      disabled: cfg.tools.disabled.length,
    },
    mcp: {
      connected: ctx.mcpManager.listConnected().length,
      // serve 模式才有监测器：configured=配置声明的总数，failed=当前处于重试退避的个数
      configured: cfg.tools.mcpServers ? Object.keys(cfg.tools.mcpServers).length : 0,
      failed: getMcpMonitor()?.snapshot().filter((s) => s.state === 'failed').length ?? 0,
    },
    memory: { enabled: cfg.memory.enabled },
    uploads: { count: uploadDirs.filter((d) => d.isDirectory()).length },
  });
}

export function statusRoutes(): Route[] {
  return [
    { method: 'GET', path: '/status', handler: (ctx, req, res) => handleStatus(ctx, req, res) },
  ];
}
