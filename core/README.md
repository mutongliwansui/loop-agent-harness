# @loop-agent/core

零依赖、零反向依赖的**插件机制内核**。只提供与业务无关的四件事：插件定义、Context 服务容器、类型化事件、可逆副作用生命周期。**本包不接入任何业务代码**，也不依赖主工程。

## 一、如何在其他模块引用本包

根 `package.json` 已声明 `workspaces: ["core"]`，仓库内可直接引用，无需安装：

```ts
import { createRootContext, createHost, CoreError } from '@loop-agent/core';
```

- 单副本保证：`node_modules/@loop-agent/core` 是指向 `core/` 的链接，整个仓库只有一份物理副本，因此 `instanceof` 与类引用比较都可靠。
- `engines.node >= 20.10`。
- 若在其他仓库使用，需自行 `npm install` 并保证 Node 版本满足上条。

### 1.2 分层判据（本包只做定义，不做装配）

| 层 | 只回答 |
|---|---|
| `@loop-agent/core`（本包） | 插件**怎么被定义**、怎么被挂载、怎么被撤销 |
| `@loop-agent/main` | **挂载哪些**插件、**什么顺序**、**启停状态**、**清单存哪**、**重启怎么还原** |

本包**不含**插件清单、不含磁盘 IO、不含持久化。需要这些能力时用 `@loop-agent/main`：

```ts
import { createMainHost } from '@loop-agent/main';

const app = createMainHost();
await app.start();   // 读清单并挂载 enabled 插件
await app.stop();    // 逆序卸载全部
```

内核侧对应的最小能力是 `createHost()` + `createRootContext()` + `ctx.plugin()`——「装什么、记不记得」属于宿主层，不属于内核。

## 三、CJS 消费方须知

本包**只出 ESM**（`dist/index.js` + `dist/index.d.ts`，无 `.cjs` / `.d.cts`）。

`require('@loop-agent/core')` 在以下 Node 版本可直接工作（`require(esm)` 已默认启用）：

| 版本线 | 门槛 |
|---|---|
| 20.x | ≥ 20.19.0 |
| 22.x | ≥ 22.12.0 |
| 23.x 及以上 | 默认支持 |

低于门槛时报 `ERR_REQUIRE_ESM`；此时需升级 Node，或改用动态 `import()`。

> 本机实测（Node v24.17.0）：`require('@loop-agent/core')` **成功**，`CoreError` 的 `code` 与 `instanceof Error` 均正确。该结论由 `tests/external-consumer.test.ts` 的 CJS 支线持续验证。

## 三、核心概念

### 3.1 插件（两种形态）

```ts
import type { EventMapBase, Plugin } from '@loop-agent/core';

// 事件表必须 extends EventMapBase —— 见 §六「易踩的坑」
interface AppEvents extends EventMapBase {
  'user/login': (id: string) => void;
}

// 函数形态
const fnPlugin: Plugin<AppEvents> = (ctx) => {
  ctx.provide('answer', 42);
};

// 对象形态（可声明注入依赖 + 显示名）
const objPlugin: Plugin<AppEvents> = {
  name: 'greeter',
  inject: { required: ['answer'], optional: ['logger'] },
  apply(ctx) {
    const n = ctx.get<number>('answer');
    void n;
  },
};
```

`inject` 支持两种写法：`['a','b']`（全部硬依赖）或 `{ required, optional }`（区分硬软）。

**硬依赖未满足时**，Fiber 停在 `PENDING` 且 `apply` 绝不会被调用；**软依赖**只影响 `ctx.get()` 能否取到值，不阻塞加载。

### 3.2 Context（服务容器）

```ts
const ctx = createRootContext<AppEvents>();
ctx.provide('answer', 42);              // 返回 Disposer
const n = ctx.get<number>('answer');    // number | undefined
```

`ctx.get<T>(key)` 未提供时返回 `undefined`（软依赖口径），不抛错。

