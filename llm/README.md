# @loop-agent/llm

大模型插件**契约层**：定义「一个大模型服务商」在插件体系里该长什么样、怎么被继承、能力怎么声明。

本包**不含任何具体服务商实现**（OpenAI 兼容实现属后续独立包）。它的职责只有一个：让「默认实现」与「用户自定义实现」都能通过 `extends LlmProvider` 落地，并被 `@loop-agent/main` 的持久化注册中心当作普通插件挂载。

---

## 分层判据

三包职责必须严格区分，否则会退化成「又一个业务包」：

| 问题 | 归属 |
|---|---|
| 插件长什么样、怎么挂、怎么撤 | `@loop-agent/core` |
| 挂哪些插件、什么顺序、启停、存哪、重启怎么还原 | `@loop-agent/main` |
| **一个大模型服务商该提供什么、怎么被继承、能力边界怎么声明** | **`@loop-agent/llm`（本包）** |
| 具体的 OpenAI 兼容实现、重试/限流/路由策略 | 将来的默认实现包 / 中间件层 |

一句话：**core 管机制，main 管装配，llm 管契约，实现管具体。**

本包的依赖约束：`dependencies` **只有** `@loop-agent/core`，零三方运行时依赖。

---

## 快速开始

### 1. 继承 `LlmProvider`

最小实现只需两个成员：`id` 与 `complete()`。

```ts
import { LlmProvider, type LlmRequest, type LlmResponse } from '@loop-agent/llm';

export class EchoProvider extends LlmProvider {
  readonly id = 'echo';

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const last = req.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : '';
    return {
      content: text,
      finishReason: 'stop',
      model: req.model,
      // 不回报用量就不填 usage —— 缺失要记「未知」，不能填 0
    };
  }
}
```

### 2. 声明能力

`capabilities()` 缺省**全 `false`**，这是保守默认：逼实现者显式声明支持什么，而不是默认「什么都能」然后在运行期炸。

```ts
import type { LlmCapabilities } from '@loop-agent/llm';

override capabilities(): LlmCapabilities {
  return {
    streaming: true,
    toolCalling: true,
    vision: false,
    jsonMode: true,
    maxContextTokens: 128_000,   // 未知就不要填，不要伪造
    usageReporting: true,
    cacheReporting: false,
  };
}
```

**请求超出能力会被显式拒绝**（抛 `LlmCapabilityError`，且**不会发出任何网络请求**）。这是刻意的：静默忽略 `tools` 会让模型收不到工具却照常返回文本，用户只会以为是模型能力不行。

### 3. 编译成插件并挂载

两种导出形态，**按是否需要清单侧覆盖配置来选择**：

```ts
// 形态 A：直接给插件对象（无部署侧覆盖）
import { defineLlmProvider } from '@loop-agent/llm';
export default defineLlmProvider({ id: 'echo', create: () => new EchoProvider() });

// 形态 B：给工厂，让 main 清单的 options 注入进来
import { defineLlmProviderFactory } from '@loop-agent/llm';
export default defineLlmProviderFactory({
  id: 'echo',
  options: { model: 'code-default', timeout: 30_000 },  // 代码侧默认值
  create: (opts) => new EchoProvider(opts),
});
```

清单里写 `options` 会与代码侧 `options` **浅合并**，清单侧同名键优先：

```json
{
  "plugins": [
    { "specifier": "@acme/llm-echo", "options": { "model": "gpt-x" }, "enabled": true }
  ]
}
```

> **为什么必须两个形态**：`@loop-agent/main` 的 `defaultLoadPlugin` 把清单 `options` 传给**模块默认导出的工厂函数**，`ctx` 上没有 options 通道。只给形态 A，清单里的 `options` 会被静默丢弃（最难排查的一类「配置不生效」）；只给形态 B，无覆盖需求时也要多包一层函数。

### 4. 在宿主侧安装

```ts
import { createHost, createRootContext } from '@loop-agent/core';
import { installLlm, getLlmRegistry } from '@loop-agent/llm';

const host = createHost();
const ctx = createRootContext(host);

// 目录服务必须先装：provider 插件对它声明了硬依赖
await ctx.plugin(installLlm()).ready();

// 挂 provider（此处以形态 A 为例）
const fiber = ctx.plugin(defineLlmProvider({ id: 'echo', create: () => new EchoProvider() }));
await fiber.ready();

// 调用
const registry = getLlmRegistry(ctx);
const res = await registry.complete('echo', {
  model: 'any',
  messages: [{ role: 'user', content: 'hi' }],
});
```

实际使用 `@loop-agent/main` 时不需要手写这段：清单里登记插件即可，注册中心会负责 `import()` 与挂载顺序。

---

## 契约要点

### 抽象面只有两个必实现项

| 成员 | 类型 | 说明 |
|---|---|---|
| `id` | `abstract readonly string` | 唯一标识；**非空且不含 `:`**（冒号是服务 key 分段符） |
| `complete()` | `abstract` | 唯一必实现方法 |

其余全部有默认实现：

