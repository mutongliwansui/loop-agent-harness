import { defineConfig } from 'vitest/config';

// 测试分层：
// - unit：日常开发/提交前运行，并行执行（maxWorkers 限 4，避免本机资源争抢）
// - integration：真实 PTY/进程类慢测试，串行执行，push 前或 CI 全量运行
export default defineConfig({
  test: {
    // 每个测试 worker 注入一次性 LOOP_AGENT_HOME 临时目录（tests/setup/test-home.ts），
    // 会话/记忆/日志/后台任务等用户目录产物全部隔离，不污染真实 ~/.loop-agent；
    // 临时目录挂在 globalSetup 创建的全局根目录下，整轮结束统一 teardown 删除（worker 被强杀也不残留）。
    // 注意：projects 内每个 project 为独立配置，setupFiles/globalSetup 均须逐 project 声明（根级不会继承）。
    projects: [
      {
        test: {
          name: 'unit',
          globalSetup: ['./tests/setup/global-test-home.ts'],
          setupFiles: ['./tests/setup/test-home.ts'],
          include: ['tests/**/*.test.ts'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            'tests/integration/**',
          ],
          maxWorkers: 4,
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        test: {
          name: 'integration',
          globalSetup: ['./tests/setup/global-test-home.ts'],
          setupFiles: ['./tests/setup/test-home.ts'],
          include: ['tests/integration/**/*.test.ts'],
          // 真实 PTY/子进程测试存在资源竞争，保持串行
          fileParallelism: false,
          testTimeout: 120000,
          hookTimeout: 120000,
        },
      },
    ],
  },
});
