// 测试环境用户目录隔离 —— 全局根目录（需求：测试不得污染真实 ~/.loop-agent）
//
// 由 vitest globalSetup 加载（在 runner 进程执行，独立于 worker）：
// 1. 创建一次性根目录 {tmp}/loop-agent-test-home-XXXX，通过 provide 注入给各 worker；
// 2. 返回 teardown，在整轮测试结束时递归删除整个根目录。
//
// 为什么不用 worker 内的 process.on('exit') 清理：vitest fork 池的 worker 可能被
// SIGKILL/terminate 结束，exit 钩子不会执行，导致 %TEMP% 下残留大量临时目录。
// teardown 在 runner 进程内执行，不依赖 worker 的退出方式。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup({ provide }: { provide: (key: string, value: unknown) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'loop-agent-test-home-'));
  provide('loopAgentTestHomeRoot', root);

  return () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结果（残留仅位于系统临时目录）
    }
  };
}