| 成员 | 缺省行为 |
|---|---|
| `displayName` | 回落 `id` |
| `capabilities()` | 全 `false` |
| `stream()` | 由 `complete()` **降级**：发 `text-delta` → `usage`（若有）→ `done` |
| `onDispose()` | 空实现（`protected`，由 registry 经 `dispose()` 触发） |

### `stream()` 的默认降级与注意事项

默认降级**不发** `tool-call-start` / `tool-call-delta`：工具调用在 `complete()` 里已是完整结果，伪造增量没有意义；`done.response.toolCalls` 足以表达。

覆写 `stream()` 时**必须保证最后一个事件是 `done`**。`LlmRegistry.stream()` 会做防御性补齐（用已累积的文本分片尽力构造收尾响应），但那只是兜底，不应依赖。

### 服务 key 布局

```ts
LLM_SERVICE_KEYS = {
  registry: 'llm:registry',          // 目录服务，由 installLlm() 提供
  providerPrefix: 'llm:provider:',   // 每个 provider 独占 llm:provider:<id>
}
```

**每个 provider 必须独占一个 key**：`@loop-agent/core` 的 `provide()` 遇重复 key 抛 `ServiceConflictError` 且不覆盖。这不是绕过限制，而是必须如此——若所有 provider 挤在一个 key 下存 Map，会丢掉 core 的归属追踪（`diagnose()` 无法按 provider 报 owner，卸载也失去自动撤销）。

### 事件

```ts
registry.on('llm/request', (p) => { /* p.providerId, p.request */ });
registry.on('llm/response', (p) => { /* p.providerId, p.response, p.elapsedMs */ });
registry.on('llm/error', (p) => { /* p.providerId, p.error */ });
registry.on('llm/registered', (p) => { /* p.providerId, p.displayName */ });
registry.on('llm/unregistered', (p) => { /* p.providerId */ });
```

事件是**只读观测**：监听器抛错会被吞掉，不会中断调用链；一个监听器故障也不影响其他监听器收到事件。

### 错误族

全部继承 `@loop-agent/core` 的 `CoreError`（`instanceof CoreError` 兜底捕获不会漏），`code` 前缀 `LLM_`：

| 类 | code | 是否值得重试 |
|---|---|---|
| `LlmError` | `LLM_ERROR` | 视 cause |
| `LlmConfigError` | `LLM_CONFIG_INVALID` | 否 |
| `LlmProviderNotFoundError` | `LLM_PROVIDER_NOT_FOUND` | 否 |
| `LlmProviderConflictError` | `LLM_PROVIDER_CONFLICT` | 否 |
| `LlmCapabilityError` | `LLM_CAPABILITY_UNSUPPORTED` | 否（应换 provider） |
| `LlmAuthError` | `LLM_AUTH_FAILED` | 否 |
| `LlmRateLimitError` | `LLM_RATE_LIMIT` | 是（交上层退避） |
| `LlmRequestError` | `LLM_REQUEST_FAILED` | 视 status |
| `LlmAbortedError` | `LLM_ABORTED` | 否 |

---

## 实施注意事项

### `LlmEvents` 必须 `extends EventMapBase`

```ts
// 正确
export interface LlmEvents extends EventMapBase { … }

// 错误：消费方写 Plugin<LlmEvents> 会报 TS2344
export interface LlmEvents { … }
```

`EventMapBase` 带字符串索引签名，`interface` 不会隐式获得它。

**副作用须知**：该索引签名会让 `keyof E & string` 退化为 `string`，即**未声明的事件名不会被 TS 拒绝**。收益只是「已声明的名字有精确签名」，并非穷举保护。

### 类型命名是 camelCase

领域类型用 `promptTokens` / `toolCalls` / `finishReason` / `toolCallId`，与上游协议的 `prompt_tokens` 等差异由**各 provider 自己映射**。

理由：领域层若照搬上游 snake_case，抽象就被上游协议污染了，而这正是本包要解决的问题本身。

### `LlmResponse.raw` 是受控逃生口

服务商专有字段可以塞进 `raw`，但这是**有意保留的泄漏**：消费方必须容忍它是 `undefined` 或形状随 provider 变化，**核心逻辑不得依赖**。需要稳定字段时应当提进契约。

### 用量缺失记「未知」而非 0

`LlmUsage` 的 `cacheHitTokens` / `cacheMissTokens` 在 provider 不回报时为 `undefined`。整个 `usage` 缺失时也不要构造全 0 对象——否则成本统计会被系统性低估。

---

## 本期不含（演进项）

- OpenAI 兼容的默认实现（将作为独立包，继承本包契约）
- 横切中间件层：重试退避、限流、预算、超时传播、故障转移路由
- 模型别名与路由策略
- 凭据管理（轮换 / keyring）
- `completeVision?` 独立方法（视觉目前走「内容分片 + 能力位」）
- 结构化输出的严格 Schema 校验
- `src/llm/` 的迁移与旧单例删除

`LlmCallOptions.hooks` 是本期留下的最小观测扩展位，**只读**，不得改变请求/响应语义。
