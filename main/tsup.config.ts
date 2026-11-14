import { defineConfig } from 'tsup';

// 只出单 ESM 产物，与 core 保持同一套包契约。
//
// external 是硬要求（设计决策 D11）：`@loop-agent/core` 若不 external，
// 打包时会把 core 内联进本包产物，消费方就会同时持有两份 core——
// `instanceof` 静默失效、两个 host 的服务表互不可见，且**不会有任何报错**。
//
// 注意：tsup 的 entry/outDir 解析基准是 cwd。正确用法是
// `npm run build -w @loop-agent/main`（npm 会把 cwd 切到 main/）。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  external: ['@loop-agent/core'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  esbuildOptions(options) {
    // 插件 specifier 是运行期值（用户装的插件路径），变量 import() 无法被
    // 静态分析属预期行为，产物里原样保留、运行时由 Node 解析。
    // 不静音的话每轮构建都会刷一条 unsupported-dynamic-import 告警。
    options.logOverride = { 'unsupported-dynamic-import': 'silent' };
  },
});
