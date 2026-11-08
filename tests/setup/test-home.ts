// 测试环境用户目录隔离（需求：测试不得污染真实 ~/.loop-agent）
//
// src 各模块的默认用户目录统一走 loopAgentHome()（src/user-home.ts），
// 本 setup 在每个 vitest worker 启动时把 LOOP_AGENT_HOME 指向一次性临时目录：
// - 测试产生的会话/记忆/日志/后台任务/上传文件全部落在临时目录；
// - 临时目录挂在本轮测试的全局根目录下（tests/setup/global-test-home.ts 创建并注入），
//   整轮测试结束时由 globalSetup 的 teardown 统一删除，worker 被强杀也不会残留。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject } from 'vitest';

/** 全局根目录：由 globalSetup provide 注入；缺失时退回系统临时目录（单独运行 setup 时的兜底） */
const root = (inject as unknown as (key: string) => unknown)('loopAgentTestHomeRoot') as
  | string
  | undefined;

const baseDir = root ?? tmpdir();
const testHome = mkdtempSync(join(baseDir, 'worker-'));
process.env.LOOP_AGENT_HOME = testHome;
