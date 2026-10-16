# 💬 Multi-turn Conversation

> [⬅ Back to README](../../../README.md)

The agent instance maintains `_chatHistory` internally, automatically persisting message history across `run()` calls.

### Behavior Rules

| Scenario | Behavior |
|---|---|
| First `run(input)` | Automatically creates a new session (system + user) |
| Consecutive `run(input)` | Automatically reuses the previous `_chatHistory`, appending a new user message |
| `run(input, { resetHistory: true })` | Clears history and starts a brand-new session |
| `run(input, { messages: [...] })` | Uses externally supplied message history (the system prompt is added) |
| `agent.resetSession()` | Manually clears the persisted history |
| `agent.getSessionMessages()` | Gets the current session's message history (read-only copy) |

### Multi-turn Example

```typescript
// Turn 1: read a file
const r1 = await agent.run('Read package.json', { resetHistory: true });
// Turn 2: follow up based on turn 1's result
const r2 = await agent.run('What is this project's version?');
// The agent already knows package.json's content and can answer directly
```

> **In-process** multi-turn is guaranteed by `_chatHistory`; for **cross-process** restore, use `SessionStore` persistence (see [💾 Session Persistence](session-persistence.md)).
