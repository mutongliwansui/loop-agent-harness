// 工作空间 ALS 上下文（Task-20261021-010-02 D3 第 2 层）
//
// 工具层归位的三级取值（runner 内）：
//   ① options.workspaceRoot（显式：agent 传入的根，优先）
//   ② currentWorkspaceRoot()（本模块，ALS 兜底：漏传显式根的深层调用）
//   ③ process.cwd()（CLI / 单测默认，保持改造前语义）
//
// 设计约束：
// - 本模块**不做任何 chdir**：工作空间是 ALS 里的不可变值，不是进程级状态；
// - 嵌套进入不同根属可疑调用（跨空间串联），只记 debug 告警，不抛错以免打断运行；
// - 以最内层为准（与 Node ALS 语义一致）。

import { AsyncLocalStorage } from 'node:async_hooks';
import { debug } from '../debug.js';

/** ALS 中保存的空间身份（root 为 canonical 绝对路径，id 为 workspaceId(root)） */
export interface WorkspaceStore {
  root: string;
  id: string;
}

const als = new AsyncLocalStorage<WorkspaceStore>();

/**
 * 在指定工作空间的 ALS 上下文中执行 fn。
 *
 * 嵌套时若外层根与内层根不同，记一条告警（跨空间嵌套多为调用链错误），
 * 但仍以最内层为准执行，避免因"上下文可疑"直接中断用户运行。
 */
export function runWithWorkspace<T>(
  rt: { root: string; id: string },
  fn: () => Promise<T>,
): Promise<T> {
  const outer = als.getStore();
  if (outer && outer.root !== rt.root) {
    debug.log(
      `[workspace-context] 跨空间嵌套：外层根 ${outer.root}，内层根 ${rt.root}（以最内层为准）`,
    );
  }
  return als.run({ root: rt.root, id: rt.id }, fn);
}

/** 当前 ALS 上下文的空间根；无上下文（CLI / 单测直调）→ undefined */
export function currentWorkspaceRoot(): string | undefined {
  return als.getStore()?.root;
}
