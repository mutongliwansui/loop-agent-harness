// 工作空间路径规则（Task-20261021-010-02 D15 / D20）
//
// 原先 `toSlash` / `resolveInWs` 是 handlers/fs.ts 的私有实现，工具层无法复用；
// 现抽到本模块作为唯一真源：
// - API 侧（/fs/*）继续使用 resolveInWs 的「越界拒绝」语义（行为零变化）；
// - 工具侧使用 resolveToolPath 的「相对按根解析、绝对原样放行」语义（D20）。
//
// 注意：ApiHttpError 虽位于 api 目录，但它是无依赖的叶模块；此处仅借用错误码载体，
// 不反向依赖 handler 实现。

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ApiHttpError } from '../api/errors.js';
import { debug } from '../debug.js';
import type { ToolContext } from '../types.js';

/** Windows 下 relative() 产 '\'，统一转 '/'（resolve 两种都接受） */
export function toSlash(p: string): string {
  return sep === '\\' ? p.replace(/\\/g, '/') : p;
}

/** 解析空间内路径：相对基于根展开，绝对路径直接用；越出根 → 403（API 侧语义） */
export function resolveInWs(root: string, input: string): string {
  const raw = input.trim();
  if (!raw) return root;
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ApiHttpError('forbidden', `路径越出工作空间: ${input}`);
  }
  return abs;
}

/**
 * 工具层路径解析（D20）：
 * - 绝对路径**原样返回**（不校验是否在空间内：activate_skill 引导的
 *   `~/.loop-agent/skills/...`、上传目录均在空间外，强制拒绝属行为变更）；
 * - 相对路径按注入的空间根解析（替代原先隐式的 process.cwd()）。
 */
export function resolveToolPath(root: string, input: string): string {
  return isAbsolute(input) ? input : resolve(root, input);
}

/**
 * 取工具执行的空间根：ctx 显式 → process.cwd() 兜底。
 *
 * runner 正常都会注入 ctx.workspaceRoot；缺失只发生在单测直调或旧式调用路径，
 * 记一条 debug 日志便于 task-06 靠日志发现漏改。
 */
export function toolWorkspaceRoot(ctx?: ToolContext): string {
  const root = ctx?.workspaceRoot;
  if (root) return root;
  debug.log('[tools] 缺少 workspaceRoot，回落 process.cwd()');
  return process.cwd();
}
