# @loop-agent/main

**主工程宿主层**。回答内核不回答的问题：挂载哪些插件、按什么顺序、启停状态怎么记、清单存哪、进程重启后怎么还原。

不接业务代码，也不反向依赖主工程 `src/`（由 `tests/boundary.test.ts` 静态锁死）。

> **本轮只搭框架，`src/` 一行未迁移。** `src/` 下的 agent / api / tools / memory 等业务组件仍是当前实际运行的实现，`--serve` 与 CLI 走的是原链路；本包目前只提供可编程入口与持久化注册中心，尚未被任何启动路径引用。迁移按「包装不启用 → 双写对照 → 切换删旧」三步推进，另开需求。

## 一、分层判据（为什么会有这个包）

| 层 | 只回答 |
|---|---|
| `@loop-agent/core` | 插件**怎么被定义**、怎么被挂载、怎么被撤销 |
| `@loop-agent/main`（本包） | **挂载哪些**插件、**什么顺序**、**启停状态**、**清单存哪**、**重启怎么还原** |

`core` 的 `PluginRegistry` 已在本轮删除（版本升 `0.2.0`）。原因：它是纯内存的薄封装，属于应用装配职责而非内核定义，且「持久化」是它的明确非目标，留在内核只能靠破坏纯净性实现。

## 二、引用方式

根 `package.json` 已声明 `workspaces: ["core", "main"]`，仓库内直接引用即可：

```ts
import { createMainHost } from '@loop-agent/main';

const app = createMainHost();
await app.start();
// …运行…
await app.stop();
```

- 单副本：`node_modules/@loop-agent/core` 是指向 `core/` 的链接，全仓库只有一份物理副本，`instanceof` 与类引用比较都可靠。
- 打包时**必须**把 `@loop-agent/core` 排除在 bundle 之外（`tsup.config.ts` 已配 `external`），否则插件与宿主各持一份副本，症状是 `instanceof` 全为 false、服务表互不可见，且**静默无报错**。
- `engines.node >= 20.10`。

## 三、宿主入口

```ts
const app = createMainHost({
  logger,                              // 可选，缺省 console
  home,                                // 可选，缺省 ~/.loop-agent（读 LOOP_AGENT_HOME）
  manifestFile,                        // 可选，覆盖清单路径（测试注入临时目录）
  loadPlugin,                          // 可选，覆盖插件加载器（测试注入内存插件）
});

app.host;        // core 宿主：服务表 + 事件总线 + Fiber 树
app.context;     // 根 Context
app.registry;    // PersistentPluginRegistry
app.home;        // 用户目录
await app.start();   // → registry.restore()：读清单并挂载 enabled 插件
await app.stop();    // → registry.dispose()：逆序卸载全部 Fiber + 撤销基础服务
```

`start()` 不会因单个插件加载失败而失败；`stop()` 幂等（重复调用返回同一 Promise），语义是「会话结束」而非「进程退出」。

内置基础服务：`context.get('main:logger')`、`context.get('main:home')`。

## 四、持久化插件注册中心

### 4.1 清单文件

默认位置 `~/.loop-agent/plugins/registry.json`，可用 `LOOP_AGENT_HOME` 整体重定向。

```json
{
  "schemaVersion": 1,
  "entries": [
    { "id": "greeter", "specifier": "./plugins/greeter.mjs", "enabled": true }
  ],
  "updatedAt": "2026-11-14T00:00:00.000Z"
}
```

- **顺序即数组下标**，不存冗余 `order` 字段（双写不一致的经典来源）。
- **只存清单，不存运行期快照**：`Fiber` 引用、服务实例、`apply` 函数、`ACTIVE`/`FAILED` 状态一律每次启动重新推导。
- `enabled` 是一等状态：`false` 表示「已登记但未挂载」，不是删除。

### 4.2 写操作

