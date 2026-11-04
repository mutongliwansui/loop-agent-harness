// 开发者中心端点（需求 20261104-002 · 方案 D4）
//
// GET /dev/api-docs：把路由表（端点真源）与 API_DOC_ENTRIES（中文语义）合并输出，
// 供 WebUI 开发者中心「API 接口文档」模块渲染。
//
// 为什么用 getter 注入而不是 import createRoutes：
//   router.ts 会 import 本模块的 devRoutes()，若本模块再静态 import createRoutes 将构成循环依赖。
//   改为调用方传 getter（`() => createRoutes()`），依赖方向单向，且 getter 只在请求期执行、
//   不会在 createRoutes() 构造阶段递归。
//
// 不做进程内缓存：createRoutes() 只是构造 78 个轻量对象，合并是纯遍历，
// 相比「按 version 缓存」带来的失效判断成本更划算，且天然不会读到过期路由表。

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerContext, Route } from '../router.js';
import { sendJson } from '../http-utils.js';
import { collectApiDocs, type RouteLike } from '../api-docs.js';

/** GET /dev/api-docs：端点全集（反射）+ 中文说明（元数据）+ 统计 */
async function handleApiDocs(
  ctx: HandlerContext,
  _req: IncomingMessage,
  res: ServerResponse,
  listRoutes: () => readonly RouteLike[],
): Promise<void> {
  const payload = collectApiDocs(listRoutes(), ctx.version ?? '');
  sendJson(res, 200, payload);
}

/**
 * 开发者中心路由组。
 * @param listRoutes 返回路由表全集的 getter（由 router.ts 传入 `() => createRoutes()`）
 */
export function devRoutes(listRoutes: () => readonly RouteLike[]): Route[] {
  return [
    {
      method: 'GET',
      path: '/dev/api-docs',
      handler: (ctx, req, res) => handleApiDocs(ctx, req, res, listRoutes),
    },
  ];
}
