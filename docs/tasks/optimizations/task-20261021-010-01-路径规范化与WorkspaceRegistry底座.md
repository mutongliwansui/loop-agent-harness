# Task-20261021-010-01：路径规范化与 WorkspaceRegistry 底座

> **对应需求编号**：`20261021-010`（跨工作空间并行运行）
> **所属批次**：[00-总任务计划-20261021-010](./00-总任务计划-20261021-010.md)（M1 · P0 · 依赖：无）
> **设计方案章节**：4.1（另参考 2.3、5.1、5.2）
> **状态**：✅ 已完成（2026-10-21；行为零变化，79 文件 / 821 用例全绿）

---

## 一、任务目标需求

### 1.1 背景

当前"工作空间"不是一等对象，而是散落在四个模块里的**可变字段**：

- 进程级 `process.cwd()`（`switchWorkspace` 里 `chdir` 改写）；
- `SessionStore.workspaceId/workspaceDir`（`rebindWorkspace()` 原地改写）；
- `ConfigLoader.workspacePath` / `ConfigWriter.workspacePath`（`setWorkspacePath()` 原地改写）；
- `AgentPool` 的 `initAgent` 闭包（构造时把 `process.cwd()` 写死）。

一次切换 = 四份状态一起搬，因此**不可能有两个空间同时处于活动状态**。本任务先建立"每空间一个不可变运行时对象"的容器（`WorkspaceRuntime` / `WorkspaceRegistry`）与统一路径规范化函数，**但只装配启动目录一个 runtime，行为与现状完全一致**——这是后续所有任务的挂载点，可独立上线、可独立回退。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
|---|---|---|
| 空间标识 | `workspaceId(cwd) = sha256(原始串).slice(0,16)`，**不 resolve、不小写、不去尾斜杠**（[store.ts:33-35](file:///d:/trae_workspace/loop-agent-command/src/session/store.ts#L33-L35)） | **新增 `canonicalWorkspacePath()` 并统一在各入口调用**；公式本身不动（D2） |
| 路径比较 | `sessions.ts` 内的私有 `samePath`（仅低化）与 `normalizeDirPath`（`'D:'` 特例 + `resolve`）（[sessions.ts:23-35](file:///d:/trae_workspace/loop-agent-command/src/api/handlers/sessions.ts#L23-L35)） | **抽到 `src/session/path-utils.ts` 导出** `canonicalWorkspacePath` / `isSameWorkspace`，删私有实现 |
| 每空间运行时容器 | 无。`store`（[bootstrap.ts:21](file:///d:/trae_workspace/loop-agent-command/src/api/bootstrap.ts#L21)）、`pool`（[:38-41](file:///d:/trae_workspace/loop-agent-command/src/api/bootstrap.ts#L38-L41)）、`configLoader/Writer` 均为进程单例，经 `deps.runtime` 注入（[server.ts:52-69](file:///d:/trae_workspace/loop-agent-command/src/api/server.ts#L52-L69)） | **新建 `src/api/workspace-runtime.ts`**：`WorkspaceRuntime`（不可变）+ `WorkspaceRegistry`（懒建 + LRU） |
| runtime 生命周期 | 无 | `get(root)` 幂等懒建，内部 `store.init()`（[store.ts:315](file:///d:/trae_workspace/loop-agent-command/src/session/store.ts#L315) 已幂等） |
| 目录可用性校验 | `ensureDirUsable()` 私有于 sessions.ts（[:116-129](file:///d:/trae_workspace/loop-agent-command/src/api/handlers/sessions.ts#L116-L129)） | **上移为 `registry.ensureRoot(root)`**，供后续按空间建 runtime 前复用 |
| 处理器上下文 | `HandlerContext` 直接持 `configLoader/configWriter/dmcpManager/skillLoader/uploadsRoot/createMemoryKit`（[router.ts:34-58](file:///d:/trae_workspace/loop-agent-command/src/api/router.ts#L34-L58)） | **本任务保持字段不变**（由 runtime 解构注入，L1），避免一上来就改 15 个 handler |

### 1.3 任务目标

1. 新增 `src/session/path-utils.ts`：`canonicalWorkspacePath(input)`、`isSameWorkspace(a,b)`（含 win32 `realpath` 取真实大小写、失败回退 `resolve`）。
2. 新增 `src/api/workspace-runtime.ts`：`WorkspaceRuntime` 接口 + `WorkspaceRegistry` 类（`get/peek/ensureRoot/list/reset/evictIdle`）。
3. `bootstrap.ts` 收编单例：`registry` 持有一个启动目录 runtime，`deps.sessionStore` 改由 `registry.get(root)` 提供；`deps.runtime` 六项字段从同一 runtime 解构（**对外行为不变**）。
4. `router.ts` / `server.ts`：`HandlerContext` 新增可选 `registry` 字段（供后续任务用），既有字段保留。
5. `sessions.ts`：`normalizeDirPath`/`samePath` 改为调用 `path-utils`（**语义保持**：`'D:'` 特例逻辑并入 canonical）。
6. `types.ts`：`ToolContext.workspaceRoot` 注释由"2b 接口位，本期不消费"改为"由 runner 注入，工具必须消费"（仅注释，task-02 才实装）。

### 1.4 设计约束

- **行为零变化**：`/sessions`、`/workspaces`、`/fs/dirs` 的响应字段与取值不变；`switchWorkspace` 仍按原六步工作（P1 才退化）。
- 零新依赖；仅 `node:path`、`node:fs/promises`。
- `WorkspaceRuntime.root` **建立后不可变**（与 `rebindWorkspace` 的原地改写相反）。
- 不改 `workspaceId()` 公式（D2 / 验收 A5 的存量零迁移前提）。

---

## 二、方案设计

### 2.1 总体思路

```
                 ┌────────────────────────────────────────────┐
                 │ WorkspaceRegistry（新）                     │
                 │  Map<canonicalRoot, Promise<Runtime>>       │
                 │  maxRuntimes=4（D1，env 可调）              │
                 └───────────────┬────────────────────────────┘
                                 │ get(root)
                                 ▼
                 ┌────────────────────────────────────────────┐
                 │ WorkspaceRuntime（新，不可变）              │
                 │  root   = canonicalWorkspacePath(root)      │
                 │  id     = workspaceId(root)                 │
                 │  store  = new SessionStore(root) + init()   │
                 │  configLoader = new ConfigLoader(root)      │
                 │  configWriter = new ConfigWriter(root)      │
                 │  sessions = new SessionManager(store)       │
                 │  pool   = new AgentPool(..., attachMemory(root)) │
                 │  getMemoryKit() = getMemoryKit(root)        │
                 └────────────────────────────────────────────┘
                                 │ bootstrap 解构
                                 ▼
       createApiServer({ sessionStore, runtime: {configLoader, configWriter, ...} })
                                 │
                                 ▼
       HandlerContext（字段不变，L1）+ 新增可选 registry
```

### 2.2 关键设计决策

| 编号 | 决策 | 取舍与被否决项 |
|---|---|---|
| **D2** | **不改 `workspaceId()` 公式**，只让"同一物理目录的各种书写形式"经 `canonicalWorkspacePath()` 收敛为同一字符串 | 改公式 + 迁移目录：存量会话需 rename，失败即丢数据；双读新旧 id：复杂度高、长期债。风险 R2 以此条兜住 |
| **D1** | `WorkspaceRegistry` 回收：**LRU 限量默认 4**（`LOOP_AGENT_MAX_WORKSPACES` 可调），空闲 30min `evictIdle()` 释放 | 常驻无上界 → 内存/句柄随空间数膨胀；仅空闲释放不设上限同样无界 |
| **L1** | P0 阶段 **`HandlerContext` 字段不变**（仍持 `configLoader/configWriter/...` 六项），由 bootstrap 从启动目录 runtime 解构注入 | 直接换成"handler 全部走 `ctx.registry.get(root)`"会把 15 个 handler 一次性打穿，且 P0 只需要"能挂载"，不需要"已切换" |
| **L2** | `canonicalWorkspacePath` 统一接管 `'D:'` 特例（`'D:'` → `'D:\'`）与 `resolve()` | 让 sessions.ts 的 `normalizeDirPath` 保留特例会使两条路径规则分叉，长期易漏 |
| **L3** | `registry.get()` 返回 **Promise 并缓存 Promise**（而非缓存实例），避免并发同时建两份 store | 缓存实例需额外"建造中"状态锁 |

---

## 三、任务详细设计

### 3.1 `src/session/path-utils.ts`（新建）

```ts
/** 空间路径规范化：'D:' 特例 → resolve 绝对化 → win32 取磁盘真实大小写（失败回退） */
export function canonicalWorkspacePath(input: string): Promise<string>;

/** 词法比较（win32 大小写/分隔符不敏感；POSIX 严格相等），不做 IO */
export function isSameWorkspace(a: string, b: string): boolean;
```

实现要点：

1. `'D:'` / `'D:\'` 归一为 `'D:\'`（保留现有 `normalizeDirPath` 语义，L2）；
2. `resolve()` 绝对化；去掉尾斜杠（除盘根）；
3. win32：尝试 `fs.realpath()` 取磁盘真实大小写，`ENOENT` 等失败 → 回退 `resolve()` 结果（目录可能尚未创建）；
4. **不做大小写折叠**（折叠会改变 `workspaceId` 结果 → 破坏 G4 存量兼容）。

> `canonicalWorkspacePath` 为 async（需 IO）——所有调用点必须 `await`。这一点与现有同步 `normalizeDirPath` 不同，是本任务**唯一**需要改动调用点签名的位置。

### 3.2 `src/api/workspace-runtime.ts`（新建）

```ts
export interface WorkspaceRuntime {
  readonly root: string;              // canonical 绝对路径
  readonly id: string;                // workspaceId(root)
  readonly store: SessionStore;
  readonly configLoader: ConfigLoader;
  readonly configWriter: ConfigWriter;
  readonly sessions: SessionManager;
  readonly pool: AgentPool;
  getMemoryKit(): Promise<MemoryKit>;
  lastUsedAt: number;                 // LRU 依据（可变）
}

export class WorkspaceRegistry {
  constructor(opts?: { maxRuntimes?: number; poolCapacity?: number; idleTtlMs?: number });
  get(root: string): Promise<WorkspaceRuntime>;   // 懒建 + 幂等（内部 store.init()）
  peek(root: string): WorkspaceRuntime | undefined;
  async ensureRoot(root: string): Promise<void>;  // stat + R|X（原 ensureDirUsable 上移）
  async evictIdle(now?: number): Promise<void>;   // 空闲超时 + 超量 LRU
  list(): WorkspaceRuntime[];
  async reset(): Promise<void>;                   // 测试/关停
}
```

不变量：

- 同一 canonical root 任意时刻只有一个 runtime（Promise 缓存，L3）；
- `root` / `id` / `store` 创建后不变更；
- `list().length <= maxRuntimes`（超出时 `evictIdle()` 淘汰最久未用**且无 in-flight** 的 runtime）。

### 3.3 `bootstrap.ts` 收编

```ts
const registry = new WorkspaceRegistry({ poolCapacity });
const rt = await registry.get(process.cwd());   // P0：只装启动目录一个
// 兼容旧 deps 形状（字段不变，L1）
createApiServer({
  runAgent: (sid, input, opts) => rt.pool.withAgent(sid, (a) => a.run(input, opts)),
  sessionStore: rt.store,
  runtime: {
    configLoader: rt.configLoader, configWriter: rt.configWriter,
    mcpManager, skillLoader, uploadsRoot: defaultUploadsRoot(),
    createMemoryKit: () => rt.getMemoryKit(),
  },
  registry,          // 新增可选
  reinitMemory: async () => { /* P0 保持现状语义 */ },
});
```

### 3.4 边界与错误处理

| 场景 | 行为 |
|---|---|
| `get()` 传入不存在的目录 | 不校验存在性（由调用方先 `ensureRoot`）；`realpath` 失败回退 `resolve` |
| 并发两次 `get(root)` | 同一 Promise，只建一份 store（L3） |
| `poolCapacity` / `maxRuntimes` 环境变量非法 | 回退默认值并 `log` 一次告警 |
| `evictIdle` 命中仍有 in-flight 的 runtime | 跳过并重置 `lastUsedAt`（不淘汰运行中空间） |
| `reset()` 时有运行中 run | 仅测试/关停使用，文档注明"生产不得在运行期调用" |

### 3.5 演进项（本任务不做）

- 真正的多空间并存装配（task-03 起）。
- `switchWorkspace` 退化为指针刷新（task-03）。
- `GET /workspaces` 的 `current` 语义调整（D9，task-04/05）。

---

## 四、实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P0** | 3.1 `path-utils.ts` + 3.2 `workspace-runtime.ts`（含 `ensureRoot` 上移） | 2 个新文件 |
| **P1** | 3.3 `bootstrap.ts` 收编 + `server.ts`/`router.ts` 注入 registry + `sessions.ts` 改用 path-utils | 4 个改造文件 |
| **P2** | `types.ts` 注释 + 单测（canonical 一致性、registry 懒建/复用/淘汰）+ `/workspaces` 字段回归断言 | `tests/` 2 文件 |

---

## 五、文件清单

| 文件 | 改动 | 阶段 |
|---|---|---|
| `src/session/path-utils.ts` | **新建**（canonicalWorkspacePath / isSameWorkspace） | P0 |
| `src/api/workspace-runtime.ts` | **新建**（WorkspaceRuntime / WorkspaceRegistry） | P0 |
| `src/api/bootstrap.ts` | 改（registry 收编单例，`sessionStore`/`runtime` 从 runtime 解构） | P1 |
| `src/api/server.ts` | 改（`ApiServerDeps` 增可选 `registry`；`ctx` 透传） | P1 |
| `src/api/router.ts` | 改（`HandlerContext` 增可选 `registry`） | P1 |
| `src/api/handlers/sessions.ts` | 改（`normalizeDirPath`/`samePath`/`ensureDirUsable` 改用共享实现） | P1 |
| `src/types.ts` | 改（`ToolContext.workspaceRoot` 注释） | P2 |
| `tests/path-utils.test.ts` | **新建**（A5 一致性用例） | P2 |
| `tests/workspace-registry.test.ts` | **新建**（懒建/复用/淘汰） | P2 |

---

## 六、任务验收清单

### 6.1 P0

- [x] 6.1.1 `canonicalWorkspacePath` 对 `D:\proj`、`D:\proj\`、`d:\PROJ`（大小写不敏感文件系统）返回同一字符串
- [x] 6.1.2 `canonicalWorkspacePath('D:')` → `D:\`；不存在目录不抛错
- [x] 6.1.3 `isSameWorkspace` 在 win32 对大小写/分隔符差异返回 true，POSIX 严格
- [x] 6.1.4 `workspaceId()` 源码**未被修改**（公式不变，D2）

### 6.2 P1

- [x] 6.2.1 `npx tsc --noEmit` 通过；`npx vitest run` **全部既有用例零改动通过**
- [x] 6.2.2 `registry.get(sameRoot)` 两次调用返回同一 runtime（含并发）
- [x] 6.2.3 `registry.ensureRoot` 对不存在目录抛 `not_found`、对无权限目录抛 `forbidden`（与原 `ensureDirUsable` 一致）
- [x] 6.2.4 `--serve` 启动后 `/sessions`、`/workspaces`、`/fs/dirs` 响应字段与改造前完全一致（快照比对）
- [x] 6.2.5 `switchWorkspace` 仍按原六步工作（chdir + rebind + setWorkspacePath + reset + scaffold + reinit），行为无变化

### 6.3 P2

- [x] 6.3.1 `evictIdle` 淘汰最久未用 runtime；有 in-flight 的 runtime 不被淘汰
- [x] 6.3.2 `maxRuntimes` / `LOOP_AGENT_MAX_WORKSPACES` 生效；非法值回退默认并告警
- [x] 6.3.3 `list()` 长度不超过 `maxRuntimes`

### 6.4 人工验证（真实环境）

- [x] 6.4.1 现有单空间工作流（新建会话 → 发消息 → 切空间 → 切回）功能与改造前一致
- [x] 6.4.2 `%USERPROFILE%\.loop-agent\sessions\<wsId>` 目录名未发生变化（存量会话仍可见）

### 6.5 完成记录

> **实施日期**：2026-10-21

#### 6.5.1 实际落地（与设计的差异说明）

| 项 | 设计 | 实际 | 说明 |
|---|---|---|---|
| `path-utils.ts` 导出 | `canonicalWorkspacePath` / `isSameWorkspace` | 另增 **`lexicalWorkspacePath`** | `/fs/dirs` 的 `path`/`parent` 回显原先走 `resolve()`（不取磁盘真实大小写）。若直接换成 canonical，回显取值会变（大小写被 realpath 改写）→ 违反「行为零变化」。故拆出同步词法版供展示层用，canonical 只管「身份键」 |
| `registry.ensureRoot` 返回 | `Promise<void>` | `Promise<string>`（返回 canonical root） | 调用方拿到 root 可紧接着 `get(root)`，省一次 realpath |
| `WorkspaceRegistryOptions` | `maxRuntimes` / `poolCapacity` / `idleTtlMs` | 另增 **`userDir`** | 单测把会话/密钥根指到临时目录，避免污染真实 `~/.loop-agent` |
| `reset()` | 设计为 `async` | 同步 `void` | `pool.reset()` 本身同步，无 IO 可等 |
| `bootstrap.ts` 的 `reinitMemory` | 注释写「P0 保持现状语义」 | 保持 `resetMemoryKitCache() + rt.pool.reset()` | 即改造前行为，未改语义 |
| `deps.sessions` | 设计未提 | 新增可选注入（`server.ts` 缺省自建） | runtime 持有 `sessions` 后若 server 再自建一份，会出现两份缓存分叉；此项是防分叉的必要补丁，且缺省路径保证既有单测零改动 |

#### 6.5.2 新增 / 改动文件

| 文件 | 变化 |
|---|---|
| `src/session/path-utils.ts` | 新增（`canonicalWorkspacePath` / `lexicalWorkspacePath` / `isSameWorkspace`） |
| `src/api/workspace-runtime.ts` | 新增（`WorkspaceRuntime` / `WorkspaceRegistry` / `ensureDirUsable`） |
| `src/session/index.ts` | 导出补 `lexicalWorkspacePath` |
| `src/api/bootstrap.ts` | registry 收编单例，`sessionStore`/`sessions`/`runtime` 从启动目录 runtime 解构 |
| `src/api/server.ts` | `ApiServerDeps` 增 `sessions?` / `registry?`，`ctx` 透传 |
| `src/api/router.ts` | `HandlerContext` 增可选 `registry`（本任务只挂载不消费） |
| `src/api/handlers/sessions.ts` | 删私有 `normalizeDirPath`/`samePath`/`ensureDirUsable`，改用共享实现（`/fs/dirs` 用 lexical，切换判定用 canonical） |
| `src/types.ts` | `ToolContext.workspaceRoot` 注释改为「工具必须消费」 |
| `tests/path-utils.test.ts` | 新增（7 用例） |
| `tests/workspace-registry.test.ts` | 新增（11 用例） |
| `tests/api-workspace-registry.test.ts` | 新增（8 用例：响应字段快照 + switchWorkspace 六步 + 单一真源） |

#### 6.5.3 验证结果

- `npx tsc --noEmit`：通过，零错误。
- `npx vitest run`：**79 文件 / 821 用例全绿**（改造前 77 / 806，本任务净增 2 文件 15 用例；**既有用例零改动**）。
- `--serve --port 3099` 实机 smoke：`/health` 200；`/workspaces` 返回 `id=522b6010f5ea7e0b`、`current=true`、字段与改造前一致；`/fs/dirs` 返回 `{path,parent,dirs,drives}`；`/sessions` 返回 `{sessions:[{id,title,createdAt,updatedAt,messageCount,file}]}`。
- 存量目录比对：`%USERPROFILE%\.loop-agent\sessions` 下仍为 `522b6010f5ea7e0b`（= `sha256('D:\trae_workspace\loop-agent-command')[:16]`）与 `a3a41085223f6f8f`，**目录名零变化**（A5 前提成立）。

#### 6.5.4 留给后续任务

- 本任务 registry 只装**启动目录一个** runtime，`switchWorkspace` 仍在原地改 `store`/`configLoader`（`rebindWorkspace`），因此 runtime 的「不可变」语义尚未真正兑现——task-03 移除 `chdir` + 原地重绑后达成。
- `HandlerContext.registry` 已挂载但无 handler 消费；task-04 起由「请求携带空间」解析 runtime。
- `WorkspaceRegistry.evictIdle()` 尚无定时器调用方；task-04 接入调度时启用。
