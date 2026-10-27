// GET /status：REPL 内联 /status 的 API 版轻量快照（Task-20261016-002 §3.10）
//
// 组装各模块即时状态，读快照不触发重 IO（skills 扫描、MCP 连接等均不在此触发）。
// session.current 在 API 模式固定 null（无共享 agent 的「当前会话」概念，001 D5 隔离哲学）。

import { readdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext, Route } from '../router.js';
import { sendJson } from '../http-utils.js';
import { registry } from '../../tools/registry.js';

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
  // 需求 20261027-004：会话数取缺省空间（最近使用）；无 registry（既有单测）回落 deps.sessionStore
  const [sessions, uploadDirs] = await Promise.all([
    ctx.registry
      ? ctx.resolveDefaultRuntime().then((rt) => rt.store.listSessions())
      : ctx.deps.sessionStore.listSessions(),
    readdir(ctx.uploadsRoot, { withFileTypes: true }).catch(() => []),
  ]);

  sendJson(res, 200, {
    version: ctx.version ?? '',
    model: {
      alias: cfg.models.active || null,
      provider: hostnameOf(cfg.model.baseUrl),
      model: cfg.model.name,
    },
    session: { current: null, count: sessions.length },
    tools: {
      total: registry.list().length,
      disabled: cfg.tools.disabled.length,
    },
    mcp: { connected: ctx.mcpManager.listConnected().length },
    memory: { enabled: cfg.memory.enabled },
    uploads: { count: uploadDirs.filter((d) => d.isDirectory()).length },
  });
}

export function statusRoutes(): Route[] {
  return [
    { method: 'GET', path: '/status', handler: (ctx, req, res) => handleStatus(ctx, req, res) },
  ];
}
