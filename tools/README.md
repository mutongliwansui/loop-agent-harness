# @loop-agent/tools

工具插件**契约层**：定义「一个工具」在插件体系里该长什么样、怎么被继承、参数与失败怎么归一。

本包**不含任何具体工具实现**（12 个内置工具、MCP 适配、输出治理、权限门禁都属实现层）。它的职责只有一个：让「内置工具」与「用户自定义工具」都能通过 `extends ToolBase` / `extends ToolProvider` 落地，并被 `@loop-agent/main` 当作普通插件挂载。

---

## 分层判据

四包职责必须严格区分，否则会退化成「又一个业务包」：

| 问题 | 归属 |
|---|---|
| 插件长什么样、怎么挂、怎么撤 | `@loop-agent/core` |
| 挂哪些插件、什么顺序、启停、存哪、重启怎么还原 | `@loop-agent/main` |
| 一个大模型服务商该提供什么、怎么被继承、能力怎么声明 | `@loop-agent/llm` |
| **一个工具该提供什么、怎么被继承、参数与失败怎么归一** | **`@loop-agent/tools`（本包）** |
| 具体工具实现、MCP 适配、输出治理、权限门禁 | 实现层（非本包） |

一句话：**core 管机制，main 管装配，llm 管模型契约，tools 管工具契约，实现管具体。**

本包的依赖约束：`dependencies` **只有** `@loop-agent/core`，零三方运行时依赖。

### 为什么不依赖 `@loop-agent/llm`

`tools` 与 `llm` 是**平级**的两个领域契约包：工具不该在概念上从属于大模型（非 LLM 场景同样需要工具，如 ACP 编辑器的 tool 映射）。若 `tools → llm`，就会形成 `tools → llm → core` 的三层链，把本可正交的两条轴捆成一条。

但 `ToolDefView` 与 llm 的 `LlmToolDef` **字段一字等价**（`name` / `description` / `parameters`），宿主侧适配是「一行 map」、不需要字段翻译。

---

## 快速开始

### 1. 继承 `ToolBase`，只实现 `execute()`

```ts
import { ToolBase, type ToolInvokeContext } from '@loop-agent/tools';

export class FileReadTool extends ToolBase {
  constructor() {
    super({
      name: 'fileRead',
      description: '读取文件内容',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    });
  }

  // 返回 string 或 ToolResult 均可
  protected override async execute(args: Record<string, unknown>, _ctx: ToolInvokeContext) {
    return await readFile(String(args.path), 'utf8');
  }
}
```

`execute()` 是 `protected` 是刻意的：宿主不该绕过校验直接调裸执行体。需要逃生口时由实现方自行在子类上公开一个方法，责任归实现方。

### 2. 需要成组产出时，继承 `ToolProvider`

```ts
import { ToolProvider, ToolBase } from '@loop-agent/tools';

export class VisionProvider extends ToolProvider {
  readonly id = 'vision';
  override readonly displayName = '视觉工具';

  async create(options: Record<string, unknown>): Promise<ToolBase[]> {
    if (options.enabled !== true) return [];   // 按开关成组注册
    return [new AnalyzeImageTool(), new OcrTool(), new ScreenshotTool()];
  }

  // 连接池 / 子进程 / 定时器在这里释放（protected，由框架触发）
  protected override async onDispose(): Promise<void> { /* ... */ }
}
```

### 3. 编译成插件并挂载

两种导出形态，**按是否需要清单侧覆盖配置来选择**：

```ts
// 形态 A：直接给插件对象（无部署侧覆盖）
import { defineTools } from '@loop-agent/tools';
export default defineTools({ id: 'my-tools', tools: [new FileReadTool()] });

// 形态 B：给工厂，让 main 清单的 options 注入进来
import { defineToolsFactory } from '@loop-agent/tools';
export default defineToolsFactory({
  id: 'my-tools',
  options: { maxBytes: 512 * 1024 },      // 代码侧默认值
  tools: (opts) => [new FileReadTool(opts)],
});
```

清单里写 `options` 会与代码侧 `options` **浅合并**，清单侧同名键优先：

```json
{
  "plugins": [
    { "specifier": "@acme/my-tools", "options": { "maxBytes": 1048576 }, "enabled": true }
  ]
}
```

> **为什么必须两个形态**：`@loop-agent/main` 把清单 `options` 传给**模块默认导出的工厂函数**，`ctx` 上没有 options 通道。只给形态 A，清单里的 `options` 会被静默丢弃（最难排查的一类「配置不生效」）；只给形态 B，无覆盖需求时也要多包一层函数。

### 4. 在宿主侧安装

