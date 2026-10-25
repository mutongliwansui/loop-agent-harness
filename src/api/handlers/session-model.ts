import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import type { HandlerContext } from '../router.js';
import { locateSession } from '../session-locator.js';

/**
 * PUT /sessions/:id/model（task-20261025-002 D7/D11）
 *
 * 写入「本会话用哪个登记簿模型」，只落元数据、**不改全局激活**（不发 PUT /model）。
 * body: { modelAlias: string | null }，null/空串 = 跟随全局（清除该字段）。
 *
 * 校验口径与发消息一致：有值时必须存在于登记簿，否则 400 并列出可用别名——
 * 静默接受一个不存在的别名，会让用户「以为设好了、其实每条消息都走全局」。
 */
export async function handleSetSessionModelAlias(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const raw = body.modelAlias;
  if (raw !== null && raw !== undefined && typeof raw !== 'string') {
    throw new ApiHttpError('bad_request', 'modelAlias 必须是字符串或 null');
  }
  const alias = typeof raw === 'string' ? raw.trim() : '';

  const { config } = ctx.configLoader.load();
  if (alias && !config.models.profiles[alias]) {
    const known = Object.keys(config.models.profiles).sort().join('、') || '（空）';
    throw new ApiHttpError('bad_request', `未找到模型「${alias}」。已登记: ${known}`);
  }

  const store = ctx.registry ? (await locateSession(ctx.registry, id)).store : ctx.deps.sessionStore;
  // 归属空间校验：无 registry 时按该 store 索引确认会话存在，避免给不存在的 id 静默写索引
  const meta = (await store.listSessions()).find((s) => s.id === id);
  if (!meta) throw new ApiHttpError('not_found', `会话不存在: ${id}`);

  await store.setSessionModelAlias(id, alias || undefined);
  ctx.log(`[api] 会话模型选择已更新: ${id} → ${alias || '（跟随全局）'}`);
  sendJson(res, 200, { id, modelAlias: alias || null });
}
