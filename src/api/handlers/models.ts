// /model 命令资源化端点（Task-20261016-002 §3.4）
//
// 直调 buildUsePartial / readLayerRaw / validAlias / maskKey（D3 补导出复用）+
// defaultCheckConnectivity（连通性测试），CLI 命令层零改动。
// 响应字段以实际 schema 为准：ModelProfile = {name, baseUrl, apiKey, temperature?}（apiKey 遮蔽输出）。
// D6 动词即确认：PUT /model 替代 CLI use；DELETE 删当前激活 → 409（比 CLI 确认更严格）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ModelProfile, PartialAgentConfig } from '../../config/schema.js';
import { defaultCheckConnectivity } from '../../llm/connectivity.js';
import {
  buildUsePartial,
  maskKey,
  readLayerRaw,
  validAlias,
} from '../../commands/model-command.js';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { parseScope, queryScope } from './config.js';

function scopeName(scope: string): string {
  return scope === 'workspace' ? '工作空间' : '全局';
}

/** 校验请求体中的 profile：name/baseUrl/apiKey 必填非空字符串，temperature 可选数字 */
function parseProfileBody(raw: unknown): ModelProfile {
  if (typeof raw !== 'object' || raw === null) {
    throw new ApiHttpError('bad_request', '请求体必须包含 profile 对象（name/baseUrl/apiKey）');
  }
  const p = raw as Record<string, unknown>;
  for (const field of ['name', 'baseUrl', 'apiKey'] as const) {
    if (typeof p[field] !== 'string' || (p[field] as string).trim() === '') {
      throw new ApiHttpError('bad_request', `profile.${field} 必填（非空字符串）`);
    }
  }
  if (p.temperature !== undefined && typeof p.temperature !== 'number') {
    throw new ApiHttpError('bad_request', 'profile.temperature 必须为数字');
  }
  return {
    name: (p.name as string).trim(),
    baseUrl: (p.baseUrl as string).trim(),
    apiKey: (p.apiKey as string).trim(),
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
  };
}

/** GET /models：登记簿全量（合并视图，apiKey 遮蔽 + isCurrent 标记） */
async function handleListModels(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  const profiles = Object.keys(cfg.models.profiles).sort().map((alias) => ({
    alias,
    ...cfg.models.profiles[alias],
    apiKey: maskKey(cfg.models.profiles[alias].apiKey),
    isCurrent: alias === cfg.models.active,
  }));
  sendJson(res, 200, { profiles, active: cfg.models.active ?? null });
}

/** GET /model：当前生效快照（model.*，apiKey 遮蔽） */
async function handleGetCurrentModel(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  sendJson(res, 200, {
    model: {
      name: cfg.model.name,
      baseUrl: cfg.model.baseUrl,
      apiKey: maskKey(cfg.model.apiKey),
      ...(cfg.model.temperature !== undefined ? { temperature: cfg.model.temperature } : {}),
    },
    active: cfg.models.active ?? null,
  });
}

/** PUT /model：切换激活模型（models.active + model.* 快照同步，写盘即生效） */
async function handlePutModel(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
  if (!validAlias(alias)) {
    throw new ApiHttpError('bad_request', '请求体必须包含合法 alias（非空、无空白、不以 - 开头）');
  }
  const scope = parseScope(body.scope);
  const { config: cfg } = ctx.configLoader.load();
  const profile = cfg.models.profiles[alias];
  if (!profile) {
    throw new ApiHttpError('not_found', `未找到模型「${alias}」。已登记: ${Object.keys(cfg.models.profiles).sort().join('、') || '（空）'}`);
  }
  if (!profile.apiKey) {
    throw new ApiHttpError('bad_request', `profile「${alias}」未配置 apiKey，无法激活（可用 PUT /config/models.profiles.${alias}.apiKey 补充）`);
  }
  const partial: PartialAgentConfig = buildUsePartial(alias, profile);
  await ctx.configWriter.updateScope(scope, partial);
  ctx.log(`[api] 已切换激活模型（${scope}）: ${alias}`);
  sendJson(res, 200, { alias, scope, model: { name: profile.name, baseUrl: profile.baseUrl } });
}

