// POST /admin/shutdown：触发优雅关停（任务 20261112-007-02 / D2-1、D2-2、D2-3）
//
// 为什么需要这个端点：Windows 下信号关停是**无条件强杀**（已实测：子进程装了 SIGINT
// handler，父进程 kill('SIGINT') 后 handler 根本不执行），而 Dreaming（记忆整理）只挂在
// 信号处理里 → 桌面端关窗口必然丢记忆。故需要一个跨平台的 HTTP 入口。
//
// 安全要点（D2-3）：必须校验自定义头 X-LoopAgent-Client: desktop。
// 本服务无 CORS、无 OPTIONS 预检处理，而「POST + 无自定义头」属于 CORS 简单请求
// ——任意网页都能静默发出来（同源策略只拦读响应，不拦发送）。加了自定义头就会触发预检，
// 浏览器因服务端不回 CORS 头而拦下请求。仅靠「回环 + token」防不住：未配 token 时
// 回环校验对浏览器发起的请求同样成立。
//
// 响应约定：
// - 202：已受理（首次触发），关停序列在 setImmediate 后开始
// - 409：已在关停中（幂等，不重复跑 Dreaming）
// - 403：缺自定义头（疑似网页 CSRF）
// - 501：宿主未注入 requestShutdown（如单测直接 createApiServer）
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { sendJson } from '../http-utils.js';

/** 桌面壳必须携带的标记头（见上方安全说明） */
export const CLIENT_HEADER = 'x-loopagent-client';
/** 该头的唯一合法值 */
export const CLIENT_HEADER_VALUE = 'desktop';

export async function handleAdminShutdown(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 1) 自定义头守卫（最先判：无论是否配置 token 都必须带）
  const headerVal = req.headers[CLIENT_HEADER];
  if (headerVal !== CLIENT_HEADER_VALUE) {
    ctx.log(`[shutdown][denied] 缺少或错误的 ${CLIENT_HEADER} 头，来源 ${req.socket.remoteAddress ?? '?'}`);
    throw new ApiHttpError(
      'forbidden',
      `缺少请求头 ${CLIENT_HEADER}: ${CLIENT_HEADER_VALUE}（该端点仅供桌面端调用）`,
    );
  }

  // 2) 宿主是否支持关停（未注入 → 501，不崩）
  const requestShutdown = ctx.deps.requestShutdown;
  if (!requestShutdown) {
    throw new ApiHttpError('not_implemented', '当前宿主未启用关停能力');
  }

  // 3) 触发（幂等：重复调用返回 false）
  const reason = `http:${req.socket.remoteAddress ?? '?'}`;
  const first = requestShutdown(reason);
  if (!first) {
    sendJson(res, 409, { ok: false, code: 'ALREADY_SHUTTING_DOWN' });
    return;
  }

  ctx.log(`[shutdown] 收到桌面端关停请求（${reason}），开始整理记忆`);
  sendJson(res, 202, { ok: true, shuttingDown: true });
}

/** 管理端点路由组（与 handlers 目录其余组保持同构，便于 router 组合） */
export function adminRoutes(): Route[] {
  return [
    {
      method: 'POST',
      path: '/admin/shutdown',
      handler: (ctx, req, res) => handleAdminShutdown(ctx, req, res),
    },
  ];
}
