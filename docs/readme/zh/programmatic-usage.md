# 💻 编程式调用

> [⬅ 返回 README](../../../README.md)

### 基础单轮调用

```typescript
import { agent } from './src/agent/react-agent.js';
import { registerBuiltinTools } from './src/tools/index.js';

// 注册内置工具（每个进程只需调用一次）
registerBuiltinTools();

// 单次调用
const result = await agent.run('帮我读取 package.json 的版本号', {
  verbose: true,       // 输出 Thought/Action/Observation 日志
  resetHistory: true,  // 清空历史，开始新会话
});

console.log(result.answer);
console.log(`迭代: ${result.iterations}, 步骤: ${result.steps.length}`);
```

### 多轮对话

```typescript
// 第一轮：读取 package.json
const r1 = await agent.run('package.json 里项目叫什么名字？', {
  resetHistory: true,
  verbose: false,
});
console.log(r1.answer);

// 第二轮 —— 自动复用历史上下文，无需显式传 messages
const r2 = await agent.run('那它的版本号是多少？');
// Agent 已经知道 package.json 的内容，可以直接回答，无需再次调用工具
console.log(r2.answer);
```

### 会话持久化

```typescript
import { agent } from './src/agent/react-agent.js';
import { SessionStore } from './src/session/index.js';
import { registerBuiltinTools } from './src/tools/index.js';

registerBuiltinTools();

// 初始化会话存储（按当前工作空间路径隔离）
const sessionStore = new SessionStore(process.cwd());
await sessionStore.init();
agent.setSessionStore(sessionStore);

// run() 结束后若配置 session.autoSave=true，会自动创建/更新会话
const result = await agent.run('帮我读取 package.json', {
  resetHistory: true,
  verbose: true,
});
console.log(`会话 ID: ${agent.currentSessionId}`);
```

### 自定义事件监听

```typescript
import { agent } from './src/agent/react-agent.js';
import type { AgentEvents } from './src/types.js';

// 自定义监听器
const myListener: AgentEvents = {
  onToolStart: (tool, args) => {
    console.log(`[🔧 工具开始] ${tool}`, args);
  },
  onToolEnd: (tool, result) => {
    console.log(`[✅ 工具完成] ${tool} → ${result.slice(0, 100)}...`);
  },
  onFinal: (answer) => {
    console.log(`[🎯 最终答案] ${answer}`);
  },
};

const result = await agent.run('搜索 src 目录中的 config', {
  verbose: false,
  events: [myListener],
});
```
