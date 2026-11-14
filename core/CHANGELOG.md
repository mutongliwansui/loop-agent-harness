# Changelog

本文件记录 `@loop-agent/core` 的公开契约变更。`0.x` 期间的 breaking 变更只升**次版本**（`0.1.0` → `0.2.0`），补丁版本仅修 bug。

## 0.2.0 — 2026-11-14

**BREAKING**：删除 `PluginRegistry`。

### 变更

| 项 | 变化 |
|---|---|
| `PluginRegistry` 类 | **删除**（含 `index.ts` 导出、类型定义、测试用例、README 段落） |
| 其余导出面 | 一字不改：8 类 + 2 函数 + 16 类型 |

### 为什么删

`PluginRegistry` 虽只是薄封装（组合 `createHost()` + `createRootContext()`，未侵入 `context.ts`/`fiber.ts`/`service.ts`），但它回答的是「挂载哪些插件、按什么顺序、下次还记不记得」——**宿主层职责，不是内核定义**。0.1.0 设计 5.10 也明确写了它「纯内存、无磁盘 IO」，与后续要的持久化能力直接冲突，留在内核只能靠破坏纯净性实现。

### 迁移指引

| 原用法 | 现用法 |
|---|---|
| `new PluginRegistry()` | `createMainHost()`（`@loop-agent/main`） |
| `registry.mount([p1, p2])` | `ctx.plugin(p1)` / `ctx.plugin(p2)`，或用 main 的 `registry.mount(entry)` 登记落盘 |
| `registry.dispose()` | `ctx` 逐层 `dispose()`，或 `mainHost.stop()` |

零迁移成本：删除前 `src/`、`webui/`、`desktop/` 对 `@loop-agent/core` 均无引用，仅 core 自身文档与 3 个测试文件涉及。

## 0.1.0 — 2026-11-14

首个版本：插件机制内核的完整定义。本期**不被本项目任何代码引用**，仅作为独立库存在。

### 公开符号基线

以下为 `0.1.0` 的完整导出面（`core/src/index.ts`）。后续任何删除或签名变更都属 breaking。

#### 类（9 个）

| 符号 | 说明 |
|---|---|
| `CoreError` | 错误基类，带稳定 `code` |
| `CircularDependencyError` | 依赖成环（`CORE_CIRCULAR_DEP`） |
| `ServiceNotFoundError` | 服务未提供（`CORE_SERVICE_MISSING`） |
| `ServiceConflictError` | 服务 key 冲突（`CORE_SERVICE_CONFLICT`） |
| `PluginLoadError` | 插件加载失败（`CORE_PLUGIN_LOAD`） |
| `FiberDisposedError` | 已卸载仍注册（`CORE_FIBER_DISPOSED`） |
| `ServiceRegistry` | 服务注册表 |
| `TypedEventBus` | 类型化事件总线（四模式） |
| `PluginRegistry` | 插件清单挂载与整体卸载（**0.2.0 已删除**，见上） |

#### 函数（2 个）

| 符号 | 说明 |
|---|---|
| `createRootContext` | 创建根 Context |
| `createHost` | 创建内核宿主（服务表 + 事件总线 + Fiber 树） |

#### 类型（16 个）

| 符号 | 说明 |
|---|---|
| `Disposer` | `() => void \| Promise<void>` |
| `Inject` | `string[] \| { required?, optional? }` |
| `Plugin` | 函数或对象两形态 |
| `PluginFunction` | 函数形态 |
| `PluginObject` | 对象形态 |
| `PluginOptions` | `ctx.plugin()` 的附加选项 |
| `FiberState` | 六态字面量联合 |
| `Fiber` | Fiber 接口 |
| `Context` | Context 接口 |
| `CoreHost` | 宿主接口 |
| `IsolationScope` | 隔离域结构 |
| `EventMapBase` | 事件表基类型（带字符串索引签名） |
| `DiagnosticReport` | 诊断报告 |
| `ServiceEntry` | 服务登记项 |
| `ListenerErrorRecord` | 监听器异常记录 |
| `CoreErrorOptions` | 错误构造选项 |

### 关键契约

- **单 ESM 产物**：只有 `dist/index.js` + `dist/index.d.ts` + sourcemap，无 `.cjs` / `.d.cts` / wrapper。
- **零运行时依赖**：`dependencies` / `peerDependencies` / `optionalDependencies` 全为空。
- **零反向依赖**：`core/src` 不引用主工程任何文件，模块说明符只允许 `./`、`../`、`node:`。
- **无顶层 `await`**：保证 CJS 侧 `require()` 不会撞 `ERR_REQUIRE_ASYNC_MODULE`。
- **`exports` 三条件**（`types` / `import` / `default`）指向同一份实现；仅暴露 `.` 一个入口，deep import 被挡。
- **Fiber 四条不变量**：`dispose()` 幂等、disposer 逆序串行、单条抛错不中断、父先卸载子。

### 已知约束（非缺陷，均为有意设计）

- 事件表用 `interface` 定义时**必须** `extends EventMapBase`，否则报 `TS2344`（`interface` 不隐式获得索引签名；`type` 别名不受影响）。
- 事件名**不受字面量约束**：因 `EventMapBase` 的字符串索引签名，`keyof E & string` 退化为 `string`。收益是「已声明名字有精确签名」，而非「未声明名字被拒绝」。
- `require()` 需 Node ≥ 20.19 / 22.12（`require(esm)` 默认启用）；更低版本报 `ERR_REQUIRE_ESM`。
- `ctx.effect()` 的 body 是同步的，内部不能 `await`。
- 打包宿主时必须将 `@loop-agent/core` 配为 external，否则会出现双副本，`instanceof` 静默失效。
