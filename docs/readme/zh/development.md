# 🏗️ 开发

> [⬅ 返回 README](../../../README.md)

```bash
# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 类型检查
npm run typecheck

# 运行测试
npm test

# 监听模式测试
npm run test:watch
```

当前测试规模：**142 个测试文件 / 1788 个用例**（vitest，串行执行以避免集成用例触发 API 限速）。改动提交前建议跑一次 `npm run typecheck` + `npm test`，两者均需为 0 错误。