```ts
import { createHost, createRootContext } from '@loop-agent/core';
import { installTools, getToolRegistry, defineTools } from '@loop-agent/tools';

const host = createHost();
const ctx = createRootContext(host);

// 目录服务必须先装：工具提供者对它声明了硬依赖
await ctx.plugin(installTools()).ready();

const fiber = ctx.plugin(defineTools({ id: 'my-tools', tools: [new FileReadTool()] }));
await fiber.ready();

// 取模型侧定义 + 调用
const registry = getToolRegistry(ctx);
registry.toToolDefs();                          // [{ name, description, parameters }]
await registry.invoke('fileRead', { path: 'a.txt' });
```

实际使用 `@loop-agent/main` 时不需要手写这段：清单里登记插件即可，注册中心会负责 `import()` 与挂载顺序。

---

## 契约要点

### 抽象面只有两个必实现项

| 成员 | 类型 | 说明 |
|---|---|---|
| 构造参数 | `ToolSpec` | 含 `name` / `description` / `parameters`（均必填） |
| `execute()` | `protected abstract` | 唯一必实现方法；返回 `string` 或 `ToolResult` |

其余全部有默认实现：

| 成员 | 缺省行为 |
|---|---|
| `annotations` | 按 MCP 悲观默认补全（见下节） |
| `timeoutMs` | `DEFAULT_TOOL_TIMEOUT_MS` = 30_000 |
| `display` | `undefined`（本期 WebUI 不消费） |
| `toSpec()` | 浅拷贝投影，改动不回写 |
| `invoke()` | 模板方法，**子类不应覆写** |

### `invoke()` 固化了的四步

`invoke()` 是宿主唯一调用入口，依次做：取消检查 → 参数形状检查 → JSON Schema 校验 → `execute()` → 结果归一。

**任何环节失败都返回 `isError: true` 的 `ToolResult`，不向上抛**——与 `src/tools/runner.ts` 的既有语义一致（异常不转为抛出，而是失败文本，让 ReAct 自行换思路），避免打断循环。

唯一例外：`ctx.signal` 已 abort 时直接返回取消结果，**不调用** `execute()`；若 `execute()` 内部抛出带 `aborted: true` 的错误，则**原样冒泡**，保留取消语义而非当作工具失败。

### 工具名约束：`^[A-Za-z0-9_-]{1,64}$`，不以 `__` 开头

- **为什么是 64 而不是 MCP 规范的 128**：三大厂商的实际限制取最低公共上限（OpenAI 硬 64），取最大值会写出「本地能注册、上云每轮 400」的工具名，而 MCP 侧 `tools/list` 一切正常，根因排查成本极高。
- **为什么禁 `.`**：MCP 规范允许，但 OpenAI / Anthropic 会直接拒。
- **为什么禁 `__` 前缀**：主工程 MCP 适配用 `server__tool` 区分来源，该前缀永久保留给适配器，避免用户工具名与生成名撞车。

名字不合法在**注册期同步抛** `ToolsInvalidNameError`（code `TOOLS_INVALID_NAME`），不是运行期；错误文案含「哪个提供者、哪个名字、为什么不合法」。

### `parameters` 必须显式 `type: 'object'`

缺 `type` 的 schema 不会被当作 object——OpenAI 严格模式与 Bedrock 会直接拒。让错误发生在挂载期并指向具体工具名，比留到每轮请求 400 好排查。

### `annotations` 不是权限（重要）

`ToolAnnotations` 对齐 MCP 的四个人 hint，默认值取**悲观口径**：

| 字段 | 默认 | 含义 |
|---|---|---|
| `readOnlyHint` | `false` | 不修改环境（纯读） |
| `destructiveHint` | `true` | 修改是破坏性（删除/覆盖）而非追加 |
| `idempotentHint` | `false` | 同参数重复调用无额外影响 |
| `openWorldHint` | `true` | 触及开放世界（网络/外部系统） |

即「什么都不声明 = 可能写、可能破坏、可能不幂等、可能触网」。

**MCP 规范明示这些字段是 hint，不保证忠实描述行为，客户端不得据此做安全决策。** 本包只声明、不强制；`boundary.test.ts` 里有一条 `destructiveHint` 的工具照样能被调用——权限门禁由宿主实现，不在本层。

### `toToolDefs()` 做的两件事都不是「好看」

```
按 name.localeCompare 升序  +  parameters 递归键序规范化（canonicalize）
```

理由：工具定义处于每轮请求的**前缀**位置，注册顺序抖动或键序抖动会让 provider 侧前缀缓存整体失效——成本与延迟双升，且不报错、极难察觉。这两条是不变量，已被单测锁死（打乱注册顺序两次调用结果逐字节相同）。

### 服务 key 布局

```ts
TOOLS_SERVICE_KEYS = {
  registry: 'tools:registry',            // 目录服务，由 installTools() 提供
  providerPrefix: 'tools:provider:',     // 每个提供者独占 tools:provider:<id>
}
```