### 3.3 Fiber（六态生命周期）

```
PENDING ──required 依赖满足──> LOADING ──apply 成功──> ACTIVE
   ↑                              │
   │                              └─apply 抛错→ FAILED（终态，需显式 reload）
   │
任意非 DISPOSED ──dispose()──> UNLOADING ──> DISPOSED
```

四条不变量（均有单测覆盖）：

1. `dispose()` **幂等**：重复调用返回同一 Promise，disposer 不重复执行。
2. disposer **逆序**执行，异步 disposer **串行** await。
3. 单个 disposer 抛错**不中断**后续撤销，错误聚合记录（`diagnose()` 的 `disposeErrors` 可读）。
4. 父 Fiber 卸载时**先递归卸载子 Fiber**，再撤销自身 disposer。

`provide` / `effect` / `on` / 子 `plugin` 注册的一切都自动挂到属主 Fiber，随其卸载撤销。

### 3.4 事件（四模式）

```ts
import { TypedEventBus } from '@loop-agent/core';

const bus = new TypedEventBus<AppEvents>();

bus.emit('user/login', 'u1');              // 纯通知：同步、注册序、异常只记录
await bus.serial('user/login', 'u1');      // 单决策：首个非 undefined 胜出
await bus.parallel('user/login', 'u1');    // 扇出：全部并行（allSettled）
await bus.waterfall('user/login', fb, 'u1'); // 拦截改写：监听器可调 next() 委托
```

| 方法 | await | 顺序 | 返回 | 监听器异常 |
|---|---|---|---|---|
| `emit` | 否 | 注册序 | 无 | 记录，不外抛 |
| `serial` | 是 | 注册序，首个非 `undefined` 即停 | 有 | **外抛** |
| `parallel` | 是 | 全部并行 | 无 | 记录，不外抛 |
| `waterfall` | 是 | 注册序，可 `next()` 委托 | 有 | **外抛** |

`waterfall` 的监听器比普通监听器多一个**尾部参数 `next`**：调用表示「我不处理，交给下一个」，不调用即短路。全链都委托才走 `fallback`。

监听器异常**不 `console.error`**（库不污染宿主输出），收集在 `bus.listenerErrors()`。

### 3.5 effect（可逆副作用）

```ts
ctx.effect(() => {
  const timer = setInterval(() => {}, 1000);
  return () => clearInterval(timer);   // 必须返回 disposer
}, 'ticker');
```

body **立即执行**（副作用在返回前已生效），其返回的 disposer 挂到当前 Fiber。注意 body 是**同步**的，内部不能 `await`。

### 3.6 isolate（服务隔离域）

```ts
const iso = ctx.isolate(['db']);
iso.provide('db', fakeDb);        // 域内独立实例
ctx.get('db');                    // 外层不受影响
```

语义是**遮蔽**（shadow），不是覆盖：域内声明了某 key 却没提供时，`iso.get(key)` 返回 `undefined`，**不回退**外层。事件总线**不隔离**（跨域通知必须全局）。

### 3.7 diagnose（诊断）

```ts
const report = ctx.diagnose();
report.fibers;   // [{ id, name, state, missing, error?, disposeErrors? }]
report.services; // [{ key, ownerFiberId, isolated }]
```

### 3.8 错误族（6 类）

| 类 | `code` | 触发场景 |
|---|---|---|
| `CoreError` | `CORE_ERROR` | 基类 |
| `CircularDependencyError` | `CORE_CIRCULAR_DEP` | 依赖成环 |
| `ServiceNotFoundError` | `CORE_SERVICE_MISSING` | 强制取服务但无人提供 |
| `ServiceConflictError` | `CORE_SERVICE_CONFLICT` | 同一 key 被两个 ACTIVE Fiber 提供 |
| `PluginLoadError` | `CORE_PLUGIN_LOAD` | 插件 `apply` 抛错 |
| `FiberDisposedError` | `CORE_FIBER_DISPOSED` | 在已 DISPOSED 的 ctx 上注册 |

