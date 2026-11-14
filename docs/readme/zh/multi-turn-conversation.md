# 💬 多轮对话

> [⬅ 返回 README](../../../README.md)

Agent 实例内部维护 `_chatHistory`，跨 `run()` 调用自动持久化消息历史。

### 行为规则

| 场景 | 行为 |
|---|---|
| 首次调用 `run(input)` | 自动创建新会话（system + user） |
| 连续调用 `run(input)` | 自动复用上次的 `_chatHistory`，追加新的 user 消息 |
| `run(input, { resetHistory: true })` | 清空历史，开始全新会话 |
| `run(input, { messages: [...] })` | 使用外部传入的消息历史（会补上 system prompt） |
| `agent.resetSession()` | 手动清空持久化的历史 |
| `agent.getSessionMessages()` | 获取当前会话的消息历史（只读拷贝） |

### 多轮对话示例

```typescript
// 第一轮：读取文件
const r1 = await agent.run('读取 package.json', { resetHistory: true });
// 第二轮：基于第一轮的结果继续追问
const r2 = await agent.run('这个项目的版本号是多少？');
// 此时 Agent 已知道 package.json 内容，可直接回答
```

> **进程内**多轮由 `_chatHistory` 保证；**跨进程**恢复请使用 `SessionStore` 持久化（见 [💾 会话持久化](./session-persistence.md)）。
