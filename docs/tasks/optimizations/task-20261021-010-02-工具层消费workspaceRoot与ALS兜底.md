# Task-20261021-010-02：工具层消费 workspaceRoot 与 ALS 兜底

> **对应需求编号**：`20261021-010`（跨工作空间并行运行）
> **所属批次**：[00-总任务计划-20261021-010](./00-总任务计划-20261021-010.md)（M2 · P1 · 依赖：task-01）
> **设计方案章节**：4.2.1、4.2.2（另参考 5.3、6 章 R1）
> **状态**：✅ 已完成（2026-10-21；`tsc --noEmit` 零错误，81 文件 / 840 用例全绿）

---

## 一、任务目标需求

### 1.1 背景

`switchWorkspace` 里 `process.chdir()` 之所以"看起来能用"，是因为**工具层靠隐式 cwd 解析相对路径**：

```ts
// src/tools/runner.ts:47 —— 工具上下文只传了取消信号
const ctx: ToolContext = { signal };
```

```ts
// src/tools/commandRun.ts:22-23 —— workspaceRoot 是空接口位，实际用 exec 的默认 cwd
// workspaceRoot 为 2b 接口位，本期不消费（默认仍为 exec 的 process.cwd()）
const cwd = args.cwd ? String(args.cwd) : undefined;
```

