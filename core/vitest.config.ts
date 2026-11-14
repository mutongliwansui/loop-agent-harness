import { defineConfig } from 'vitest/config';

// core 是独立库，测试不得依赖主工程的 tests/setup/*，
// 也不复用根 vitest.config.ts 的 projects 配置。
// 根 vitest 的 include 仅 'tests/**/*.test.ts'（相对根目录），
// 因此 core/tests/** 不会被主工程的全量回归收集。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // 任务 01 阶段内核尚无测试用例（测试自任务 02 起）：
    // 空套件视为通过，避免 `npm test` 因退出码 1 污染 CI。
    // 注意这是临时放宽，任务 02 起有真实用例后不影响判定。
    passWithNoTests: true,
    // vitest 默认把缓存写到 node_modules/.vite，会在 core/ 下凭空造出
    // core/node_modules 目录，干扰「workspaces 提升生效」的判据
    //（该目录一旦存在，就分不清是依赖副本还是纯缓存）。
    // 因此显式改到 dist 下的子目录：dist 整体不入库，且 core/node_modules 保持不存在。
    cacheDir: 'dist/.vitest',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