/** POST /models：登记新 profile（同名 409；D6 无交互，直写指定 scope） */
async function handleCreateModel(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
  if (!validAlias(alias)) {
    throw new ApiHttpError('bad_request', '请求体必须包含合法 alias（非空、无空白、不以 - 开头）');
  }
  const profile = parseProfileBody(body.profile);
  const scope = parseScope(body.scope);
  const { config: cfg } = ctx.configLoader.load();
  if (cfg.models.profiles[alias] !== undefined) {
    throw new ApiHttpError('conflict', `别名「${alias}」已存在。如需修改可先 DELETE /models/${alias} 再重新登记`);
  }
  await ctx.configWriter.updateScope(scope, { models: { profiles: { [alias]: profile } } });
  ctx.log(`[api] 已登记模型（${scope}）: ${alias}`);
  sendJson(res, 201, {
    alias,
    scope,
    profile: {
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: maskKey(profile.apiKey),
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    },
  });
}

/** DELETE /models/:alias?scope=：移除 profile（删当前激活 409；跨层归属提示 404） */
async function handleDeleteModel(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  alias: string,
): Promise<void> {
  const scope = parseScope(queryScope(req));
  const { config: cfg } = ctx.configLoader.load();
  if (alias === cfg.models.active) {
    throw new ApiHttpError('conflict', `「${alias}」是当前激活模型，不能移除。请先 PUT /model 切换到其他别名`);
  }
  const targetRaw = await readLayerRaw(ctx.configLoader, scope);
  if (targetRaw?.models?.profiles?.[alias] === undefined) {
    const otherScope = scope === 'workspace' ? 'global' : 'workspace';
    const otherRaw = await readLayerRaw(ctx.configLoader, otherScope);
    if (otherRaw?.models?.profiles?.[alias] !== undefined) {
      throw new ApiHttpError('not_found', `「${alias}」未在${scopeName(scope)}登记，但存在于${scopeName(otherScope)}（?scope=${otherScope}）`);
    }
    throw new ApiHttpError('not_found', `未找到模型「${alias}」`);
  }
  await ctx.configWriter.deleteScopeKey(scope, ['models', 'profiles', alias]);
  ctx.log(`[api] 已从${scopeName(scope)}移除模型: ${alias}`);
  sendJson(res, 200, { deleted: true, alias, scope });
}

/** POST /models/:alias/test：连通性测试（不改变激活状态；复用 defaultCheckConnectivity） */
async function handleTestModel(
  ctx: HandlerContext,
  res: ServerResponse,
  alias: string,
): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  const profile = cfg.models.profiles[alias];
  if (!profile) {
    throw new ApiHttpError('not_found', `未找到模型「${alias}」`);
  }
  if (!profile.apiKey) {
    throw new ApiHttpError('bad_request', `profile「${alias}」未配置 apiKey，无法测试`);
  }
  const result = await defaultCheckConnectivity(profile);
  sendJson(res, 200, {
    ok: result.ok,
    latencyMs: result.elapsedMs ?? 0,
    ...(result.ok ? {} : { error: result.error ?? '未知错误' }),
  });
}

export function modelRoutes(): Route[] {
  return [
    { method: 'GET', path: '/models', handler: (ctx, _req, res) => handleListModels(ctx, _req, res) },
    { method: 'GET', path: '/model', handler: (ctx, _req, res) => handleGetCurrentModel(ctx, _req, res) },
    { method: 'PUT', path: '/model', handler: (ctx, req, res) => handlePutModel(ctx, req, res) },
    { method: 'POST', path: '/models', handler: (ctx, req, res) => handleCreateModel(ctx, req, res) },
    { method: 'POST', path: '/models/:alias/test', handler: (ctx, _req, res, p) => handleTestModel(ctx, res, p.alias) },
    { method: 'DELETE', path: '/models/:alias', handler: (ctx, req, res, p) => handleDeleteModel(ctx, req, res, p.alias) },
  ];
}
