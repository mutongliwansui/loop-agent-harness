import { defineConfig } from 'vitest/config';

// main 是独立子包，测试不复用根 vitest.config.ts 的 projects 配置；
// 根的 include 只有 'tests/**/*.test.ts'（相对仓库根），不会收集 main/tests。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // 任务 02 阶段还没有测试文件（测试自任务 04 起）：
    // 空套件视为通过，避免 `npm test` 因退出码 1 误判。
    passWithNoTests: true,
    // vitest 默认把缓存写到 node_modules/.vite，会在 main/ 下凭空造出
    // main/node_modules，干扰「workspaces 提升生效」的判据。
    cacheDir: 'dist/.vitest',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
