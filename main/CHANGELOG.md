# Changelog

本文件记录 `@loop-agent/main` 的公开契约变更。`0.x` 期间的 breaking 变更只升**次版本**，补丁版本仅修 bug。

## 0.1.0 — 2026-11-14

首个版本：主工程宿主层与持久化插件注册中心。

配套 `@loop-agent/core@0.2.0`（同轮删除内核的 `PluginRegistry`，职责迁入本包）。

### 公开符号基线

#### 函数（3 个）

| 符号 | 说明 |
|---|---|
| `createMainHost` | 创建主工程宿主：core host + 根 Context + 基础服务 + 启停骨架 |
| `createPluginStore` | 创建清单存储（原子写 + 坏档容错） |
| `emptyManifest` | 空清单工厂（首次启动 / 坏档降级共用） |
| `loopAgentHome` | 用户目录（读 `LOOP_AGENT_HOME`） |
| `pluginsDir` | 插件目录 `~/.loop-agent/plugins` |
| `defaultLoadPlugin` | 缺省插件加载器（动态 `import()`，只收 ESM） |

#### 类（1 个）

| 符号 | 说明 |
|---|---|
| `PersistentPluginRegistry` | 持久化插件注册中心：`restore` / `mount` / `unmount` / `enable` / `disable` / `reorder` / `fiberOf` / `entries` / `diagnose` / `dispose` |

#### 常量（2 个）

| 符号 | 说明 |
|---|---|
| `MAIN_SERVICE_KEYS` | 内置基础服务的 key（`main:logger` / `main:home`） |
| `MANIFEST_SCHEMA_VERSION` | 清单结构版本，当前 `1` |

#### 类型（7 个）

| 符号 | 说明 |
|---|---|
| `MainHost` | `{ host, context, registry, logger, home, start, stop }` |
| `MainHostOptions` | `createMainHost` 的入参 |
| `Logger` | 最小日志接口 |
| `HomeService` | 用户目录解析结果 |
| `PluginManifest` | 清单落盘结构 |
| `PluginManifestEntry` | 清单条目 |
| `RegistryDiagnostic` | 注册中心诊断（包住 core `DiagnosticReport`） |
| `PluginStore` | 清单存储接口 |
| `PluginStoreOptions` | 存储入参 |
| `PersistentPluginRegistryOptions` | 注册中心入参 |

### 关键契约

- **清单位置**：`~/.loop-agent/plugins/registry.json`，`LOOP_AGENT_HOME` 可整体重定向。
- **五个写操作均立即原子落盘**：`mount` / `enable` / `disable` / `unmount` / `reorder`。
- **原子写**：tmp → 删目标 → rename；读方永不读到半截 JSON。Windows 上目标存在时先删再 rename。
- **坏档降级**：损坏/不识别 → 备份 `registry.json.bad.<ts>` → 空清单，**不阻断启动**。
- **落盘失败只记录**：内存清单照常更新，进 `diagnose().persistError`，操作不抛错。
- **`enabled` 是一等状态**：`disable` 卸 Fiber 但保留清单条目。
- **顺序即数组下标**，不存冗余 `order` 字段。
- **顺序只存清单**：Fiber 引用、服务实例、运行期状态每次启动重新推导。
- **插件只收 ESM**，`specifier` 走 `import()`。
- **单副本**：`@loop-agent/core` 必须 `external`，仓库内为 workspace 链接。
- **零反向依赖**：不 import 主工程 `src/`（`tests/boundary.test.ts` 静态锁死）。

### 测试基线

- `tests/store.test.ts`：读写往返、覆盖写、无 tmp 残留、坏 JSON、`schemaVersion` 不识别、`entries` 非数组、字段非法跳过、`id` 重复、`enabled` 缺省、并发读原子性、写失败。
- `tests/registry.test.ts`：五个写操作均落盘、启停保留条目、排序两情形、加载失败隔离（`mount` 与 `restore` 两条路径）、`apply` 抛错置 `FAILED`、落盘失败隔离、并发 `mount`、跨实例还原、`restore` 幂等、`dispose` 逆序幂等、链式依赖收敛。
- `tests/boundary.test.ts`：说明符白名单、零 `src/` 反向依赖、`dependencies` 仅 core、`external` 已配、单副本、无 core 深层 import。

共 3 文件 52 例全绿。
