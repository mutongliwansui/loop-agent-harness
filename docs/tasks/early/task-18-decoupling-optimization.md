# Task-18：Agent 核心与控制台输出解耦改造

> 目标：解决 Agent 核心与 CLI 层之间的高耦合问题——CLI 层直接操作 Agent 内部模块、`index.ts` 单体 1394 行、ANSI 颜色码重复定义、Agent 核心有穿透事件层的直写 `console.log`。通过引入命令注册器、统一颜色工具、事件层补全，使 ReAct 循环可独立于 CLI 运行，为后续接入 Web UI / API 层铺路。

---

## 一、需求背景

### 1.1 现状耦合度评估

| 维度 | 评分 | 说明 |
|------|------|------|
| ReAct 循环 ↔ 控制台输出 | **低** | 事件驱动（AgentEvents），ConsoleLogger 可替换 |
| CLI 命令层 ↔ Agent 内部模块 | **高** | 直接访问 4 个 getter 操作内部实例 |
| CLI 渲染 ↔ 控制台 | **高** | 所有渲染函数直接 console.log，无抽象 |
| index.ts 自身内聚性 | **低** | 1394 行单体，6 个命令处理器 + REPL + 渲染全在一起 |

### 1.2 核心痛点

1. **Agent 核心有 2 处穿透事件层的直写**：`react-agent.ts` 第 660 行 `console.error` 和第 719 行 `console.error`，绕过了事件系统直接输出
2. **CLI 层直接操作 Agent 内部模块**：`index.ts` 通过 `agent.episodicMemory`、`agent.curatedMemory`、`agent.promotionGate` 等 getter 直接操作内部实例，Agent 内部 API 变化直接影响 CLI
3. **ANSI 颜色码重复定义**：`logger.ts` 的 `COLOR` 和 `index.ts` 的 `C` 完全重复
4. **index.ts 单体文件**：6 个斜杠命令处理器 + REPL 循环 + 渲染函数全部堆在一个文件
5. **Agent 单例硬绑定**：`import { agent }` 直接导入全局单例，无法替换实现

### 1.3 设计约束

- **不破坏现有 CLI 体验**：所有斜杠命令行为不变，用户感知不到差异
- **不改变 Agent 核心逻辑**：ReAct 循环、记忆系统、工具调用保持原样
- **增量改造**：分阶段拆解，每阶段可独立验证，不一次性全改
- **零新依赖**：不引入新 npm 包，纯代码结构重组

---

## 二、根因分析

### 2.1 事件驱动的架构（已做好的部分）

```
Agent 核心 (react-agent.ts)
    │
    ▼ AgentEvents 接口（11 个钩子）
    │
    ├── ConsoleLogger（默认）──→ console.log / process.stdout
    └── 自定义 events[]  ──→ 用户自定义输出
```