**每个提供者必须独占一个 key**：core 的 `provide()` 遇重复 key 抛 `ServiceConflictError` 且不覆盖。若所有提供者挤在一个 key 下存 Map，会丢掉 core 的归属追踪（`diagnose()` 无法按提供者报 owner，卸载也失去自动撤销）。

`tools:registry` 由 `defineTools()` **无条件注入为硬依赖**——忘写会「提供者抢跑到 apply 才发现目录不存在」，而这依赖是契约自带的前置条件，不该成为用户的记忆负担。用户的 `inject` 只承担**额外**依赖。

### 事件

```ts
registry.on('tools/registered',   (p) => { /* p.name, p.providerId */ });
registry.on('tools/unregistered', (p) => { /* p.name, p.providerId */ });
registry.on('tools/invoke',       (p) => { /* p.name, p.args */ });
registry.on('tools/result',       (p) => { /* p.name, p.result, p.elapsedMs */ });
registry.on('tools/error',        (p) => { /* p.name, p.error */ });
```

事件是**只读观测**：监听器抛错会被吞掉，不会中断调用链；一个监听器故障也不影响其他监听器收到事件。`tools/invoke` 在校验**之前**发，便于观测到「模型给了什么」，包括最终因参数非法而失败的情况。

### 错误族

全部继承 `@loop-agent/core` 的 `CoreError`（`instanceof CoreError` 兜底捕获不会漏），`code` 前缀 `TOOLS_`：

| 类 | code | 触发时机 |
|---|---|---|
| `ToolsError` | `TOOLS_ERROR` | 基类 |
| `ToolsConfigError` | `TOOLS_CONFIG_INVALID` | 定义/配置非法（含 `field` 定位） |
| `ToolsInvalidNameError` | `TOOLS_INVALID_NAME` | 工具名不合法（注册期同步） |
| `ToolsDuplicateError` | `TOOLS_DUPLICATE` | 目录内重名（含双方 providerId） |
| `ToolsProviderExistsError` | `TOOLS_PROVIDER_EXISTS` | 同 id 提供者重复挂载 |
| `ToolsRegistryExistsError` | `TOOLS_REGISTRY_EXISTS` | 重复 `installTools()` |
| `ToolsRegistryMissingError` | `TOOLS_REGISTRY_MISSING` | 未装目录就取 |
| `ToolsNotFoundError` | `TOOLS_NOT_FOUND` | 按名取不存在的工具 |
| `ToolsArgsInvalidError` | `TOOLS_ARGS_INVALID` | 参数校验失败（仅内部构造，不外抛） |
| `ToolsExecError` | `TOOLS_EXEC_FAILED` | `execute()` 异常归一后的包装 |

### 批量注册：先全量校验，全部通过才落登记

避免「47 个工具挂到第 30 个炸了，前 29 个留在目录里」这种只能重启才能清理的中间态。返回的 `Disposer` 一次性撤销整批（逆序）。

---

## 本包不做的事（反例清单）

这些都是**有意不做**，且由 `boundary.test.ts` 钉住：

| 不做 | 归属 |
|---|---|
| 命名空间前缀（`server__tool`） | MCP 适配器（取决于命名空间如何划分，属装配决策） |
| 参数自动补全 / 注入默认值 | 模型必须给全，契约层不猜 |
| 输出治理（截断 / 摘要） | 实现层 |
| 权限门禁（按 annotations 拦截） | 宿主实现 |
| 超时执行（真正中断慢工具） | 实现层 / 宿主 |
| 上下文拼装（sessionId 等） | agent 层 |
| 工具选择 / 推荐排序 | 模型 |
| 持久化（存盘 / 重启还原） | `@loop-agent/main` |

---

## 实施注意事项

### `ToolsEvents` 必须 `extends EventMapBase`

```ts
// 正确
export interface ToolsEvents extends EventMapBase { … }

// 错误：消费方写 Plugin<ToolsEvents> 会报 TS2344
export interface ToolsEvents { … }
```

`EventMapBase` 带字符串索引签名，`interface` 不会隐式获得它。

### 属性回落不要写成 getter

`ToolProvider.displayName` 是**可选属性**而非 getter：子类用 `readonly displayName = 'x'` 覆盖 getter 会遇到「访问器与属性冲突」。回落逻辑（→ `id`）放在 `define.ts` 里做。

### `invoke()` 无法真正禁止覆写

TS 没有 `final`，靠文档与注释约束。覆写会绕过参数校验与结果归一，属已知风险但保留逃生能力。

---

## 本期不含（演进项）

- 12 个内置工具从 `src/tools/` 的实施迁移
- MCP server 适配层（桥接 `tools/list` → `ToolBase[]`）
- `ToolDisplay` 接入 WebUI（字段位已留，后端下发后前端只留兜底表）
- 权限门禁与 `annotations` 的联动
- 工具执行超时的宿主侧落实
- `structured` 输出的消费方（UI / 统计 / 门禁）
