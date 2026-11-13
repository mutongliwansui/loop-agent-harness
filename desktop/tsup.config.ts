import { defineConfig } from 'tsup';

/**
 * 壳主进程构建配置。
 *
 * 刻意产出 CJS（main.cjs）：Electron 主进程对 ESM 支持受限，官方文档要求
 * 以 .mjs 或 package.json 的 type:module 声明，且部分 API 在 ESM 主进程不可用。
 * 子包 package.json 声明了 type:module（供 tsup 配置与源码使用 ESM 语法），
 * 因此产物必须显式用 .cjs 后缀，避免被当作 ESM 加载（见任务 01 D1-2）。
 */
export default defineConfig({
  entry: { main: 'src/main.ts' },
  outDir: 'dist',
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  target: 'node20',
  // Electron 由运行时提供，不打包进产物
  external: ['electron'],
  clean: true,
  sourcemap: true,
  // 不产出 d.ts：壳不需要对外暴露类型，避免拖慢构建
  dts: false,
});
