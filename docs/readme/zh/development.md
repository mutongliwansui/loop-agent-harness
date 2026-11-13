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

当前测试规模：**unit 层 161 个测试文件 / 2020 个用例（并行执行）+ integration 层 8 个测试文件 / 17 个用例（真实 PTY 等慢用例，串行执行）**。改动提交前建议跑一次 `npm run typecheck` + `npm test`，两者均需为 0 错误；push 前或 CI 中运行 `npm run test:full` 做全量回归。

> **真实模型用例默认跳过**：`tests/integration/` 下的 a/b/c/d/f/g 六个用例会真实调用 LLM，凭据来自测试临时目录之外的来源，因此在日常回归中必然失败（外网不通报连接超时、外网通则报 401）。现已加门禁 `LOOP_AGENT_LIVE_MODEL`（门禁实现见 `tests/integration/live-model-gate.ts`）：**不设置即整组跳过**，跳过原因会标在用例名后。需要真实联调时：

```bash
# 开启前请确认 OPENAI_API_KEY 与 OPENAI_BASE_URL / MODEL_NAME 属于同一服务商
# 若未设 OPENAI_API_KEY，门禁会回落到 ~/.loop-agent/config.json 的 model.apiKey
LOOP_AGENT_LIVE_MODEL=1 npm run test:integration
```