`code` 是 `string`（不是字面量联合），便于日志与 HTTP 状态映射，跨进程边界也可靠。

## 四、插件必须 external（打包铁律）

打包主工程或任何宿主时，**必须把 `@loop-agent/core` 排除在 bundle 之外**：

```js
// tsup / rollup / vite 通用
external: ['@loop-agent/core']
```

否则插件与宿主会各持一份副本：`instanceof` 全为 false、服务表互不可见、`isolate` 失效——且这类 bug **静默无报错**，极难定位。`tests/boundary.test.ts` 的「单副本」断言守的是仓库内的场景，打包边界仍需人工遵守。

## 五、包契约说明

`package.json` 的 `exports` 只有三条件，且都指向同一实现：

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  }
}
```

- **`default` 不可省**：它是 CJS `require` 与不识别 `import` 条件的工具的兜底；去掉后 `require` 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- **`types` 的书写顺序不构成风险**：这是本包的实测结论。因为 `index.d.ts` 与 `index.js` **同址同名**，TS 即便没有 `types` 条件也能按同目录同名规则推断出声明（已由 `tests/external-consumer.test.ts` 实测确认）。「`types` 必须在最前，否则报 TS7016」是**不成立**的旧说法——那条规则只在「声明与实现异地」时才可观测，而本包布局下不可达。
- **deep import 被挡**：`@loop-agent/core/dist/index.js` 这类子路径不在 `exports` 里，消费方会拿到 `ERR_PACKAGE_PATH_NOT_EXPORTED`。这是有意为之——只暴露一个入口，内部文件可自由重构。

## 六、易踩的坑

**事件表用 `interface` 时必须 `extends EventMapBase`。**

```ts
// ❌ 报 TS2344：Index signature for type 'string' is missing
interface Ev { 'demo/ping': (n: number) => string }
const p: Plugin<Ev> = { apply() {} };

// ✅ 写法一：extends
interface Ev extends EventMapBase { 'demo/ping': (n: number) => string }

// ✅ 写法二：type 别名（隐式获得索引签名兼容性）
type Ev = { 'demo/ping': (n: number) => string };
```

根因：`EventMapBase` 声明了 `[event: string]: (...args: any[]) => any`，而 TS 的 `interface` **不会**隐式获得索引签名，`type` 别名则可以做隐式索引签名推断。此约束由 `tests/external-consumer.test.ts` 持续回归。

**事件名不受字面量约束。** 同样因为上述字符串索引签名，`keyof E & string` 退化为 `string`，`ctx.on('任意名字', …)` 都不会报错。真实收益是「已声明的事件名拿到精确的监听器签名」，而**不是**「未声明的名字被拒绝」。若需严格事件名，请自行加一层 `keyof E` 收窄的包装函数。

## 七、开发命令

```bash
npm run build -w @loop-agent/core      # tsup 打包，产物固定 3 个文件
npm test -w @loop-agent/core           # vitest 全量（含 boundary / external-consumer）
npm run typecheck -w @loop-agent/core  # tsc --noEmit，含 tests/types.test-d.ts 类型断言
```

| 测试文件 | 职责 | 耗时 |
|---|---|---|
| `tests/*.test.ts` | 内核行为单测 | 毫秒级 |
| `tests/boundary.test.ts` | 静态边界：零三方依赖、零反向依赖、单副本、单 ESM 产物、无顶层 await、`exports` 契约 | 毫秒级 |
| `tests/types.test-d.ts` | 公开契约的类型层断言（由 `typecheck` 覆盖，vitest 不收集） | 随 tsc |
| `tests/external-consumer.test.ts` | 真起子进程：临时目录建消费工程，跑 `tsc` + `node` | 秒级 |

产物固定为三个文件，`tests/boundary.test.ts` 会断言这一点：

```
core/dist/index.js
core/dist/index.js.map
core/dist/index.d.ts
```
