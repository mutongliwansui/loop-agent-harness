// 自有数据目录受控只读端点（20261028-007 D1/D2）：root = ~/.loop-agent（应用自有数据目录，
// 记忆/会话/runs/skills/model-bench 等均在其中）。供对话流工具卡片路径 chip 预览
// fileWrite 写记忆、fileRead 读 runs 日志、activate_skill 引导的 SKILL.md 等场景。
// 与 /uploads/view 完全同构：只读、词法防穿越 + 符号链接防逃逸 + 只读读取，越界一律 403；
// `~` 开头输入先按 homedir 展开（D3）。root 经 ctx.userDir 注入（默认 ~/.loop-agent），单测可换临时目录。
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { serveControlledView } from './controlled-view.js';

/** userdir 根：显式注入优先，缺省 ~/.loop-agent（与 handlers/memory.ts 等同口径） */
function userDirRoot(ctx: HandlerContext): string {
  return ctx.userDir ?? join(homedir(), '.loop-agent');
}

/**
 * GET /userdir/view?path=&disp=file|raw：自有数据目录内文件受控只读。
 * - path：相对 userdir 根（如 `memory/<wsId>/2026-10-29.md`）、绝对路径或 `~` 字面量——归一后必须位于根内；
 * - disp=file：文本预览（512KB 截断 + NUL 二进制拒绝，响应与 /fs/file 同构）；
 * - disp=raw：原始字节（图片/文档），Content-Type 按扩展名，上限 100MB。
 */
export async function handleUserdirView(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const input = query.get('path')?.trim() ?? '';
  if (!input) throw new ApiHttpError('bad_request', '缺少 path 参数');
  const disp = query.get('disp') === 'raw' ? 'raw' : 'file';
  await serveControlledView(userDirRoot(ctx), input, disp, res);
}

export function userdirRoutes(): Route[] {
  return [{ method: 'GET', path: '/userdir/view', handler: (ctx, req, res) => handleUserdirView(ctx, req, res) }];
}