`AgentEvents` 接口（[types.ts:191-216](file:///d:/workspace/loop-agent-command/src/types.ts#L191-L216)）定义了 11 个钩子，ReAct 主循环通过 `composeEvents()` 分发。这套机制使 Agent 核心不直接依赖 `console.log`（除 2 处例外），ConsoleLogger 可被替换为任意实现。

### 2.2 CLI 层高耦合的根因

```
index.ts (1394 行)
    │
    ├── import { agent }  ←── 硬编码单例，无法替换
    │
    ├── handleConfig()    ──→ configLoader / configWriter（直接操作）
    ├── handleMcp()       ──→ mcpManager（直接操作）
    ├── handleTools()     ──→ registry / mcpManager（直接操作）
    ├── handleSkill()     ──→ skillLoader（直接操作）
    ├── handleSession()   ──→ agent.getSessionMessages() / sessionStore（直接操作）
    ├── handleMemory()    ──→ agent.episodicMemory / agent.curatedMemory / agent.promotionGate（穿透到内部模块）
    │
    ├── printBanner()     ──→ console.log（直接输出）
    ├── printStatus()     ──→ console.log（直接输出）
    ├── renderMessages()  ──→ console.log（直接输出）
    └── REPL 循环          ──→ rl.on('line', ...)
```

CLI 层没有抽象层，所有命令处理器直接操作底层模块，渲染函数直接 `console.log`。

---

## 三、方案设计

### 3.1 改造总览

```
改造前:                          改造后:
┌──────────────────┐    ┌──────────────────┐
│ index.ts (1394行) │    │ index.ts (~100行) │  ← 仅 REPL 入口 + 命令分发
│ - REPL            │    │   REPL 循环       │
│ - 6 个命令处理器  │    └──────┬───────────┘
│ - 渲染函数        │           │
│ - ANSI 颜色码     │    ┌──────▼───────────┐
└──────────────────┘    │ commands/          │  ← 命令注册器 + 处理器
                        │ registry.ts        │
                        │ config.ts          │
                        │ mcp.ts             │
                        │ tools.ts           │
                        │ skill.ts           │
                        │ session.ts         │
                        │ memory.ts          │
                        └──────┬───────────┘
                               │ 通过 OutputChannel 抽象输出
                               │ （CLI: ConsoleOutput / Web: JsonOutput）
                        ┌──────▼───────────┐
                        │ ui/               │  ← 统一输出层
                        │ colors.ts         │  ← 唯一 ANSI 定义
                        │ output-channel.ts │  ← OutputChannel 接口 + Console 实现
                        │ renderer.ts       │  ← 终端渲染函数
                        └──────────────────┘
```

**OutputChannel 抽象的关键价值**：命令处理器不再直接 `console.log`，而是通过 `ctx.out` 输出。CLI 注入 `ConsoleOutputChannel`（带 ANSI 彩色输出），Web 注入 `JsonOutputChannel`（返回 JSON 数据），同一套命令处理器代码两种场景通用。

### 3.2 改造范围

| 模块 | 改造内容 | 优先级 |
|------|---------|--------|
| `src/ui/colors.ts` | 统一 ANSI 颜色码，logger.ts 和 index.ts 共用 | P0 |
| `src/ui/output-channel.ts` | OutputChannel 接口 + ConsoleOutputChannel 实现 | P0 |
| `src/ui/renderer.ts` | 抽离渲染函数（printBanner / printStatus / renderMessages） | P0 |
| `src/commands/registry.ts` | 命令注册器 + 分发器（CommandContext 含 `out: OutputChannel`） | P0 |
| `src/commands/*.ts` | 6 个命令处理器拆分，通过 `ctx.out` 输出（不直接 console.log） | P1 |
| `src/agent/react-agent.ts` | 补全事件层（消除 2 处 console.error） | P0 |
| `src/agent/logger.ts` | 改用统一 colors.ts | P0 |
| `src/index.ts` | 瘦身为入口（REPL + 命令分发） | P1 |

---

## 四、详细设计

### 4.1 统一颜色工具 `src/ui/colors.ts`

```typescript
// src/ui/colors.ts — 唯一的 ANSI 颜色定义
export const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
} as const;

/** 来源着色 */
export function sourceColor(s: string): string { ... }
```

- `logger.ts` 删除 `COLOR` 对象，改 `import { COLORS } from '../ui/colors.js'`
- `index.ts` 删除 `C` 对象，改 `import { COLORS as C } from './ui/colors.js'`

### 4.2 渲染函数抽离 `src/ui/renderer.ts`

```typescript
// src/ui/renderer.ts — 所有终端渲染函数集中管理
export function printBanner(opts: BannerOptions): void { ... }
export function printStatus(opts: StatusOptions): void { ... }
export function printTools(tools: ToolInfo[]): void { ... }
export function renderMessages(messages: ChatMessage[]): void { ... }
```

- 接收数据参数，不直接访问 agent/config（数据由调用方传入）
- `index.ts` 调用时组装数据后传入

### 4.3 OutputChannel 抽象 `src/ui/output-channel.ts`

**核心设计**：命令处理器的输出不直接 `console.log`，而是通过 `OutputChannel` 接口抽象。CLI 和 Web 各实现一个，同一套命令处理器代码在两种场景通用。

```typescript
// src/ui/output-channel.ts — 输出抽象层

/**
 * 命令处理器的输出通道
 * - CLI 场景：ConsoleOutputChannel（带 ANSI 彩色输出）
 * - Web 场景：JsonOutputChannel（收集数据返回 JSON，由 Web 入口实现）
 */
export interface OutputChannel {
  /** 常规输出（替代 console.log） */
  log(message: string): void;
  /** 错误输出（代替 console.error） */
  error(message: string): void;
  /** 结构化数据输出（列表/表格等，Web 可直接序列化为 JSON） */
  data(data: unknown): void;
  /** 空行（CLI 输出换行，Web 可忽略） */
  blank(): void;
}

/**
 * 控制台输出实现（CLI 默认）
 * 彩色输出到 process.stdout / process.stderr
 */
export class ConsoleOutputChannel implements OutputChannel {
  constructor(private colors: typeof COLORS) {}
  log(message: string): void { console.log(message); }
  error(message: string): void { console.error(message); }
  blank(): void { console.log(''); }
  data(data: unknown): void {
    // CLI 场景：data 结构包含 { items, format } 字段，按格式渲染为文本
    // format='list' → 逐行输出；format='table' → 对齐表格
    // 简单场景可直接 JSON.stringify
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  }
}

/**
 * JSON 输出实现（Web 场景使用，在 server.ts 中实现）
 * 收集所有输出，返回结构化数据供 HTTP 响应
 *
 * Web 实现示例（不在 Task-18 范围内，仅说明设计）：
 * export class JsonOutputChannel implements OutputChannel {
 *   private messages: OutputMessage[] = [];
 *   log(message: string) { this.messages.push({ type: 'log', message }); }
 *   error(message: string) { this.messages.push({ type: 'error', message }); }
 *   data(data: unknown) { this.messages.push({ type: 'data', data }); }
 *   blank() { /* no-op */ }
 *   getMessages(): OutputMessage[] { return this.messages; }
 * }
 */
```

**命令处理器中的使用方式**：

```typescript
// 改造前（直接 console.log）
console.log(`  ${C.bold}${key}${C.reset} = ${JSON.stringify(val)}`);

// 改造后（通过 OutputChannel）
ctx.out.log(`  ${ctx.colors.bold}${ctx.colors.cyan}${key}${ctx.colors.reset} = ${JSON.stringify(val)}`);
// 或结构化输出：
ctx.out.data({ key, value: val, source: src });
```

### 4.4 命令注册器 `src/commands/registry.ts`

```typescript
// src/commands/registry.ts — 命令注册与分发
export interface CommandContext {
  agent: ReActAgent;
  configLoader: ConfigLoader;
  configWriter: ConfigWriter;
  mcpManager: MCPManager;
  registry: ToolRegistry;
  skillLoader: SkillLoader;
  sessionStore: SessionStore | null;
  rl: readline.Interface;
  out: OutputChannel;        // 输出通道（CLI: ConsoleOutputChannel, Web: JsonOutputChannel）
  colors: typeof COLORS;     // 颜色工具（CLI 用 ANSI, Web 可用空实现）
}

export interface CommandHandler {
  name: string;           // 命令名（如 /config）
  description: string;
  match: (input: string) => boolean;  // 是否匹配
  execute: (input: string, ctx: CommandContext) => Promise<void>;
}

export class CommandRegistry {
  private handlers: CommandHandler[] = [];
  register(handler: CommandHandler): void { ... }
  async dispatch(input: string, ctx: CommandContext): Promise<boolean> { ... }
}
```

**设计要点**：
- `CommandContext` 封装所有依赖，命令处理器不再直接 import 单例
- `ctx.out` 提供输出通道，CLI 和 Web 各实现一个 `OutputChannel`
- `ctx.colors` 提供颜色工具，Web 场景可注入无 ANSI 的空实现
- `match()` 方法支持灵活匹配（前缀 / 精确 / 正则）
- `dispatch()` 返回 `boolean`（是否匹配到命令），未匹配则交由 Agent 处理
- 命令处理器通过 `ctx` 访问依赖，可被替换（测试时注入 mock）

### 4.5 命令处理器拆分

```
src/commands/
├── registry.ts          ← 命令注册器 + CommandContext 类型
├── config-command.ts    ← /config（list/get/set/delete/path）
├── mcp-command.ts       ← /mcp（list/add/remove/reload/test）
├── tools-command.ts     ← /tools（list/enable/disable/reload）
├── skill-command.ts     ← /skill（list/reload/show）
├── session-command.ts   ← /session（list/load/save/new/delete）
└── memory-command.ts    ← /memory（status/curated/episodic/search/dream/gate/init）
```

每个命令处理器文件结构：

```typescript
// src/commands/config-command.ts
export const configCommand: CommandHandler = {
  name: '/config',
  description: '配置管理',
  match: (input) => input.toLowerCase().startsWith('/config'),
  async execute(input, ctx) {
    // 原有 handleConfig 逻辑，改用 ctx 替代直接 import
    // 所有输出通过 ctx.out，不直接 console.log
    // 例如：ctx.out.log(`${ctx.colors.bold}配置${ctx.colors.reset} ...`)
    // 或结构化：ctx.out.data({ key, value, source })
  },
};
```

**拆分约束**：每个命令处理器中 `grep 'console\.'` 必须为 0，所有输出通过 `ctx.out`。

### 4.6 Agent 核心事件层补全

[react-agent.ts:660](file:///d:/workspace/loop-agent-command/src/agent/react-agent.ts#L660) — 会话保存失败：

```typescript
// 改造前
console.error('[session] 自动保存失败:', e instanceof Error ? e.message : String(e));

// 改造后：通过 onWarning 事件输出（新增事件钩子）
await safeEvents.onWarning?.({
  level: 'warning',
  message: `会话自动保存失败: ${e instanceof Error ? e.message : String(e)}`,
  context: 'session',
});
```

[react-agent.ts:719](file:///d:/workspace/loop-agent-command/src/agent/react-agent.ts#L719) — 事件监听器异常：

```typescript
// 改造前
console.error(`[events.${String(hook)}] 监听器异常:`, e);

// 改造后：走 debug.log（不穿透到控制台，因为 console 本身可能就是出问题的 listener）
debug.log(`[events.${String(hook)}] 监听器异常: ${e instanceof Error ? e.message : String(e)}`);
```

**AgentEvents 新增钩子**：

```typescript
// types.ts — AgentEvents 新增
onWarning?(info: { level: 'warning' | 'error'; message: string; context?: string }): void | Promise<void>;
```

### 4.7 index.ts 瘦身

改造后的 `index.ts` 只负责：

1. 初始化（配置、工具、MCP、记忆、会话）—— 保留，约 60 行
2. 构建 `CommandContext`
3. 注册命令到 `CommandRegistry`
4. REPL 循环 + 命令分发
5. 退出处理（Dreaming + 清理）

约 100-120 行，职责清晰。

---

## 五、实施计划

### 阶段一：P0 — 基础设施（不影响现有功能）

| 步骤 | 内容 | 涉及文件 |
|------|------|---------|
| 5.1 | 新建 `src/ui/colors.ts`，统一 ANSI 定义 | 新建 |
| 5.2 | `logger.ts` 删除 `COLOR`，改 import | 修改 |
| 5.3 | `index.ts` 删除 `C`，改 import | 修改 |
| 5.4 | 新建 `src/ui/output-channel.ts`，定义 `OutputChannel` 接口 + `ConsoleOutputChannel` 实现 | 新建 |
| 5.5 | 新建 `src/ui/renderer.ts`，搬迁渲染函数 | 新建 |
| 5.6 | `index.ts` 的 `printBanner` / `printStatus` / `printTools` / `renderMessages` 改为调用 renderer | 修改 |
| 5.7 | `react-agent.ts` 补全事件层（2 处 console.error） | 修改 |
| 5.8 | `types.ts` 新增 `onWarning` 钩子 | 修改 |

**验证**：`npx tsc --noEmit` 编译通过 + `npx vitest run` 全量测试通过 + 手动启动 CLI 验证输出无变化。

### 阶段二：P1 — 命令层拆分

| 步骤 | 内容 | 涉及文件 |
|------|------|---------|
| 5.9 | 新建 `src/commands/registry.ts`（CommandContext 含 `out`/`colors` + CommandHandler + CommandRegistry） | 新建 |
| 5.10 | 拆分 `config-command.ts`（从 index.ts 的 handleConfig 搬迁，所有输出改用 `ctx.out`） | 新建 |
| 5.11 | 拆分 `mcp-command.ts`（含 interactiveAddMcp，输出改用 `ctx.out`） | 新建 |
| 5.12 | 拆分 `tools-command.ts`（输出改用 `ctx.out`） | 新建 |
| 5.13 | 拆分 `skill-command.ts`（输出改用 `ctx.out`） | 新建 |
| 5.14 | 拆分 `session-command.ts`（输出改用 `ctx.out`） | 新建 |
| 5.15 | 拆分 `memory-command.ts`（输出改用 `ctx.out`） | 新建 |
| 5.16 | `index.ts` 改为入口：构建 CommandContext（注入 `ConsoleOutputChannel`）→ 注册命令 → REPL 分发 | 修改 |

**验证**：每个命令拆分后单独 `tsc --noEmit` + 全量测试 + 手动测试所有斜杠命令 + `grep 'console\.'` 确认命令处理器无直写。

### 阶段三：P2 — 可选优化（后续按需）

| 步骤 | 内容 |
|------|------|
| 5.17 | `sourceColor` 等辅助函数搬迁到 `src/ui/colors.ts` |
| 5.18 | `parseScope` / `parseValue` 等工具函数提取到 `src/commands/utils.ts` |
| 5.19 | 考虑 Agent 实例通过依赖注入替代全局单例（需评估改动面） |

---

## 六、文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/ui/colors.ts` | 统一 ANSI 颜色码 |
| 新建 | `src/ui/output-channel.ts` | OutputChannel 接口 + ConsoleOutputChannel 实现 |
| 新建 | `src/ui/renderer.ts` | 终端渲染函数集中管理 |
| 新建 | `src/commands/registry.ts` | 命令注册器 + 分发器（CommandContext 含 out/colors） |
| 新建 | `src/commands/config-command.ts` | /config 处理器（通过 ctx.out 输出） |
| 新建 | `src/commands/mcp-command.ts` | /mcp 处理器（通过 ctx.out 输出） |
| 新建 | `src/commands/tools-command.ts` | /tools 处理器（通过 ctx.out 输出） |
| 新建 | `src/commands/skill-command.ts` | /skill 处理器（通过 ctx.out 输出） |
| 新建 | `src/commands/session-command.ts` | /session 处理器（通过 ctx.out 输出） |
| 新建 | `src/commands/memory-command.ts` | /memory 处理器（通过 ctx.out 输出） |
| 修改 | `src/agent/react-agent.ts` | 2 处 console.error → 事件/debug |
| 修改 | `src/agent/logger.ts` | 改用统一 colors.ts |
| 修改 | `src/types.ts` | AgentEvents 新增 onWarning 钩子 |
| 修改 | `src/index.ts` | 瘦身为入口（~100 行，注入 ConsoleOutputChannel） |

---

## 七、验收清单

- [ ] 7.1 `npx tsc --noEmit` 编译零错误
- [ ] 7.2 `npx vitest run` 全量测试通过（含已有测试）
- [ ] 7.3 CLI 启动后所有斜杠命令功能不变（/config /mcp /tools /skill /session /memory /status /reset /help）
- [ ] 7.4 `react-agent.ts` 中 `grep -n 'console\.'` 仅剩 debug 相关（无穿透事件层的直写）
- [ ] 7.5 `logger.ts` 和 `index.ts` 不再各自定义 ANSI 颜色码
- [ ] 7.6 `index.ts` 行数 ≤ 150 行（原 1394 行）
- [ ] 7.7 每个命令处理器文件独立，不直接 `import { agent }`，通过 `CommandContext` 访问依赖
- [ ] 7.8 `src/commands/` 下每个文件 `grep 'import.*from.*react-agent'` 无单例导入
- [ ] 7.9 渲染函数（printBanner 等）不直接访问 agent/config，数据由参数传入
- [ ] 7.10 `src/commands/` 下每个文件 `grep 'console\.'` 为 0（所有输出通过 `ctx.out`）
- [ ] 7.11 `OutputChannel` 接口定义在 `src/ui/output-channel.ts`，`ConsoleOutputChannel` 实现可用
- [ ] 7.12 `CommandContext` 包含 `out: OutputChannel` 和 `colors` 字段

---

## 八、预期收益

| 维度 | 改造前 | 改造后 |
|------|--------|--------|
| index.ts 行数 | 1394 行 | ~100 行 |
| ANSI 颜色定义 | 2 份重复 | 1 份统一 |
| Agent 核心穿透直写 | 2 处 console.error | 0 处 |
| 命令处理器可替换性 | 硬编码在 index.ts | 通过 CommandRegistry 注册，可增删 |
| 命令处理器输出方式 | 直接 console.log | 通过 OutputChannel 抽象，CLI/Web 通用 |
| 接入 Web UI 需改动 | index.ts 全改 | 注入 JsonOutputChannel + 自定义 events |
| 命令处理器 Web 复用度 | 0%（全部硬编码 console.log） | ~90%（仅交互式命令需适配） |
| 单元测试命令处理器 | 无法（依赖全局单例） | 可注入 mock CommandContext + mock OutputChannel |
