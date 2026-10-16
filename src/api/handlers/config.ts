// /config 命令资源化端点（Task-20261016-002 §3.2）
//
// 直调 configLoader（分层合成 + 来源解析）、configWriter（updateScope / deleteScopeKey）、
// maskSecretsDeep（遮蔽 secret，D3 补导出复用），CLI 命令层零改动。
// D6 动词即确认：PUT/DELETE 替代 CLI 的 askConfirm。
// 注意路由顺序：GET /config/path 静态段必须注册在 GET /config/:key 之前。

import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { maskSecretsDeep } from '../../commands/config-command.js';
import { ConfigWriter, type ConfigScope } from '../../config/writer.js';
import type { PartialAgentConfig } from '../../config/schema.js';

const SCOPES: ReadonlySet<string> = new Set(['workspace', 'global']);

/** 解析 scope 参数：缺省 workspace；非法值 → 400（/config 与命令资源化各组共用） */
export function parseScope(raw: unknown): ConfigScope {
  if (raw === undefined || raw === null || raw === '') return 'workspace';
  if (typeof raw === 'string' && SCOPES.has(raw)) return raw as ConfigScope;
  throw new ApiHttpError('bad_request', `scope 必须为 workspace 或 global，收到: ${String(raw)}`);
}

/** 取 query string 的 scope 原始值（未校验） */
export function queryScope(req: IncomingMessage): string | null {
  return new URL(req.url ?? '/', 'http://localhost').searchParams.get('scope');
}

/** GET /config：全量生效配置（secret 遮蔽） */
export async function handleGetConfig(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config } = ctx.configLoader.load();
  sendJson(res, 200, { config: maskSecretsDeep(config) });
}

/** GET /config/path：全局 / 工作空间配置文件路径 */
export async function handleGetConfigPath(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const workspacePath = ctx.configLoader.workspaceConfigPath;
  sendJson(res, 200, {
    globalPath: ctx.configLoader.globalConfigPath,
    workspacePath,
    workspaceExists: existsSync(workspacePath),
  });
}

/** GET /config/:key：单键读取（scope 来源 + secret 遮蔽；键不存在 404） */
export async function handleGetConfigKey(ctx: HandlerContext, res: ServerResponse, key: string): Promise<void> {
  const { config, sources } = ctx.configLoader.load();
  const value = ConfigWriter.getByKey(config as unknown as Record<string, unknown>, key);
  if (value === undefined) throw new ApiHttpError('not_found', `配置键不存在: ${key}`);
  const leafKey = key.split('.').pop() ?? '';
  sendJson(res, 200, { key, value: maskSecretsDeep(value, leafKey), scope: sources[key] ?? 'default' });
}

/** PUT /config/:key：写单键到指定 scope（D6 动词即确认）；api.* 写入后附 restartRequired */
export async function handlePutConfigKey(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!('value' in body)) throw new ApiHttpError('bad_request', '请求体必须包含 value 字段');
  const scope = parseScope(body.scope);

  const partial: PartialAgentConfig = {};
  ConfigWriter.setByKey(partial as Record<string, unknown>, key, body.value);
  await ctx.configWriter.updateScope(scope, partial);
  ctx.log(`[api] 配置已写入（${scope}）: ${key}`);

  // api 段（token/host/port）写入后需重启服务才生效（001 已注明）
  const restartRequired = key === 'api' || key.startsWith('api.');
  sendJson(res, 200, { key, scope, value: body.value, ...(restartRequired ? { restartRequired: true } : {}) });
}

/** DELETE /config/:key?scope=：从指定 scope 删单键；deleteScopeKey 无返回值，先自行判存在 */
export async function handleDeleteConfigKey(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): Promise<void> {
  const scope = parseScope(queryScope(req));
  const current = scope === 'workspace'
    ? await ctx.configLoader.loadWorkspace()
    : await ctx.configLoader.loadGlobal();
  const existed = ConfigWriter.getByKey(current as Record<string, unknown>, key) !== undefined;
  if (existed) {
    await ctx.configWriter.deleteScopeKey(scope, ConfigWriter.parseKey(key));
    ctx.log(`[api] 配置已删除（${scope}）: ${key}`);
  }
  sendJson(res, 200, { key, scope, deleted: existed });
}

export function configRoutes(): Route[] {
  return [
    { method: 'GET', path: '/config', handler: (ctx, _req, res) => handleGetConfig(ctx, _req, res) },
    { method: 'GET', path: '/config/path', handler: (ctx, _req, res) => handleGetConfigPath(ctx, _req, res) },
    { method: 'GET', path: '/config/:key', handler: (ctx, _req, res, p) => handleGetConfigKey(ctx, res, p.key) },
    { method: 'PUT', path: '/config/:key', handler: (ctx, req, res, p) => handlePutConfigKey(ctx, req, res, p.key) },
    { method: 'DELETE', path: '/config/:key', handler: (ctx, req, res, p) => handleDeleteConfigKey(ctx, req, res, p.key) },
  ];
}
