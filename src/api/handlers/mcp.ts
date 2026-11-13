// /mcp 命令资源化端点（Task-20261016-002 §3.5）
//
// 直调 MCPManager（loadServer/unloadServer/reload/testServer/viewServer）+ configWriter，CLI 命令层零改动。
// CLI add 的交互问答由请求体一次性承接（§3.5 注）；D6 动词即确认。
// 验收 6.7：DELETE 先断连（unloadServer）再删配置（deleteScopeKey），避免「配置已删但进程仍连接」。
// 错误边界：同名 409；连接失败 502（配置已落盘，message 附 status）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { normalizeMcpTransportType } from '../../tools/mcp/client.js';
import type { MCPServerConfig } from '../../tools/mcp/client.js';
import { registry } from '../../tools/registry.js';
import { getMcpMonitor } from '../../config/mcp-monitor.js';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { assertGlobalScope, queryScope } from './config.js';

/** 从合并配置取指定 server（不存在 → 404） */
function requireServerCfg(ctx: HandlerContext, name: string): MCPServerConfig {
  const { config: cfg } = ctx.configLoader.load();
  const server = cfg.tools.mcpServers[name];
  if (!server) throw new ApiHttpError('not_found', `MCP server 不存在: ${name}`);
  return server;
}

/** 已连接 server 的已注册工具数（未连接为 0） */
function toolCountFor(name: string): number {
  const prefix = `${name}__`;
  return registry.list().filter((t) => t.name.startsWith(prefix)).length;
}

/** GET /mcp/servers：合并配置全量 + 实时连接状态（serve 模式附监测器运行态） */
async function handleListServers(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config: cfg, sources } = ctx.configLoader.load();
  const connected = new Set(ctx.mcpManager.listConnected());
  // 监测器可能不存在（CLI 模式或单测未启动 serve）：此时只返回连接的二态
  const runtime = new Map((getMcpMonitor()?.snapshot() ?? []).map((s) => [s.name, s]));
  const servers = Object.entries(cfg.tools.mcpServers).map(([name, s]) => {
    const rt = runtime.get(name);
    return {
      name,
      transport: s.type,
      // D9：来源范围随列表返回，前端据此显示徽标并默认移除范围
      // 需求 20261112-008：配置只剩全局一份，scope 恒为 global
      scope: 'global',
      status: connected.has(name) ? 'connected' : 'disconnected',
      toolCount: toolCountFor(name),
      // connecting/failed 时 status 仍是 disconnected，这两个字段用于排障与前端提示
      state: rt?.state ?? (connected.has(name) ? 'connected' : 'pending'),
      ...(rt?.lastError ? { lastError: rt.lastError } : {}),
      ...(rt?.nextRetryAt ? { nextRetryAt: rt.nextRetryAt } : {}),
    };
  });
  sendJson(res, 200, { servers });
}

/** GET /mcp/servers/:name：详情 + 工具清单（未连接时走临时连接查询，与 CLI view 同款） */
async function handleGetServer(ctx: HandlerContext, res: ServerResponse, name: string): Promise<void> {
  const server = requireServerCfg(ctx, name);
  const view = await ctx.mcpManager.viewServer(name, server);
  if (!view.ok) {
    throw new ApiHttpError('bad_gateway', `查询失败: ${view.message ?? '未知错误'}`);
  }
  sendJson(res, 200, {
    name,
    transport: server.type,
    status: view.connected ? 'connected' : 'disconnected',
    tools: view.tools,
  });
}

