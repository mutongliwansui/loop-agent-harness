import { defineConfig } from 'vitest/config';

// tools 是独立库，测试不得依赖主工程的 tests/setup/*，
// 也不复用根 vitest.config.ts 的 projects 配置。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // cacheDir 改到 dist 下：避免 vitest 默认写 node_modules/.vite，
    // 在 tools/ 下凭空造出 node_modules 目录，干扰「workspaces 提升生效」的判据。
    cacheDir: 'dist/.vitest',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
