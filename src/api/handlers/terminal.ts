// 终端信息端点（Task-20261027-001）
//
// GET /terminal/info → 让前端在**开 WS 之前**就能区分三种不可用原因：
//   - 已关闭（webui.terminal = false）      → 前端显示「已被禁用」态并给开启步骤
//   - 缺 PTY 原生模块                        → 前端显示安装命令
//   - 一个 shell 都探测不到                  → 前端显示「无可用 shell」
// 若只靠 WS 握手失败来判定，浏览器按规范拿不到状态码与响应体，
// 只能笼统显示「连接失败」，用户无法自助排查。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http-utils.js';
import { detectShells } from '../../terminal/shells.js';
import { loadPtyModule, ptyUnavailableHint } from '../../terminal/pty-session.js';
import type { HandlerContext, Route } from '../router.js';

async function handleTerminalInfo(
  ctx: HandlerContext,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const cfg = ctx.deps.getConfig();
  const enabled = cfg.webui?.terminal === true;
  const ptyAvailable = loadPtyModule() !== null;
  // PTY 不可用时不必探测 shell（结果反正用不上，也避免误导）
  const shells = ptyAvailable ? detectShells() : [];
  sendJson(res, 200, {
    enabled,
    ptyAvailable,
    /**
     * PTY 不可用时的可操作指引（含真实查找路径）。
     * 直接复用服务端文案，前端不再自己写死「npm i」——SEA 单文件部署照做无效。
     */
    ptyHint: ptyAvailable ? null : ptyUnavailableHint(),
    shells: shells.map((s) => ({ id: s.id, label: s.label })),
    maxSessions: cfg.webui?.terminalMax ?? 4,
    idleMs: cfg.webui?.terminalIdleMs ?? 30 * 60 * 1000,
    /** 默认工作目录（缺省空间=最近使用），便于未连接时也有可读信息 */
    cwd: ctx.defaultRoot(),
  });
}

export function terminalRoutes(): Route[] {
  return [{ method: 'GET', path: '/terminal/info', handler: handleTerminalInfo }];
}