`fileRead/fileWrite/editFile/grep` 更彻底——直接把 `args.path` 交给 `node:fs`，相对路径由 `process.cwd()` 兜底（[fileWrite.ts:24-36](file:///d:/trae_workspace/loop-agent-command/src/tools/fileWrite.ts#L24-L36)、[grep.ts:33-81](file:///d:/trae_workspace/loop-agent-command/src/tools/grep.ts#L33-L81)）。

**只要还有一处依赖隐式 cwd，移除 chdir 就会变成"静默错位"**（风险 R1：不报错，只在错误目录读写，最坏写坏别的项目）。所以本任务必须先于 task-03 完成：让工具层**显式**拿到空间根，并留一条 ALS 兜底链。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
|---|---|---|
| 工具上下文携带根 | `ToolContext.workspaceRoot?: string` **已声明但无人填**（[types.ts:12-16](file:///d:/trae_workspace/loop-agent-command/src/types.ts#L12-L16)） | `ToolRunner.run` 负责注入（D3 显式优先） |
| 上下文注入点 | `runner.run(tool, args, { signal, timeout })`，唯一调用点在 agent 主循环（[react-agent.ts:848](file:///d:/trae_workspace/loop-agent-command/src/agent/react-agent.ts#L848)） | `RunOptions` 增可选 `workspaceRoot`，agent 透传自己的根 |
| agent 的根 | `attachMemory(kit, cwd)` 已有 cwd 参数（[react-agent.ts:294](file:///d:/trae_workspace/loop-agent-command/src/agent/react-agent.ts#L294)），但**不保存** | 新增 `setWorkspaceRoot(root)`；池 `initAgent` 钩子同时调用 |
| 池按空间建实例 | `AgentPool` 的 `initAgent` 是**池级固定钩子**（[agent-pool.ts:57-63](file:///d:/trae_workspace/loop-agent-command/src/agent/agent-pool.ts#L57-L63)） | 每空间一池（D4），钩子内传 `rt.root` |
| 相对路径解析规则 | `handlers/fs.ts` 有 `toSlash`/`resolveInWs`，但**是模块私有函数**（[fs.ts:70-86](file:///d:/trae_workspace/loop-agent-command/src/api/handlers/fs.ts#L70-L86)），工具层 import 不到 | **抽到 `src/tools/workspace-fs.ts` 导出**（D15） |
| 深层漏改兜底 | 无 | `node:async_hooks` 的 `AsyncLocalStorage`（D3 第 2 层） |
| MCP server 的 cwd | `createTransport` 只在配置显式给 `cwd` 时传 `cwd`（[client.ts:54-66](file:///d:/trae_workspace/loop-agent-command/src/tools/mcp/client.ts#L54-L66)），未给则继承 `process.cwd()`；`MCPManager` 是**进程级单例、启动期一次性连接** | **不能按空间切换**——改为显式取"启动目录"并在文档声明（D19） |
| 技能加载 | `activate_skill` 走 `skillLoader`（进程单例，方法带 cwd 参数）（[activateSkill.ts:25-28](file:///d:/trae_workspace/loop-agent-command/src/tools/activateSkill.ts#L25-L28)） | 工具本身不需要根；`scan` 的 cwd 由 serve 侧修（task-03，D14） |

### 1.3 任务目标

1. `ToolContext.workspaceRoot` 从"注释占位"变为**实际注入**：`runner.run` 按 `options.workspaceRoot → ALS → process.cwd()` 三级取值。
2. 新增 `src/runtime/workspace-context.ts`：`runWithWorkspace(rt, fn)` / `currentWorkspaceRoot()`（`AsyncLocalStorage`）。
3. `bootstrap.ts` 的 `runAgent` 闭包包一层 `runWithWorkspace(rt, ...)`，保证池内 agent 与其工具调用在同一 ALS 上下文里。
4. 6 个内置工具改造：相对路径按 `ctx.workspaceRoot`（或 ALS 兜底）解析，**不再依赖 `process.cwd()`**。
5. 新增 `src/tools/workspace-fs.ts`：`toSlash` / `resolveInWs` / `resolveToolPath`（D15），`handlers/fs.ts` 改为复用，删私有副本。
6. MCP stdio `cwd` 语义明确化（D19）。
7. 单测覆盖：无 chdir 情况下两套临时目录的相对路径读写各自落点正确。

### 1.4 设计约束

- **CLI 零改动红线**（D13/A7.1）：`src/cli/**`、`src/commands/**` 不出 diff；CLI 不传 root → 三级取值回退到 `process.cwd()`，行为与今天完全一致。
- **不引入新的越界拒绝**（D20）：现有工具允许绝对路径访问空间外（`activate_skill` 明确引导读 `~/.loop-agent/skills/...`、上传目录也在空间外），本任务只把"相对路径基准"从隐式 cwd 换成显式根。
- 零新依赖（`node:async_hooks` 为内置）。

---

## 二、方案设计

### 2.1 总体思路

```
serve（每空间一个 runtime）                      CLI（单空间，零改动）
  bootstrap.runAgent(sid, input, opts)
        │
        ▼
  runWithWorkspace(rt, () =>                     ReActAgent.run()
        rt.pool.withAgent(sid, a => a.run(...)) )     │ runner.run(tool,args,{signal})
        │                                             │ （不带 workspaceRoot）
        │  ALS store = { root: rt.root, id }          │
        ▼                                             ▼
  agent.workspaceRoot = rt.root  ──► runner.run(..., { workspaceRoot })
                                                      │
                                     ToolRunner 取值优先级（D3）：
                                     ① options.workspaceRoot（显式，agent 传入）
                                     ② currentWorkspaceRoot()（ALS 兜底）
                                     ③ process.cwd()（CLI / 单测默认）
                                                      │
                                                      ▼
                                     ToolContext = { signal, workspaceRoot }
                                                      │
        ┌─────────────┬───────────────┬───────────────┴──────┬──────────────┐
        ▼             ▼               ▼                      ▼              ▼
   commandRun     fileRead        fileWrite               editFile        grep
   cwd=wsRoot     resolveToolPath(wsRoot, path) × 4（统一走 workspace-fs）
```

### 2.2 关键设计决策

| 编号 | 决策 | 取舍与被否决项 |
|---|---|---|
| **D3** | **显式 `ToolContext.workspaceRoot` 为主 + `AsyncLocalStorage` 兜底**，`process.cwd()` 仅作最后回退 | 只用 ALS：隐式、难静态检查、旧式 callback 会丢上下文；只用显式：漏改任何一处就静默错位，无兜底 |
| **D15** | 越界/解析规则抽到 **`src/tools/workspace-fs.ts`** 导出，`handlers/fs.ts` 与工具层共用一份 | 工具层各自实现一份：规则分叉（`..` 校验、`toSlash` 归一）后必有一处漏；直接 import `handlers/fs.ts`：API 层反向被 tools 依赖，层次颠倒 |
| **D19** | **MCP stdio server 的 cwd 不随空间切换**：显式取 `config.cwd ?? 启动目录`，并在文档/日志声明"进程级外部资源" | 每空间一套 MCP 连接：连接数 × 空间数、启动耗时与句柄暴涨；连接期注入 wsRoot：`MCPManager` 是启动期单例，切换空间时无法重连（会中断运行中 run） |
| **D20** | 工具层路径策略 = **相对路径按空间根解析，绝对路径原样放行**；不新增"必须落在空间内"的拒绝 | 强制 `resolveInWs` 越界拒绝：会打断 `activate_skill` 引导的 `~/.loop-agent/skills` 读取、上传目录访问等合法场景（属**行为变更**，超出本需求范围） |

---

## 三、任务详细设计

### 3.1 `src/runtime/workspace-context.ts`（新建）

```ts
export interface WorkspaceStore { root: string; id: string }

/** 进入某空间的 ALS 上下文执行 fn（嵌套时以最内层为准，并校验一致性） */
export function runWithWorkspace<T>(rt: { root: string; id: string }, fn: () => Promise<T>): Promise<T>;

/** 当前 ALS 根；无上下文 → undefined（CLI / 单测） */
export function currentWorkspaceRoot(): string | undefined;
```

实现要点：

- `new AsyncLocalStorage<WorkspaceStore>()`；
- 进入前若外层已有 store 且 `root` 不同 → `debug.log` 一条告警（跨空间嵌套属可疑调用，不抛错以免打断运行）；
- **不得**在 `runWithWorkspace` 内做任何 `chdir`。

### 3.2 `src/tools/workspace-fs.ts`（新建，D15）

```ts
export function toSlash(p: string): string;
/** 越界校验 + 绝对化（原 handlers/fs.ts 私有实现迁入，语义不变） */
export function resolveInWs(root: string, input: string): string;
/** 工具层路径解析（D20）：绝对路径原样返回；相对路径按 root 解析 */
export function resolveToolPath(root: string, input: string): string;
```

`handlers/fs.ts` 改为 `import { toSlash, resolveInWs } from '../../tools/workspace-fs.js'`，删除本地副本，**调用点与行为保持不变**。

### 3.3 `ToolRunner` 注入（`src/tools/runner.ts`）

```ts
export interface RunOptions {
  timeout?: number;
  signal?: AbortSignal;
  /** 空间根（D3 显式优先）：agent 传入；缺省回落 ALS，再回落 process.cwd() */
  workspaceRoot?: string;
}

// run() 内
const workspaceRoot = options.workspaceRoot ?? currentWorkspaceRoot() ?? process.cwd();
const ctx: ToolContext = { signal: options.signal, workspaceRoot };
```

> `runParallel` 透传同一 `workspaceRoot`（同轮多工具必然同空间）。

### 3.4 agent 侧（`src/agent/react-agent.ts`）

```ts
private workspaceRoot?: string;
setWorkspaceRoot(root: string): void { this.workspaceRoot = root; }

// run() 内
const wsRoot = this.workspaceRoot ?? process.cwd();
const skills = cfg.skill.enabled ? skillLoader.scan(wsRoot) : [];
const systemPrompt = cfg.agent.systemPrompt ?? buildSystemPrompt(skills, wsRoot, cfg.vision.enabled);
// 分发工具
const result = await runner.run(c.tool, c.args, { signal: options.signal, workspaceRoot: wsRoot });
```

> `buildSystemPrompt(…, wsRoot, …)` 与 `skillLoader.scan(wsRoot)` 的改造同时消灭 [react-agent.ts:415-416](file:///d:/trae_workspace/loop-agent-command/src/agent/react-agent.ts#L415-L416) 两处 `process.cwd()`（属 task-03 的收口清单，两任务交界处按本设计落地，避免重复改动）。

### 3.5 6 个工具改造

| 工具 | 改动 | 备注 |
|---|---|---|
| `commandRun` | `const cwd = args.cwd ? resolveToolPath(wsRoot, String(args.cwd)) : wsRoot;` | **最关键**：原来无 `args.cwd` 时落 `process.cwd()` |
| `fileRead` | `resolveToolPath(wsRoot, String(args.path))` | 相对路径按空间根 |
| `fileWrite` | 同上（含 `mkdir(dirname(resolved))`） | 落点断言见 6.2.3 |
| `editFile` | 同上 + 校验 `oldText` 唯一匹配 | — |
| `grep` | 同上（`path` 参数解析） | 递归起点跟着走 |
| `activateSkill` | **无需改**（`skillLoader.load/list` 不涉及 cwd） | `scan` 的 cwd 由 serve 侧注入（D14） |

工具内若 `ctx?.workspaceRoot` 缺失 → 回退 `process.cwd()`，并 `debug.log('[tools] 缺少 workspaceRoot，回落 process.cwd()')`（便于 task-06 靠日志发现漏改）。

### 3.6 MCP cwd（D19）

- `createTransport` 保持"配置给 `cwd` 就传"，但 `MCPManager.loadFromConfig()` 在 `cwd` 缺省时**显式填入启动目录**（`startupRoot`，bootstrap 记录），避免依赖隐式 cwd；
- `/mcp` 状态响应与双语文档注明：**MCP server 的工作目录固定为启动目录（或配置显式值），不随 WebUI 切换空间**；
- 人工验证项：配置一个 stdio MCP server（不给 cwd），切空间后其工具行为不变（预期不变）。

### 3.7 边界与错误处理

| 场景 | 行为 |
|---|---|
| `args.path` 为空串 | 保持现有错误路径（`fs` 抛错 → runner 归一为"工具执行失败: …"） |
| `args.cwd` 传相对路径 | 按 `wsRoot` 解析（原来按 `process.cwd()` 解析；chdir 存在时二者等价，移除后必须显式） |
| `args.cwd` 传绝对路径 | 原样使用（不校验是否在空间内，D20） |
| ALS 上下文丢失（旧式 callback） | 显式 `options.workspaceRoot` 优先，不受影响；仅"显式也缺"时才会回退 cwd，并有 debug 日志 |
| 同一 ALS 上下文内嵌另一空间 | 记告警，以最内层为准 |

### 3.8 演进项

- `resolveInWs` 的越界拒绝是否扩展到工具层：**本批次不做**（D20），记入 `docs/optimization_suggestions` 候选。

---

## 四、实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P0** | 3.1 `workspace-context.ts` + 3.2 `workspace-fs.ts`（含 fs.ts 改为复用） | 2 新 + 1 改 |
| **P1** | 3.3 runner 注入 + 3.4 agent 侧 + 3.5 五工具改造 | 7 个文件 |
| **P2** | 3.6 MCP cwd 显式化 + 单测（两空间并行读写落点、ALS 回退、绝对路径放行） | 1 改 + 2 测试 |

---

## 五、文件清单

| 文件 | 改动 | 阶段 |
|---|---|---|
| `src/runtime/workspace-context.ts` | **新建**（ALS） | P0 |
| `src/tools/workspace-fs.ts` | **新建**（toSlash / resolveInWs / resolveToolPath） | P0 |
| `src/api/handlers/fs.ts` | 改（删私有副本，改 import） | P0 |
| `src/tools/runner.ts` | 改（`RunOptions.workspaceRoot` + ctx 注入） | P1 |
| `src/agent/react-agent.ts` | 改（`setWorkspaceRoot` + run 内 wsRoot + 415/416 行） | P1 |
| `src/tools/commandRun.ts` | 改（cwd 显式） | P1 |
| `src/tools/fileRead.ts` / `fileWrite.ts` / `editFile.ts` / `grep.ts` | 改（路径解析） | P1 |
| `src/config/mcp-manager.ts` / `src/tools/mcp/client.ts` | 改（cwd 显式化 + 注释） | P2 |
| `src/api/bootstrap.ts` | 改（`runWithWorkspace` 包裹 + 池钩子 `setWorkspaceRoot`） | P1 |
| `tests/workspace-context.test.ts` | **新建** | P2 |
| `tests/tools-workspace-root.test.ts` | **新建**（临时目录两空间落点） | P2 |

---

## 六、任务验收清单

### 6.1 P0

- [x] 6.1.1 `workspace-fs.ts` 的 `resolveInWs` 与迁移前的私有实现**行为完全一致**（逐行迁移，仅去掉 `function` 前缀）
- [x] 6.1.2 `handlers/fs.ts` 的 `/fs/tree`、`/fs/file`、`/fs/raw`、`/fs/doc2md`、`/fs/search` 五条端点响应与改造前一致（`fs-endpoints.test.ts` 15 用例全绿）
- [x] 6.1.3 `resolveToolPath`：绝对路径原样；相对路径拼 `root`（win32 反斜杠正确，单测覆盖）

### 6.2 P1

- [x] 6.2.1 `runner.run` 在无 `workspaceRoot`、无 ALS 时回落 `process.cwd()`（CLI 语义不变）
- [x] 6.2.2 `runner.run({ workspaceRoot })` 注入的根**优先于** ALS
- [x] 6.2.3 单测：两个临时目录 A/B 各自 `fileWrite` 相对路径 → 文件分别落在 A、B 下，**互不串**
- [x] 6.2.4 单测：`commandRun` 无 `args.cwd` 时执行 `cd`/`pwd` → 输出为注入的根，且 `process.cwd()` 不变（**不 chdir**）
- [x] 6.2.5 `npx tsc --noEmit` 通过；`npx vitest run` 全绿（既有工具测试零改动）

### 6.3 P2

- [x] 6.3.1 `currentWorkspaceRoot()` 在 ALS 外返回 `undefined`
- [x] 6.3.2 `runWithWorkspace` 嵌套不同根 → 产生告警日志（不抛错，以最内层为准）
- [x] 6.3.3 MCP stdio 未配 `cwd` 时显式补启动目录（单测断言回填值；真实 server 的 `pwd` 行为留 task-06 冒烟）

### 6.4 人工验证

- [x] 6.4.1 CLI 普通对话：`commandRun` 默认目录仍为启动目录（A7 项；由「无显式根无 ALS → `process.cwd()`」单测间接覆盖，CLI 侧未传任何 root）
- [x] 6.4.2 serve：两空间各发一条"当前目录"类指令（A3 项）——**依赖 task-03 移除 chdir 后复验**，本任务先由两临时目录单测保证落点正确
- [x] 6.4.3 `activate_skill` 读取全局技能（`~/.loop-agent/skills/...`）仍正常（绝对路径原样放行单测 + `activate-skill.test.ts` 全绿）

### 6.5 完成记录

> **实施日期**：2026-10-21

#### 6.5.1 实际落地（与设计的差异说明）

| 项 | 设计 | 实际 | 说明 |
|---|---|---|---|
| 池钩子注入 `setWorkspaceRoot` | 写在 `bootstrap.ts` 的 `initAgent` 钩子 | 写在 `src/api/workspace-runtime.ts` 的 `build()` | task-01 已把池收编进 runtime，钩子实际在此处；语义与设计一致 |
| `workspace-fs.ts` 导出 | `toSlash` / `resolveInWs` / `resolveToolPath` | 另增 **`toolWorkspaceRoot(ctx)`** | 5 个工具共用「ctx → cwd 兜底 + 缺失日志」，避免复制 5 份 |
| 工具缺根时的日志 | 工具内各自 `debug.log` | 统一由 `toolWorkspaceRoot` 打点 | 文案 `[tools] 缺少 workspaceRoot，回落 process.cwd()` |
| MCP cwd 回填位置 | `MCPManager.loadFromConfig()` | `loadServers()` 内统一 `withExplicitCwd()` | `loadFromConfig`/`loadServer`/`testServer`/`viewServer` 四条连接路径全部覆盖，避免 `/mcp test` 绕开回填 |
| `/mcp` 响应声明 | 注明 cwd 固定启动目录 | **未改响应字段** | 避免破坏既有 API 快照；文档声明留 task-07 双语文档同步 |
| `resolveInWs` 的错误载体 | 设计未提 | `src/tools/workspace-fs.ts` 引入 `ApiHttpError` | 该模块是零依赖叶模块，仅为复用 403 语义；不反向依赖 handler |
| `react-agent` 的 cwd 清理 | 属 task-03 收口清单 | 本任务提前落地 | `skillLoader.scan(wsRoot)` 与 `buildSystemPrompt(..., wsRoot, ...)` 两处与工具改造成对，避免重复改动 |

#### 6.5.2 新增 / 改动文件

| 文件 | 变化 |
|---|---|
| `src/runtime/workspace-context.ts` | 新增（`runWithWorkspace` / `currentWorkspaceRoot`） |
| `src/tools/workspace-fs.ts` | 新增（`toSlash` / `resolveInWs` / `resolveToolPath` / `toolWorkspaceRoot`） |
| `src/api/handlers/fs.ts` | 删私有 `toSlash`/`resolveInWs`，改为共享导入（调用点不变） |
| `src/tools/runner.ts` | `RunOptions.workspaceRoot` + 三级取值注入 `ToolContext` |
| `src/agent/react-agent.ts` | 新增 `_workspaceRoot` / `setWorkspaceRoot` / `workspaceRoot` getter；run 内 `wsRoot` 用于技能扫描、system prompt 与工具分发 |
| `src/api/bootstrap.ts` | `runAgent` 闭包外包 `runWithWorkspace(rt, ...)` |
| `src/api/workspace-runtime.ts` | 池钩子 `setWorkspaceRoot(root)` + `attachMemory(kit, root)` |
| `src/tools/commandRun.ts` / `fileRead.ts` / `fileWrite.ts` / `editFile.ts` / `grep.ts` | 路径按 `ctx.workspaceRoot` 解析（D3/D20） |
| `src/config/mcp-manager.ts` | 启动目录捕获 + `withExplicitCwd()`（D19） |
| `src/tools/mcp/client.ts` | cwd 语义注释 |
| `tests/workspace-context.test.ts` | 新增（5 用例） |
| `tests/tools-workspace-root.test.ts` | 新增（11 用例） |
| `tests/mcp-manager-view.test.ts` | 追加 3 用例（cwd 回填） |

#### 6.5.3 验证结果

- `npx tsc --noEmit`：通过，零错误。
- `npx vitest run`：**81 文件 / 840 用例全绿**（改造前 79 / 821；本任务净增 2 文件 16 用例 + 既有文件追加 3 用例 = 19；既有断言零改动）。
- 关键断言：两个临时目录 A/B 的 `fileWrite`/`fileRead`/`editFile`/`grep` 相对路径各自落点；`commandRun` 无 `args.cwd` 时输出注入根且 `process.cwd()` 不变；`runner` 显式根优先于 ALS、无显式根回落 ALS、两者皆无回落 `process.cwd()`；绝对路径原样放行。
- `src/cli/**`、`src/commands/**` **零 diff**（CLI 不传 root，三级回退保持原语义）。

#### 6.5.4 留给后续任务

- `switchWorkspace` 仍会 `process.chdir()`（task-03 移除）；移除后两空间并行的实机 A3 复验由 task-03/task-06 完成。
- `HandlerContext.registry` 仍未被消费、handler 级 `runWithWorkspace` 包裹随 task-04 接入。
- `/mcp` 响应与双语文档中的「MCP cwd 固定启动目录」声明留 task-07。
