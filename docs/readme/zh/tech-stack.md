# 🛠️ 技术栈

> [⬅ 返回 README](../../../README.md)

| 项目 | 选型 | 说明 |
|---|---|---|
| **语言** | TypeScript 5.x | strict 模式，类型安全 |
| **运行时** | Node.js 18+ | 原生 ESM 模块 |
| **LLM SDK** | `openai` v4.x | 兼容任意 OpenAI 协议服务商 |
| **MCP SDK** | `@modelcontextprotocol/sdk` v1.x | 外部工具接入协议 |
| **加密** | Node.js `crypto` | PBKDF2 + AES-256-GCM 会话加密 |
| **测试框架** | vitest | 分层测试：unit 并行 / integration 串行 |
| **构建工具** | tsup | 输出 ESM 格式 |
| **开发工具** | tsx | 开发时直接运行 TypeScript |
| **环境变量** | 内置 .env 解析器 | 启动时自动读取 `.env` 到 `process.env`（兼容 dotenv 行为） |
