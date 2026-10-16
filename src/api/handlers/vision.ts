// /vision 命令资源化端点（Task-20261016-002 §3.8）
//
// 复用 resolveVisionTargets 探测链与 runVisionConnectivityTest（从 vision-command 补 export，D3 单源）。
// 诊断语义：检测失败不失败端点——available=false + reason、ok=false + error（均 200）。
// POST /vision/test 有 Key 时会真实请求视觉服务（与 CLI /vision test 同链路）。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext, Route } from '../router.js';
import { sendJson } from '../http-utils.js';
import { resolveVisionTargets } from '../../tools/vision/tools.js';
import { runVisionConnectivityTest } from '../../commands/vision-command.js';
import { hostnameOf } from './status.js';

/** GET /vision：视觉链路探测状态（enabled + Key 回退解析结果） */
async function handleVisionStatus(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  const targets = resolveVisionTargets(cfg.vision, cfg.model);
  const available = cfg.vision.enabled && targets.apiKey !== '';
  sendJson(res, 200, {
    available,
    provider: hostnameOf(targets.baseUrl),
    model: targets.model,
    ...(available ? {} : {
      reason: !cfg.vision.enabled
        ? 'vision.enabled=false，视觉工具未注册'
        : '未配置 API Key（vision.apiKey 与 model.apiKey 均为空）',
    }),
  });
}

/** POST /vision/test：发最小图片请求验证连通（失败也 200，诊断语义） */
async function handleVisionTest(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config: cfg } = ctx.configLoader.load();
  const result = await runVisionConnectivityTest(cfg.vision, cfg.model);
  sendJson(res, 200, {
    ok: result.ok,
    latencyMs: result.latencyMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
  });
}

export function visionRoutes(): Route[] {
  return [
    { method: 'GET', path: '/vision', handler: (ctx, req, res) => handleVisionStatus(ctx, req, res) },
    { method: 'POST', path: '/vision/test', handler: (ctx, req, res) => handleVisionTest(ctx, req, res) },
  ];
}
