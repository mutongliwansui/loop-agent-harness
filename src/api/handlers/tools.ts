// /tools 命令资源化端点（Task-20261016-002 §3.3）
//
// 直调 registerBuiltinTools / BUILTIN_TOOL_MAP / registry（D3 补导出复用），CLI 命令层零改动。
// enabled 判定与 registerBuiltinTools 过滤口径一致：enabled 非空白名单 + disabled 排除。
// D6 动词即确认：PATCH 替代 CLI 的 enable/disable（无 y/N）。
// 注意路由顺序：POST /tools/reload 静态段必须注册在 GET|PATCH /tools/:name 之前。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentConfig } from '../../config/schema.js';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { BUILTIN_TOOL_MAP, BUILTIN_TOOL_NAMES } from '../../commands/tools-command.js';
import { registerBuiltinTools } from '../../tools/index.js';
import { registry } from '../../tools/registry.js';
import { assertGlobalScope } from './config.js';

import { VISION_TOOL_NAMES } from '../../tools/vision/tools.js';
import { shouldRegisterOcrTools } from '../../tools/index.js';
import { OCR_TOOL_NAMES } from '../../tools/ocrImage.js';

/** 视觉工具名集合：仅 vision.enabled 时可见（与 registerBuiltinTools 门控一致） */
const VISION_TOOL_SET: ReadonlySet<string> = new Set(VISION_TOOL_NAMES);

/** OCR 工具名集合：仅 ocr.enabled 且本机有可用引擎时可见（与 shouldRegisterOcrTools 同口径） */
const OCR_TOOL_SET: ReadonlySet<string> = new Set(OCR_TOOL_NAMES);

/** 工具是否对当前配置可见（视觉/OCR 为条件注册，其余恒可用） */
function toolVisible(cfg: AgentConfig, name: string): boolean {
  if (VISION_TOOL_SET.has(name)) return cfg.vision.enabled === true;
  if (OCR_TOOL_SET.has(name)) return shouldRegisterOcrTools(cfg.ocr);
  return true;
}

interface ToolMeta {
  name: string;
  description: string;
  parameters: unknown;
}

/** 内置工具按当前配置是否生效（与 registerBuiltinTools 过滤逻辑同口径） */
function builtinEnabled(cfg: AgentConfig, name: string): boolean {
  const { enabled, disabled } = cfg.tools;
  return (enabled.length === 0 || enabled.includes(name)) && !disabled.includes(name);
}

/** GET /tools：内置（vision 门控）+ MCP 工具快照 */
async function handleListTools(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  const tools = BUILTIN_TOOL_NAMES
    .filter((n) => toolVisible(cfg, n))
    .map((n) => {
      const t = BUILTIN_TOOL_MAP[n] as ToolMeta;
      return { name: t.name, description: t.description, enabled: builtinEnabled(cfg, t.name), source: 'builtin' };
    });
  for (const t of registry.list()) {
    if (t.name.includes('__')) {
      tools.push({ name: t.name, description: t.description, enabled: true, source: 'mcp' });
    }
  }
  sendJson(res, 200, { tools });
}

/** GET /tools/:name：单工具详情（内置含 schema；MCP 工具恒 enabled） */
async function handleGetTool(ctx: HandlerContext, res: ServerResponse, name: string): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  const builtin = BUILTIN_TOOL_MAP[name] as ToolMeta | undefined;
  if (builtin) {
    sendJson(res, 200, {
      name: builtin.name,
      description: builtin.description,
      enabled: builtinEnabled(cfg, name),
      source: 'builtin',
      schema: builtin.parameters,
    });
    return;
  }
  const mcpTool = registry.list().find((t) => t.name === name && t.name.includes('__'));
  if (mcpTool) {
    sendJson(res, 200, {
      name: mcpTool.name,
      description: mcpTool.description,
      enabled: true,
      source: 'mcp',
      schema: mcpTool.parameters,
    });
    return;
  }
  throw new ApiHttpError('not_found', `工具不存在: ${name}`);
}

/** PATCH /tools/:name：启用/禁用内置工具（落盘 + registry 同步，与 CLI enable/disable 同写法） */
async function handlePatchTool(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
): Promise<void> {
  if (name.includes('__')) {
    throw new ApiHttpError('bad_request', 'MCP 工具不支持 enable/disable，请用 DELETE /mcp/servers/:name 移除');
  }
  if (!BUILTIN_TOOL_NAMES.includes(name)) {
    throw new ApiHttpError('not_found', `内置工具不存在: ${name}（可用: ${BUILTIN_TOOL_NAMES.join(', ')}）`);
  }
  const body = await readJsonBody(req);
  if (typeof body.enabled !== 'boolean') {
    throw new ApiHttpError('bad_request', '请求体必须包含 enabled 布尔字段');
  }
  assertGlobalScope(body.scope);
  const enable = body.enabled;

  const { config: cfg } = ctx.configLoader.load();
  const enabled = cfg.tools.enabled.length > 0 ? [...cfg.tools.enabled] : [...BUILTIN_TOOL_NAMES];
  const disabled = cfg.tools.disabled.length > 0 ? [...cfg.tools.disabled] : [];

  if (enable) {
    if (!enabled.includes(name)) enabled.push(name);
    const di = disabled.indexOf(name);
    if (di >= 0) disabled.splice(di, 1);
  } else {
    const ei = enabled.indexOf(name);
    if (ei >= 0) enabled.splice(ei, 1);
    if (!disabled.includes(name)) disabled.push(name);
  }

  await ctx.configWriter.update({ tools: { enabled, disabled } });

  // registry 同步（与 CLI /tools enable|disable 一致，运行时立即生效）
  if (enable) {
    const t = BUILTIN_TOOL_MAP[name];
    if (t && !registry.has(name)) registry.register(t as never);
  } else if (registry.has(name)) {
    registry.unregister(name);
  }
  ctx.log(`[api] 工具已${enable ? '启用' : '禁用'}（global）: ${name}`);
  sendJson(res, 200, { name, enabled: enable, scope: 'global' });
}

/** POST /tools/reload：重载全部工具（清空 registry → 重注册内置 → 重连 MCP） */
async function handleReloadTools(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  await ctx.mcpManager.disconnectAll();
  registry.clear();
  const built = registerBuiltinTools(cfg.tools, cfg.vision, cfg.ocr);
  const mcp = await ctx.mcpManager.loadFromConfig();
  if (mcp.failures.length > 0) ctx.log(`[api] MCP 重连失败: ${mcp.failures.join(', ')}`);
  ctx.log(`[api] 工具已重新加载: 内置 ${built.length}，MCP 成功 ${mcp.successes.length}`);
  sendJson(res, 200, { reloaded: built.length + mcp.successes.length });
}

export function toolsRoutes(): Route[] {
  return [
    { method: 'GET', path: '/tools', handler: (ctx, _req, res) => handleListTools(ctx, _req, res) },
    { method: 'POST', path: '/tools/reload', handler: (ctx, _req, res) => handleReloadTools(ctx, _req, res) },
    { method: 'GET', path: '/tools/:name', handler: (ctx, _req, res, p) => handleGetTool(ctx, res, p.name) },
    { method: 'PATCH', path: '/tools/:name', handler: (ctx, req, res, p) => handlePatchTool(ctx, req, res, p.name) },
  ];
}
