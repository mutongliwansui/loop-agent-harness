# 📝 调试日志

> [⬅ 返回 README](../../../README.md)

Agent 内置了文件型调试日志系统（`src/debug.ts`），可将 LLM 请求/响应、工具调用、Agent 迭代过程完整记录到本地文件，便于问题排查。

### 开启方式

```bash
# 方式一：环境变量
DEBUG=true npm start

# 方式二：运行时配置
/config set agent.debug true
```

开启后 CLI 启动会提示：

```
⚠ 调试模式已开启，日志输出到: C:\Users\xxx\.loop-agent\logs
```

### 日志位置与轮转

- **位置**：`~/.loop-agent/logs/debug-YYYY-MM-DD.log`（按日期分文件）
- **轮转**：单文件最大 **10MB**，超出后自动轮转，最多保留 **5** 个历史文件
- **脱敏**：日志中的 API Key 自动脱敏（仅显示首尾各 4 位）

### 日志内容

| 类型 | 触发时机 | 记录内容 |
|---|---|---|
| `llmRequest` | 每次 LLM 请求 | 模型、消息数、工具数、脱敏后的参数 |
| `llmResponse` | LLM 响应返回 | 内容（截断 300 字符）、工具调用、耗时 |
| `llmError` | LLM 调用报错 | 错误信息、耗时 |
| `toolCall` | 每次工具调用 | 工具名、参数、结果（均截断）、耗时 |
| `iteration` | 每轮 Agent 迭代 | Thought / Action / Observation |
| `session` | 每次 `run()` 开始 | 消息数、工具数、会话 ID |

### 编程式读取

```typescript
import { debug } from './src/debug.js';

// 当前日志文件路径
const logPath = debug.getLogPath();

// 读取最近日志内容（默认最多 10000 字符）
const content = debug.readLog(10000);
```
