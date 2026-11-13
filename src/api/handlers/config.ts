// /config 命令资源化端点（Task-20261016-002 §3.2）
//
// 直调 configLoader（分层合成 + 来源解析）、configWriter（update / deleteKey）、
// maskSecretsDeep（遮蔽 secret，D3 补导出复用），CLI 命令层零改动。
// D6 动词即确认：PUT/DELETE 替代 CLI 的 askConfirm。
// 注意路由顺序：GET /config/path 静态段必须注册在 GET /config/:key 之前。
//
// 需求 20261112-008（D4）：配置作用域收敛为全局，工作空间级配置已移除。
// scope 参数仍被解析以给出可纠正的 400，而非静默落到全局。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { maskSecretsDeep } from '../../commands/config-command.js';
import { ConfigWriter } from '../../config/writer.js';
import type { PartialAgentConfig } from '../../config/schema.js';

/**
 * 校验 scope 参数（需求 20261112-008 / D4）。
 * 合法：省略 / null / '' / 'global'；'workspace' 及其它值 → 400。
 *
 * 之所以不静默忽略：静默落全局会让「写成功了」与「写到了别处」无法区分，
 * 旧客户端（含旧版 WebUI）能立刻发现并纠正。
 */
export function assertGlobalScope(raw: unknown): void {
  if (raw === undefined || raw === null || raw === '') return;
  if (raw === 'global') return;
  if (raw === 'workspace') {
    throw new ApiHttpError(
      'bad_request',
      '工作空间级配置已移除（需求 20261112-008），配置一律为全局；请去掉 scope 参数或使用 scope=global',
    );
  }
  throw new ApiHttpError('bad_request', `scope 仅支持 global（工作空间级已移除），收到: ${String(raw)}`);
}

/** 兼容旧名：项目内多处 import parseScope，语义已改为「仅校验全局」 */
export const parseScope = assertGlobalScope;

/** 取 query string 的 scope 原始值（未校验） */
export function queryScope(req: IncomingMessage): string | null {
  return new URL(req.url ?? '/', 'http://localhost').searchParams.get('scope');
}

/** GET /config：全量生效配置（secret 遮蔽） */
export async function handleGetConfig(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config } = ctx.configLoader.load();
  sendJson(res, 200, { config: maskSecretsDeep(config) });
}

/** GET /config/path：全局配置文件路径（工作空间配置已废弃，保留字段说明） */
export async function handleGetConfigPath(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    globalPath: ctx.configLoader.globalConfigPath,
    // 需求 20261112-008：工作空间级配置已移除，这两个字段恒为 null/false
    workspacePath: null,
    workspaceExists: false,
  });
}

/** GET /config/:key：单键读取（来源 + secret 遮蔽；键不存在 404） */
export async function handleGetConfigKey(ctx: HandlerContext, res: ServerResponse, key: string): Promise<void> {
  const { config, sources } = ctx.configLoader.load();
  const value = ConfigWriter.getByKey(config as unknown as Record<string, unknown>, key);
  if (value === undefined) throw new ApiHttpError('not_found', `配置键不存在: ${key}`);
  const leafKey = key.split('.').pop() ?? '';
  sendJson(res, 200, { key, value: maskSecretsDeep(value, leafKey), scope: sources[key] ?? 'default' });
}

/** PUT /config/:key：写单键（D6 动词即确认）；api.* 写入后附 restartRequired */
export async function handlePutConfigKey(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!('value' in body)) throw new ApiHttpError('bad_request', '请求体必须包含 value 字段');
  assertGlobalScope(body.scope);

  const partial: PartialAgentConfig = {};
  ConfigWriter.setByKey(partial as Record<string, unknown>, key, body.value);
  await ctx.configWriter.update(partial);
  ctx.log(`[api] 配置已写入（global）: ${key}`);

  // api 段（token/host/port）写入后需重启服务才生效（001 已注明）
  const restartRequired = key === 'api' || key.startsWith('api.');
  sendJson(res, 200, {
    key,
    scope: 'global',
    value: body.value,
    ...(restartRequired ? { restartRequired: true } : {}),
  });
}

/** DELETE /config/:key：删单键；deleteKey 无返回值，先自行判存在 */
export async function handleDeleteConfigKey(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
): Promise<void> {
  assertGlobalScope(queryScope(req));
  const current = await ctx.configLoader.loadGlobal();
  const existed = ConfigWriter.getByKey(current as Record<string, unknown>, key) !== undefined;
  if (existed) {
    await ctx.configWriter.deleteKey(ConfigWriter.parseKey(key));
    ctx.log(`[api] 配置已删除（global）: ${key}`);
  }
  sendJson(res, 200, { key, scope: 'global', deleted: existed });
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
