// /model 命令资源化端点（Task-20261016-002 §3.4）
//
// 直调 buildUsePartial / readLayerRaw / validAlias / maskKey（D3 补导出复用）+
// defaultCheckConnectivity（连通性测试），CLI 命令层零改动。
// 响应字段以实际 schema 为准：ModelProfile = {name, baseUrl, apiKey, temperature?, advanced?}（apiKey 遮蔽输出）。
// D6 动词即确认：PUT /model 替代 CLI use；DELETE 删当前激活 → 409（比 CLI 确认更严格）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ModelAdvanced, ModelProfile, PartialAgentConfig } from '../../config/schema.js';
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

/** advanced 允许的键（未知键视为拼写错误，直接 400 而不是静默丢弃） */
const ADVANCED_KEYS = ['maxTokens', 'topP', 'topK', 'frequencyPenalty', 'timeoutMs', 'headers'];
/** 由系统/传输层管理的请求头，不允许用户覆盖 */
const RESERVED_HEADERS = new Set(['authorization', 'content-type', 'content-length', 'host']);

/**
 * 校验 advanced 对象（POST / PATCH 共用）。
 * - null 或 {}：返回 null，语义 = 删除该模型的高级配置
 * - 对象：校验后返回新对象（整体替换，未出现的键不使用服务商默认值）
 */
function parseAdvanced(raw: unknown): ModelAdvanced | null {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiHttpError('bad_request', 'profile.advanced 必须为对象或 null');
  }
  const a = raw as Record<string, unknown>;
  const unknownKey = Object.keys(a).find((k) => !ADVANCED_KEYS.includes(k));
  if (unknownKey) {
    throw new ApiHttpError('bad_request', `profile.advanced 存在未知字段 ${unknownKey}`);
  }

  const out: ModelAdvanced = {};
  if (a.maxTokens !== undefined) {
    if (typeof a.maxTokens !== 'number' || !Number.isInteger(a.maxTokens) || a.maxTokens < 1) {
      throw new ApiHttpError('bad_request', 'profile.advanced.maxTokens 必须为 ≥1 的整数');
    }
    out.maxTokens = a.maxTokens;
  }
  if (a.topP !== undefined) {
    if (typeof a.topP !== 'number' || !Number.isFinite(a.topP) || a.topP < 0 || a.topP > 1) {
      throw new ApiHttpError('bad_request', 'profile.advanced.topP 需在 0 ~ 1 之间');
    }
    out.topP = a.topP;
  }
  if (a.topK !== undefined) {
    if (typeof a.topK !== 'number' || !Number.isInteger(a.topK) || a.topK < 0) {
      throw new ApiHttpError('bad_request', 'profile.advanced.topK 必须为 ≥0 的整数');
    }
    out.topK = a.topK;
  }
  if (a.frequencyPenalty !== undefined) {
    if (typeof a.frequencyPenalty !== 'number' || !Number.isFinite(a.frequencyPenalty)
      || a.frequencyPenalty < -2 || a.frequencyPenalty > 2) {
      throw new ApiHttpError('bad_request', 'profile.advanced.frequencyPenalty 需在 -2 ~ 2 之间');
    }
    out.frequencyPenalty = a.frequencyPenalty;
  }
  if (a.timeoutMs !== undefined) {
    if (typeof a.timeoutMs !== 'number' || !Number.isInteger(a.timeoutMs) || a.timeoutMs < 1000) {
      throw new ApiHttpError('bad_request', 'profile.advanced.timeoutMs 必须为 ≥1000 的整数');
    }
    out.timeoutMs = a.timeoutMs;
  }
  if (a.headers !== undefined) {
    if (typeof a.headers !== 'object' || a.headers === null || Array.isArray(a.headers)) {
      throw new ApiHttpError('bad_request', 'profile.advanced.headers 必须为对象');
    }
    const headers: Record<string, string> = {};
    for (const [rawName, rawValue] of Object.entries(a.headers as Record<string, unknown>)) {
      const name = rawName.trim();
      if (!/^[A-Za-z0-9-]+$/.test(name)) {
        throw new ApiHttpError('bad_request', `请求头名「${rawName}」不合法：仅允许字母、数字与连字符`);
      }
      if (RESERVED_HEADERS.has(name.toLowerCase())) {
        throw new ApiHttpError('bad_request', `请求头 ${name} 由系统管理，不可覆盖`);
      }
      if (typeof rawValue !== 'string' || rawValue.trim() === '') {
        throw new ApiHttpError('bad_request', `请求头 ${name} 的值必须为非空字符串`);
      }
      headers[name] = rawValue.trim();
    }
    if (Object.keys(headers).length > 0) out.headers = headers;
  }

  return Object.keys(out).length > 0 ? out : null;
}

/** 校验请求体中的 profile：name/baseUrl/apiKey 必填非空字符串，temperature/advanced 可选 */
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
  const advanced = p.advanced === undefined ? undefined : parseAdvanced(p.advanced);
  return {
    name: (p.name as string).trim(),
    baseUrl: (p.baseUrl as string).trim(),
    apiKey: (p.apiKey as string).trim(),
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(advanced ? { advanced } : {}),
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
      ...(cfg.model.advanced !== undefined ? { advanced: cfg.model.advanced } : {}),
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
      ...(profile.advanced !== undefined ? { advanced: profile.advanced } : {}),
    },
  });
}

/**
 * 编辑请求体中的 profile 增量：
 * 字段缺省 = 不变；apiKey 空串 = 保持；temperature null = 删除该键；
 * advanced null / {} = 删除整组，传对象 = 整体替换
 */