/** 请求体 → MCPServerConfig（transport 归一 + 必填校验，与 CLI add 的 cfg 构造同口径） */
function parseServerBody(body: Record<string, unknown>): MCPServerConfig {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || /\s/.test(name)) {
    throw new ApiHttpError('bad_request', 'name 必填且不能含空白');
  }
  const type = normalizeMcpTransportType(String(body.transport ?? ''));
  if (!type) {
    throw new ApiHttpError('bad_request', `transport 必须为 stdio | sse | http（或 streamableHttp），收到: ${String(body.transport ?? '')}`);
  }
  if (type === 'stdio') {
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command) throw new ApiHttpError('bad_request', 'stdio 传输必须提供 command');
    const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === 'string') : [];
    const env = typeof body.env === 'object' && body.env !== null
      ? Object.fromEntries(
        Object.entries(body.env as Record<string, unknown>)
          .filter((e) => typeof e[1] === 'string')
          .map(([k, v]) => [k, v as string]),
      )
      : undefined;
    return {
      type: 'stdio',
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) throw new ApiHttpError('bad_request', `${type} 传输必须提供 url`);
  if (type === 'sse') return { type: 'sse', url };
  const headers = typeof body.headers === 'object' && body.headers !== null
    ? Object.fromEntries(
      Object.entries(body.headers as Record<string, unknown>)
        .filter((e) => typeof e[1] === 'string')
        .map(([k, v]) => [k, v as string]),
    )
    : undefined;
  return {
    type: 'streamableHttp',
    url,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/** POST /mcp/servers：登记 + 自动连接（同名 409；连接失败 502 但配置已落盘） */
async function handleCreateServer(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const server = parseServerBody(body);
  assertGlobalScope(body.scope);

  const { config: cfg } = ctx.configLoader.load();
  if (cfg.tools.mcpServers[name] !== undefined) {
    throw new ApiHttpError('conflict', `MCP server「${name}」已存在。如需修改可先 DELETE /mcp/servers/${name} 再重新登记`);
  }

  await ctx.configWriter.update({ tools: { mcpServers: { [name]: server } } });
  try {
    const tools = await ctx.mcpManager.loadServer(name, server);
    ctx.log(`[api] MCP server 已登记并连接（global）: ${name}（${tools.length} 个工具）`);
    sendJson(res, 201, { name, scope: 'global', transport: server.type, status: 'connected', toolCount: tools.length });
  } catch (e) {
    // 配置已落盘但连接失败：502 + message 附 status（§五边界）
    const msg = e instanceof Error ? e.message : String(e);
    throw new ApiHttpError('bad_gateway', `MCP 连接失败（配置已落盘，status: disconnected）: ${msg}`);
  }
}

/** DELETE /mcp/servers/:name?scope=：先断连再删配置（验收 6.7 反序） */
async function handleDeleteServer(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
): Promise<void> {
  assertGlobalScope(queryScope(req));
  // 配置只剩全局一份，直接判定全局是否存在（旧版「按范围判存在」的双层逻辑已无用）
  const layer = await ctx.configLoader.loadGlobal();
  const existed = layer.tools?.mcpServers?.[name] !== undefined;
  if (existed) {
    await ctx.mcpManager.unloadServer(name);
    await ctx.configWriter.deleteKey(['tools', 'mcpServers', name]);
    ctx.log(`[api] MCP server 已断连并移除（global）: ${name}`);
  }
  sendJson(res, 200, { name, scope: 'global', deleted: existed });
}

/** POST /mcp/reload：全部断连重连（热更新）；failed 提取 server 名 */
async function handleReloadServers(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const result = await ctx.mcpManager.reload();
  ctx.log(`[api] MCP 已重载: 成功 ${result.successes.length}，失败 ${result.failures.length}`);
  sendJson(res, 200, {
    reconnected: result.successes.length,
    failed: result.failures.map((f) => f.split(':')[0]),
  });
}

/** POST /mcp/servers/:name/test：临时连接探测（与 CLI test 同款，不影响已注册工具） */
async function handleTestServer(ctx: HandlerContext, res: ServerResponse, name: string): Promise<void> {
  const server = requireServerCfg(ctx, name);
  const start = Date.now();
  const result = await ctx.mcpManager.testServer(name, server);
  const latencyMs = Date.now() - start;
  if (result.ok) {
    const m = /（(\d+) 个工具）/.exec(result.message);
    sendJson(res, 200, { ok: true, latencyMs, tools: m ? Number(m[1]) : 0 });
  } else {
    sendJson(res, 200, { ok: false, latencyMs, tools: 0, error: result.message });
  }
}

/**
 * GET /mcp/tool-meta：MCP 工具展示元信息（需求 20261104-001）
 *
 * 只服务 UI（ToolCard/LiveStatus 的中文名、参数标签、来源徽标），
 * 与 toOpenAITools() 完全无关（D9）。无 server 连接时返回空表且不 404。
 */
async function handleToolMeta(_ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tools = registry.mcpToolMeta();
  const summary = {
    total: tools.length,
    titled: tools.filter((t) => t.nameSource === 'title').length,
    cjk: tools.filter((t) => t.nameSource === 'cjk').length,
    translated: tools.filter((t) => t.nameSource === 'translate').length,
    named: tools.filter((t) => !!t.zhName).length,
    pending: tools.filter((t) => t.translate === 'pending').length,
    failed: tools.filter((t) => t.translate === 'failed').length,
  };
  sendJson(res, 200, { tools, summary });
}

export function mcpRoutes(): Route[] {
  return [
    { method: 'GET', path: '/mcp/tool-meta', handler: (ctx, req, res) => handleToolMeta(ctx, req, res) },
    { method: 'GET', path: '/mcp/servers', handler: (ctx, _req, res) => handleListServers(ctx, _req, res) },
    { method: 'POST', path: '/mcp/reload', handler: (ctx, _req, res) => handleReloadServers(ctx, _req, res) },
    { method: 'GET', path: '/mcp/servers/:name', handler: (ctx, _req, res, p) => handleGetServer(ctx, res, p.name) },
    { method: 'POST', path: '/mcp/servers', handler: (ctx, req, res) => handleCreateServer(ctx, req, res) },
    { method: 'POST', path: '/mcp/servers/:name/test', handler: (ctx, _req, res, p) => handleTestServer(ctx, res, p.name) },
    { method: 'DELETE', path: '/mcp/servers/:name', handler: (ctx, req, res, p) => handleDeleteServer(ctx, req, res, p.name) },
  ];
}
