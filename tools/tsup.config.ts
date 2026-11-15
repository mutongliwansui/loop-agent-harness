import { defineConfig } from 'tsup';

// 只出单 ESM 产物（沿用 core 的 Q12 定案，与 llm 包完全一致）：
// - format 仅 'esm'，不产 .cjs / .d.cts
// - dts:true 产 index.d.ts，与 index.js 同址
// - clean:true 每轮清 dist，保证「恰好 3 个文件」的验收断言成立
//
// 注意：tsup 的 entry/outDir 解析基准是 cwd，不是本文件所在目录。
// 正确用法：`npm run build -w @loop-agent/tools`（npm 会把 cwd 切到 tools/）。
//
// @loop-agent/core 保持 external（不打包进产物）：它是同仓 workspace 包，
// 必须与宿主共用同一份实例，否则 instanceof / 服务 key 会分裂成两套。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  external: ['@loop-agent/core'],
});