interface ProfilePatch {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number | null;
  advanced?: ModelAdvanced | null;
}

/** 校验 PATCH profile 增量（只校验出现的字段，未出现即不改） */
function parseProfilePatch(raw: unknown): ProfilePatch {
  if (typeof raw !== 'object' || raw === null) {
    throw new ApiHttpError('bad_request', '请求体必须包含 profile 对象');
  }
  const p = raw as Record<string, unknown>;
  const patch: ProfilePatch = {};
  for (const field of ['name', 'baseUrl', 'apiKey'] as const) {
    if (p[field] === undefined) continue;
    if (typeof p[field] !== 'string') {
      throw new ApiHttpError('bad_request', `profile.${field} 必须为字符串`);
    }
    const v = (p[field] as string).trim();
    // apiKey 允许空串（语义 = 保持原值）；name/baseUrl 不允许清空
    if (field !== 'apiKey' && v === '') {
      throw new ApiHttpError('bad_request', `profile.${field} 不能为空`);
    }
    patch[field] = v;
  }
  if (p.temperature !== undefined) {
    if (p.temperature !== null && typeof p.temperature !== 'number') {
      throw new ApiHttpError('bad_request', 'profile.temperature 必须为数字或 null');
    }
    patch.temperature = p.temperature as number | null;
  }
  if (p.advanced !== undefined) {
    patch.advanced = parseAdvanced(p.advanced);
  }
  return patch;
}

/** PATCH /models/:alias：编辑已有 profile（别名不可改；生效模型同步 model.* 快照） */
async function handleUpdateModel(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  alias: string,
): Promise<void> {
  if (!validAlias(alias)) {
    throw new ApiHttpError('bad_request', '别名非法（非空、无空白、不以 - 开头）');
  }
  const body = await readJsonBody(req);
  const scope = parseScope(body.scope);
  const patch = parseProfilePatch(body.profile);
  const { config: cfg } = ctx.configLoader.load();
  const existing = cfg.models.profiles[alias];
  if (!existing) {
    throw new ApiHttpError('not_found', `未找到模型「${alias}」`);
  }

  // 写入层归属校验：目标层没有但另一层有 → 提示 scope（同 DELETE 语义）
  const targetRaw = await readLayerRaw(ctx.configLoader, scope);
  if (targetRaw?.models?.profiles?.[alias] === undefined) {
    const otherScope = scope === 'workspace' ? 'global' : 'workspace';
    const otherRaw = await readLayerRaw(ctx.configLoader, otherScope);
    if (otherRaw?.models?.profiles?.[alias] !== undefined) {
      throw new ApiHttpError('not_found', `「${alias}」未在${scopeName(scope)}登记，但存在于${scopeName(otherScope)}（请求体 scope=${otherScope}）`);
    }
    throw new ApiHttpError('not_found', `未找到模型「${alias}」`);
  }

  const removeTemp = patch.temperature === null;
  let nextTemp: number | undefined;
  if (patch.temperature === null) nextTemp = undefined;
  else nextTemp = patch.temperature !== undefined ? patch.temperature : existing.temperature;
  const removeAdvanced = patch.advanced === null;
  const nextAdvanced = patch.advanced === null
    ? undefined
    : patch.advanced !== undefined
      ? patch.advanced
      : existing.advanced;
  // 以生效配置中的完整 profile 为基线写入目标层，保证回读结果与页面提交一致
  const next: ModelProfile = {
    name: patch.name ?? existing.name,
    baseUrl: patch.baseUrl ?? existing.baseUrl,
    apiKey: patch.apiKey ? patch.apiKey : existing.apiKey,
    ...(nextTemp !== undefined ? { temperature: nextTemp } : {}),
    ...(nextAdvanced !== undefined ? { advanced: nextAdvanced } : {}),
  };

  await ctx.configWriter.updateScope(scope, { models: { profiles: { [alias]: next } } });
  if (removeTemp) {
    await ctx.configWriter.deleteScopeKey(scope, ['models', 'profiles', alias, 'temperature']);
  }
  if (removeAdvanced) {
    await ctx.configWriter.deleteScopeKey(scope, ['models', 'profiles', alias, 'advanced']);
  }
  const syncedActive = alias === cfg.models.active;
  if (syncedActive) {
    await ctx.configWriter.updateScope(scope, buildUsePartial(alias, next));
    if (removeTemp) await ctx.configWriter.deleteScopeKey(scope, ['model', 'temperature']);
    if (removeAdvanced) await ctx.configWriter.deleteScopeKey(scope, ['model', 'advanced']);
  }
  ctx.log(`[api] 已更新模型（${scope}）: ${alias}${syncedActive ? '（同步 model.* 快照）' : ''}`);
  sendJson(res, 200, {
    alias,
    scope,
    syncedActive,
    profile: {
      name: next.name,
      baseUrl: next.baseUrl,
      apiKey: maskKey(next.apiKey),
      ...(next.temperature !== undefined ? { temperature: next.temperature } : {}),
      ...(next.advanced !== undefined ? { advanced: next.advanced } : {}),
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
    { method: 'PATCH', path: '/models/:alias', handler: (ctx, req, res, p) => handleUpdateModel(ctx, req, res, p.alias) },
    { method: 'POST', path: '/models/:alias/test', handler: (ctx, _req, res, p) => handleTestModel(ctx, res, p.alias) },
    { method: 'DELETE', path: '/models/:alias', handler: (ctx, req, res, p) => handleDeleteModel(ctx, req, res, p.alias) },
  ];
}
