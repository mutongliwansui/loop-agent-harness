// POST /sessions/:id/stop：停止会话当前 run（Task-20261021-002-03）
//
// 语义（D1/D2/D7）：
// - 404：会话不存在（跨工作空间扫描，与 handleAttachStream 同一只读校验，不切换空间）
// - 204：会话存在但无 running run（从未跑 / 已结束 / 过保留期）——幂等，不算错
// - 202：已请求取消，立即返回不等 run 结束（取消耗时取决于在跑工具，前端靠 SSE aborted 终态感知）
// - 重复请求：202 + alreadyAborting:true；controller.abort 仅首次调用触发

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { sendJson } from '../http-utils.js';

export async function handleStop(
  ctx: HandlerContext,
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  // 只读校验（与 handleAttachStream 一致）：跨空间会话也可停止，但不切换当前空间
  const exists = (await ctx.deps.sessionStore.listAllWorkspaces()).some((w) =>
    w.sessions.some((s) => s.id === id),
  );
  if (!exists) throw new ApiHttpError('not_found', `会话不存在: ${id}`);

  const result = ctx.runs.abort(id);
  if (!result) {
    // 无 running run（从未跑 / 已结束 / 已在取消后 run 结束）：幂等 204
    res.writeHead(204);
    res.end();
    return;
  }
  ctx.log(`[api] 会话 ${id} 收到停止请求: run=${result.runId}${result.alreadyAborting ? '（已在取消中）' : ''}`);
  sendJson(res, 202, {
    runId: result.runId,
    status: 'aborting',
    ...(result.alreadyAborting ? { alreadyAborting: true } : {}),
  });
}
