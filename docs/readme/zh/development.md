# 🏗️ 开发

> [⬅ 返回 README](../../../README.md)

```bash
# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 类型检查
npm run typecheck

# 运行测试（unit 层，并行执行）
npm test

# 集成测试（真实 PTY 等慢用例，串行执行）
npm run test:integration

# 全量测试（unit + integration）
npm run test:full

# 监听模式测试
npm run test:watch

# 只跑与改动文件相关的测试
npm run test:related
```

当前测试规模：**unit 层 157 个测试文件 / 1919 个用例（并行执行）+ integration 层 8 个测试文件 / 17 个用例（真实 PTY 等慢用例，串行执行）**。改动提交前建议跑一次 `npm run typecheck` + `npm test`，两者均需为 0 错误；push 前或 CI 中运行 `npm run test:full` 做全量回归。
