import { defineConfig } from 'vitest/config';

// 测试分层：
// - unit：日常开发/提交前运行，并行执行（maxWorkers 限 4，避免本机资源争抢）
// - integration：真实 PTY/进程类慢测试，串行执行，push 前或 CI 全量运行
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
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
