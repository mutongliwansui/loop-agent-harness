// 同文件写操作串行化（Task-20261023-001 D4）：进程内 perPath 互斥队列
// 背景：editFile/fileWrite 是模块级单例 Tool，同一轮并行 tool_calls 或多会话/多空间并发
// 对同一文件的「读→匹配→写」窗口互相插入，导致「内容一致却报未找到」的静默竞态。
// 方案：模块级 Map<规范化路径, Promise 尾链>，同物理文件全局排队，锁内全程读-改-写。
// 跨进程锁（如 MCP 工具写文件）为演进项，不在本任务范围。

import { resolve } from 'node:path';

/** 锁表：key → 当前尾链（尾链永 resolve，不携带 rejection） */
const chains = new Map<string, Promise<unknown>>();

/**
 * 锁 key：物理绝对路径（resolve 展开 ../ 等），Windows 下小写化以合并大小写别名。
 * 与工作空间无关——同一物理文件跨空间/跨会话也互斥。
 */
export function lockKey(absPath: string): string {
  const p = resolve(absPath);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * 在 absPath 的互斥队列尾排队执行 fn：
 * - 前序任务失败不阻塞本次执行（尾链吞错）；
 * - fn 的结果/异常原样透传给调用方（调用方 try/catch）；
 * - 队列空闲时清理 Map 条目，避免长期运行内存增长。
 */
export function withFileLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(absPath);
  const prev = chains.get(key) ?? Promise.resolve();
  // 前序无论成败，结束后轮到自己；run 的 rejection 原样透传
  const run = prev.then(fn, fn);
  // 尾链吞错，保证后续排队者不被之前的失败波及
  const next = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, next);
  // 空闲自清理：仅当自己仍是尾链时删除（有新排队者时其 next 已覆盖）
  void next.then(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return run;
}