| 方法 | 语义 | 是否落盘 |
|---|---|---|
| `mount(entry)` | 登记并挂载；`id` 重复抛 `PLUGIN_ID_CONFLICT` | ✅ |
| `unmount(id)` | 卸载 Fiber + 删除条目；未知 `id` 幂等空操作 | ✅（有变更时） |
| `disable(id)` | 卸载 Fiber，**保留条目**、`enabled=false` | ✅（有变更时） |
| `enable(id)` | 重新挂载，条目位置不变；未知 `id` 抛 `PLUGIN_NOT_FOUND` | ✅ |
| `reorder(ids)` | 按给定顺序重排，未列出的按原相对序留在尾部；未知 `id` 抛 `PLUGIN_NOT_FOUND` | ✅ |

另有只读能力：`entries()`（清单副本）、`fiberOf(id)`、`diagnose()`、`dispose()`。

### 4.3 原子写语义

写盘走「**写 tmp → 删目标 → rename**」：读方要么读到旧版本、要么读到新版本，**永不读到半截 JSON**。Windows 上目标存在时 `rename` 会 `EPERM`，故先删再 rename。

同一进程内的写操作经内部串行队列排队（`writeChain`），并发 `mount` 不会交叉写坏 tmp 文件；多进程并发写锁是明确非目标。

**落盘失败不打断操作**：磁盘满/只读目录时内存清单照常更新，错误进 `diagnose().persistError`，`mount` 等方法**不抛错**。

### 4.4 坏档容错

| 场景 | 行为 |
|---|---|
| 清单不存在 | 返回空清单，`restore()` 成空操作 |
| JSON 损坏 / `schemaVersion` 不识别 / `entries` 非数组 | 备份为 `registry.json.bad.<ts>` → 空清单 → 记录错误；**不阻断启动** |
| 条目 `id` 或 `specifier` 缺失/空串 | 跳过该条，其余保留（不算坏档、不备份） |
| 文件内 `id` 重复 | 保留首个 |
| `enabled` 缺失 | 视为 `true`（宽松向后兼容） |

### 4.5 插件只收 ESM

`specifier` 支持相对路径、绝对路径、包名，一律走 `import()` 解析，**只收 ESM**（与 core 的产物格式约定一致）。

模块需导出以下任一形态：

```ts
export default (options) => plugin;   // 工厂
export default plugin;                // 对象/函数直接导出
export const plugin = plugin;
```

单个插件加载失败时：`restore()` 吞掉错误继续挂载其余；`mount()` / `enable()` 这类显式操作把错误抛给调用方，但**条目保留**、`loadError` 记录在 `diagnose()` 里，便于排查。

## 五、诊断

```ts
const diag = app.registry.diagnose();
diag.core;          // core 原始诊断：Fiber 状态 / 服务归属 / 依赖缺失
diag.entries;       // 清单条目 + 运行期 state + loadError
diag.file;          // 清单绝对路径
diag.persistError;  // 最近一次落盘失败
```

core 的诊断回答「Fiber 服务为什么没生效」，这里的扩展回答「清单里登记了什么、哪个加载失败、落盘有没有问题」——两者并列，不互相替代。

## 六、开发

```bash
npm run build -w @loop-agent/main      # tsup，产出 dist/index.js + index.d.ts
npm test -w @loop-agent/main           # vitest，直接读 src/，无需先 build
npm run typecheck -w @loop-agent/main  # tsc --noEmit
```

`tests/boundary.test.ts` 会静态断言：源码说明符只允许 `./`、`../`、`node:`、`@loop-agent/core`；零 `src/` 反向依赖；`dependencies` 仅 core；`external` 已配；无 core 依赖副本。

## 七、已知非目标

- 多进程并发写锁
- 插件市场 / 远程安装 / semver 约束
- 插件 `options` 的 JSON Schema 校验
- 热重载（`fs.watch`）
- 按工作空间覆盖清单
- CLI / HTTP 入口（本包只交付可编程入口）
