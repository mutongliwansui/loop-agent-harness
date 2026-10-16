# 🛠️ Tech Stack

> [⬅ Back to README](../../../README.md)

| Item | Choice | Description |
|---|---|---|
| **Language** | TypeScript 5.x | strict mode, type-safe |
| **Runtime** | Node.js 18+ | native ESM modules |
| **LLM SDK** | `openai` v4.x | compatible with any OpenAI-protocol provider |
| **MCP SDK** | `@modelcontextprotocol/sdk` v1.x | external tool integration protocol |
| **Crypto** | Node.js `crypto` | PBKDF2 + AES-256-GCM session encryption |
| **Test Framework** | vitest | integration tests, serial execution |
| **Build Tool** | tsup | outputs ESM format |
| **Dev Tool** | tsx | run TypeScript directly during development |
| **Env Vars** | built-in .env parser | auto-loads `.env` into `process.env` on startup (dotenv-compatible behavior) |
