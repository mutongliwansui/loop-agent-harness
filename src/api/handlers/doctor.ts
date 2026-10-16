// /doctor 命令资源化端点（Task-20261016-002 §3.9）
//
// 复用 buildDoctorChecks（从 doctor-command 补 export，D3 单源），只读不写盘。
// 诊断语义：单项失败不失败端点，ok:false + detail 明细（level 区分 blocker/missing）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext, Route } from '../router.js';
import { sendJson } from '../http-utils.js';
import { buildDoctorChecks } from '../../commands/doctor-command.js';

/** GET /doctor：启动体检逐项结果 */
async function handleDoctor(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  const { ok, checks } = buildDoctorChecks(cfg);
  sendJson(res, 200, {
    ok,
    checks: checks.map(({ name, ok: itemOk, level, detail }) => ({ name, ok: itemOk, level, detail })),
  });
}

export function doctorRoutes(): Route[] {
  return [
    { method: 'GET', path: '/doctor', handler: (ctx, req, res) => handleDoctor(ctx, req, res) },
  ];
}
