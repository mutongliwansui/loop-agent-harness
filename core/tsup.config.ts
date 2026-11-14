import { defineConfig } from 'tsup';

// 只出单 ESM 产物（设计决策 D3/D14）：
// - format 仅 'esm'，不产 .cjs / .d.cts，因此不需要 wrapper 脚本
// - dts:true 会产 index.d.ts，与 index.js 同址（tsup 默认布局）
// - clean:true 每轮清 dist，避免残留旧产物干扰「恰好 3 个文件」的验收断言
//
// 注意：tsup 的 entry/outDir 解析基准是 cwd，不是本文件所在目录。
// 在仓库根执行 `npx tsup --config core/tsup.config.ts` 会把产物写到根 dist/。
// 正确用法：`npm run build -w @loop-agent/core`（npm 会把 cwd 切到 core/）。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
});
