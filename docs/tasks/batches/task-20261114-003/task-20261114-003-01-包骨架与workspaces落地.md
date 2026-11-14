# 任务 01：包骨架与 workspaces 落地

- 所属需求编号：**20261114-003**
- 所属批次：[00-总任务计划](./00-总任务计划.md)
- 设计方案：[设计方案-20261114-003+core插件机制内核.md](../../../designs/2026-11-14/设计方案-20261114-003+core插件机制内核.md)
- 状态：**已完成**（2026-11-14，验收项全部实测通过；「`core/node_modules` 不存在」一项口径经任务 04 订正为「无依赖副本」）

---

## 一、任务目标需求

### 1.1 背景（痛点）

本需求要新建独立子包 `core/` 承载插件机制内核，但当前仓库**没有任何子包/workspace 基础设施**：

- 根 `package.json`（43 行）无 `workspaces` 字段，无 `private`
- 仓库已有的 `desktop/`、`webui/` 都是**各自独立**的依赖布局（各自有 `node_modules` + `package-lock.json`），未纳入 workspace
- `core/` 目录不存在，`node_modules/@loop-agent` 不存在

若不先落地 workspaces 而让 `core/` 自管依赖，主工程引用 core 时会出现**两份物理副本**，进而导致 `instanceof` 判断跨副本为 `false`、`ctx.get()` 查不到对方注册的服务，且症状会被 `diagnose()` 掩盖成「一切正常」（详见设计方案 4.2）。

本任务只解决「包能建起来、契约写对、依赖布局正确」，**不写内核逻辑**。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
|---|---|---|
| workspace 声明 | 根 `package.json` 无 `workspaces` 字段（`package.json:1-43`） | 需新增 `["core"]` |
| 依赖提升 | 无 workspace，`node_modules/@loop-agent` 不存在 | 需 `npm install` 生成链接 |
| 子包构建 | 主工程 `build` 用 `tsup src/index.ts --format esm --dts`（`package.json:8`） | core 需自有 `tsup.config.ts`，只产 ESM |
| 子包类型检查 | 根 `tsconfig.json:18` 的 `include` 仅 `src/**`+`examples/**` | core 需自有 `tsconfig.json`，不受根配置管辖 |
| 子包测试 | 根 `vitest.config.ts:18` 的 `include` 仅 `tests/**/*.test.ts` | core 需自有 `vitest.config.ts`，不被主工程收集 |
| 构建产物忽略 | `.gitignore:2` 的 `/dist/` 只匹配根目录 | 需补 `/core/dist/` |
| 最小导出面 | 无 | 需 `CoreError` 基类 + `index.ts`，供本任务验证构建与解析 |

### 1.3 任务目标

- 根 `package.json` 新增 `"workspaces": ["core"]`（**不加 `private`**，实测无需）
- 建 `core/` 四件套：`package.json`、`tsconfig.json`、`tsup.config.ts`、`vitest.config.ts`
- `core/package.json` 的包契约定案：单分支 `exports`（`types`+`import`+`default`）、`files`、`sideEffects:false`、`engines`、`main`
- 实现 `core/src/errors.ts` 的 `CoreError` 基类与 `core/src/index.ts` 最小导出面
- 产物验证：仅 3 个文件（`index.js`/`index.js.map`/`index.d.ts`）
- **最小冒烟**：验证 ESM `import` 可加载、类型可解析（比设计方案原定的 P2 提前，早暴露契约错误）

### 1.4 设计约束

- **零运行时依赖**：`core/package.json` 的 `dependencies` 为空对象
- **零反向依赖**：`core/src/**` 只允许 import `node:` 内置模块或 `core/src` 内部相对路径
- **主工程业务代码一行不改**：`src/`、`tests/` 不动
- 主工程配置改动仅 3 处：根 `package.json`（`workspaces`）、`package-lock.json`（自动）、`.gitignore`（`/core/dist/`）
- `desktop/`、`webui/` **不纳入** workspaces，其 `node_modules` 与 lock 不得被改写
- 只出 ESM，**禁止顶层 `await`**
- `core/tests` 不得被主工程 vitest 收集

---

## 二、方案设计

### 2.1 总体思路

```
改造前                              改造后
loop-agent-command/                loop-agent-command/
  package.json                       package.json        ← +workspaces:["core"]
  package-lock.json                  package-lock.json   ← 自动 +2 条
  .gitignore                         .gitignore          ← +/core/dist/
  src/  (不动)                        src/  (不动)
  tests/ (不动)                       tests/ (不动)
  desktop/{node_modules,lock}        desktop/{node_modules,lock}  ← 不受影响
  webui/{node_modules,lock}          webui/{node_modules,lock}    ← 不受影响
                                     core/                        ★ 新增
                                       package.json    (D2/D13/D16/D17)
                                       tsconfig.json
                                       tsup.config.ts  (D14)
                                       vitest.config.ts
                                       src/errors.ts   (CoreError 基类)
                                       src/index.ts    (最小导出面)
                                 node_modules/@loop-agent/core → core/  (D3/D15)

构建链（在 core/ 内执行，D14）
  src/index.ts ──tsup(format:esm, dts, sourcemap)──► dist/index.js
                                                     dist/index.js.map
                                                     dist/index.d.ts
```

关键点：**`npm install` 在根执行一次**，npm 按 `workspaces` 把 `core` 以链接形式提升到根 `node_modules`，`core/node_modules` 不生成 → 任何消费方解析 core 都落到同一物理路径 → 天然单实例。

### 2.2 关键设计决策

- **D1（对应设计方案 D1/D2）**：目录 `core/`、包名 `@loop-agent/core`。
  - 理由：目录名贴合「模块名称就是 core」；包名用 scope 避开 `loop-agent-core.exe`（SEA 后端二进制，`desktop/src/backend-path.ts:5`、`scripts/build-desktop.mjs:159`）
  - 被否决：`loop-agent-core`（与 exe 同名，排查与日志两义）
  - 被否决：`src/core`（用户明确要求独立模块，且内核要能被多宿主复用）

- **D2（对应设计方案 D3/D15）**：用 npm workspaces，不用 `file:` / `npm link`。
  - 理由：workspaces 以链接提升，物理单份；`file:` 会产生第二份副本；`link` 引入第二套解析路径
  - 被否决：各管各 `node_modules` + `file:`（双副本 → `instanceof` 跨副本 false）
  - 被否决：运行期 `CORE_INSTANCE_ID` 自检（只能发现不修复，且症状被 `diagnose()` 掩盖）

- **D3（对应设计方案 D13/D14）**：`exports` 单分支 `{ types, import, default }`，`import` 与 `default` 同指 `./dist/index.js`。
  - 理由：只出单 ESM 产物；`default` 必须写，否则 CJS 侧 `require` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`
  - `types` 写在前面属**零成本惯例**，非硬性要求（实测矩阵 C1–C5/F1–F3/G1–G2 已证伪「必须最前否则 TS7016」，见设计方案 4.1②）
  - 被否决：`import`+`require` 双分支（需 `.cjs` 产物 → 双实例风险）
  - 被否决：不写 `exports`（老工具兜底但失去条件导出能力）

- **D4**：**不加 `private` 字段**（根与 core 均不加）。
  - 理由：隔离探针实测，根 `package.json` 无 `private` 时 workspaces 同样生效
  - 被否决：加 `private: true`（多余约束；且 core 将来若要发布也不必改）

- **D5（对应设计方案 D16）**：`version: 0.1.0`，与主工程 `0.2.0` 解耦；`0.x` 期间 breaking 只升次版本。
  - 被否决：直接 `1.0.0`（承诺了尚未验证的 API 稳定性）

- **D6（对应设计方案 D17）**：`sideEffects: false`，加载期零副作用。
  - 理由：可被摇树；避免「import 即生效」破坏显式注册语义
  - 被否决：允许加载期建全局单例（与多 Context 隔离冲突）

- **D7**：`devDependencies` 版本范围**沿用根 `package.json`**（`typescript ^5.6.3`、`tsup ^8.3.5`、`vitest ^4.1.10`）。
  - 理由：与根同范围，npm 会复用根已安装的那份，避免额外下载一套工具链
  - 本机实际已装：`typescript 5.9.3`、`tsup 8.5.1`、`vitest 4.1.12`（均满足上述范围）

- **D8**：`core/tests/**` 用文件名后缀 `.test.ts`，但**根 vitest 不收集**它。
  - 理由：根 `vitest.config.ts:18` 的 `include` 仅 `tests/**/*.test.ts`（相对根目录），`core/tests` 不在其内
  - 验收项显式核对：主工程全量回归仍是 213 个文件

- **D9**：本任务就实现 `CoreError` 基类与 `src/index.ts` 最小导出面。
  - 理由：没有真实导出物就无法验证「构建出 3 个文件」「类型可解析」「重复 import 同实例」——空文件产物会让这些验收项形同虚设
  - 边界：只实现**基类**（`code`/`pluginName`/`fiberId`/`cause`），6 个子类留给任务 02
  - 被否决：本任务写 `export {}` 占位（无法验证 dts 与实例相等性）

### 2.3 联网检索结论

本任务为仓库内子包基建，无外部同类实现可借鉴。三处已由实测/源码确认的技术事实：

1. **workspaces 无 `private` 亦生效**：npm 文档建议 monorepo 根加 `private: true` 以免误发布，但这是**发布保护**而非 workspaces 的生效前提；隔离探针实测确认无 `private` 时链接正常生成。
2. **`tsup` 的 `outDir`/`entry` 以 cwd 为基准**（非配置文件所在目录）：在根执行 `npx tsup --config core/tsup.config.ts` 会把产物写到根下的 `outDir`。故 build 脚本必须 `cd core` 执行，或用 `npm run build -w @loop-agent/core`。
3. **dts 产物后缀由 cwd 所在 `package.json` 的 `type` 决定**：`type: module` → 仅 `.d.ts`（无 `.d.cts`）。因只出 ESM，不存在后缀歧义，也无需 wrapper。

---

## 三、任务详细设计

### 3.1 `core/package.json`

```jsonc
{
  "name": "@loop-agent/core",
  "version": "0.1.0",
  "description": "插件机制内核：Context 服务容器、类型化事件、Fiber 生命周期",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "sideEffects": false,
  "engines": { "node": ">=20.10" },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^4.1.10"
  }
}
```

**注意**：`types` 顶层字段与 `exports` 内 `types` 并存，前者供不认识 `exports` 的老工具兜底。

### 3.2 `core/tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,                    // 构建交给 tsup
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "types": ["node"]
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

与根 `tsconfig.json` 对齐（`target:ES2022`、`module:ESNext`、`moduleResolution:Bundler`、`strict:true`），差异仅在 `noEmit:true` 与 `include` 范围。

### 3.3 `core/tsup.config.ts`

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],        // 只出 ESM（D3/D14）
  dts: true,              // 产 index.d.ts
  sourcemap: true,        // 产 index.js.map
  clean: true,            // 构建前清 dist，避免残留旧产物
  target: 'es2022',
  platform: 'node',
});
```

### 3.4 `core/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
```

**不声明 `projects`、不复用主工程配置**：core 是独立库，测试不得依赖主工程的 `tests/setup/*`。

### 3.5 `core/src/errors.ts`（本任务只实现基类）

```ts
/** 内核错误基类：全部内核错误的共同父类，便于跨模块 instanceof 判别 */
export class CoreError extends Error {
  /** 稳定错误码，供日志/HTTP 状态映射使用（跨进程边界也可靠） */
  readonly code: string;
  /** 出错插件名（若已知） */
  readonly pluginName?: string;
  /** 出错 Fiber id（若已知） */
  readonly fiberId?: string;

  constructor(
    message: string,
    opts: { code?: string; pluginName?: string; fiberId?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'CoreError';
    this.code = opts.code ?? 'CORE_ERROR';
    this.pluginName = opts.pluginName;
    this.fiberId = opts.fiberId;
  }
}
```

**5 个子类**（`CircularDependencyError` / `ServiceNotFoundError` / `ServiceConflictError` / `PluginLoadError` / `FiberDisposedError`）留到任务 02。

### 3.6 `core/src/index.ts`（本任务最小导出面）

```ts
export { CoreError } from './errors.js';
```

**注意 `.js` 后缀**：`type: module` + ESM 下 TS 源码内相对导入须写 `.js`（编译后才指向真实文件）。任务 02 会扩展此文件。

### 3.7 主工程三处改动

| 文件 | 改动 |
|---|---|
| `package.json` | 在 `"type": "module"` 后新增 `"workspaces": ["core"],` |
| `package-lock.json` | 由 `npm install` 自动更新（预期仅 `core` 与 `node_modules/@loop-agent/core` 两条） |
| `.gitignore` | 在 `/dist/` 后追加 `/core/dist/`；并加注释说明（`node_modules/` 不带前缀已覆盖 `core/node_modules`，无需另加） |

**边界与错误**：

| 情形 | 行为 |
|---|---|
| `npm install` 后 `core/node_modules` 被生成 | 说明提升失败，需检查 `workspaces` 拼写；验收项显式断言该目录**不存在** |
| lockfile 变动超出预期（超过 2 条新增） | 立即 `git checkout package-lock.json` 回滚排查，不带着异常变更继续 |
| 从根执行 `tsup --config core/tsup.config.ts` | 产物会落到根 `dist/`；build 一律用 `npm run build -w @loop-agent/core` |
| `webui/package-lock.json` 被改写 | 说明误把 webui 纳入 workspace；验收项核对哈希 |

### 3.8 演进项（本任务不做）

- 内核主链路（服务、事件、Fiber、Context）→ 任务 02
- `isolate` / `diagnose` / 动态重载 / `waterfall` / `registry` → 任务 03
- `boundary.test.ts` 完整边界断言、`README`、`CHANGELOG`、CJS 条件性冒烟 → 任务 04
- 主工程 `tsc`/全量 vitest/`build:sea` 回归 → 任务 05

---

## 四、实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P0** | `core/` 四件套 + `errors.ts` 基类 + `index.ts` + 根 `workspaces` + `.gitignore` + `npm install` | `core/` 目录可构建，`node_modules/@loop-agent/core` 链接就绪 |
| **P1** | `npm run build -w @loop-agent/core` 产物核验（3 文件）、`typecheck`、`test`（本任务暂无测试，跑通空套件）、最小 ESM 冒烟 | 产物 3 文件无 `.cjs`/`.d.cts`；`import` 可加载；两次 import 同实例 |

## 五、文件清单

| 文件 | 改动 | 阶段 |
|---|---|---|
| `package.json` | 新增 `"workspaces": ["core"]` | P0 |
| `package-lock.json` | 自动更新（预期 +2 条） | P0 |
| `.gitignore` | 追加 `/core/dist/` 与注释 | P0 |
| `core/package.json` | **新增** 包契约（`exports`/`files`/`sideEffects`/`engines`/`scripts`） | P0 |
| `core/tsconfig.json` | **新增** strict、`noEmit` | P0 |
| `core/tsup.config.ts` | **新增** `format:['esm']` + `dts` + `sourcemap` + `clean` | P0 |
| `core/vitest.config.ts` | **新增** 独立测试配置 | P0 |
| `core/src/errors.ts` | **新增** `CoreError` 基类 | P0 |
| `core/src/index.ts` | **新增** 最小导出面 | P0 |

`src/`、`tests/`、`tsconfig.json`、`vitest.config.ts`、`desktop/`、`webui/` **一律不动**。

## 六、任务验收清单

> 全部保持未勾选，实施后逐项验证再打勾。

### 6.1 P0

- [x] 根 `package.json` 新增 `"workspaces": ["core"]`，且**未**新增 `private` 字段
- [x] `core/` 四件套齐备：`package.json`、`tsconfig.json`、`tsup.config.ts`、`vitest.config.ts`
- [x] `core/package.json` 的 `dependencies` 为空对象 `{}`
- [x] `core/package.json` 的 `exports` 为单分支 `{ types, import, default }`，`import` 与 `default` 同指 `./dist/index.js`
- [x] `exports` 中**不出现 `require` 条件**
- [x] 含 `files: ["dist"]`、`sideEffects: false`、`engines.node: ">=20.10"`、`main`、`types`
- [x] `version` 为 `0.1.0`，`type` 为 `module`
- [x] `npm install` 后 `node_modules/@loop-agent/core` 为指向 `core/` 的链接
- [x] `core/node_modules` **不存在**（提升生效）
- [x] `.gitignore` 含 `/core/dist/`

### 6.2 P1

- [x] `npm run build -w @loop-agent/core` 成功
- [x] `core/dist/` 下恰好 3 个文件：`index.js`、`index.js.map`、`index.d.ts`
- [x] `dist` 下**无** `.cjs`、`.d.cts`、wrapper 脚本
- [x] 产物落在 `core/dist/`，**不是**根 `dist/`
- [x] `npm run typecheck -w @loop-agent/core` 零错误
- [x] `npm test -w @loop-agent/core` 可运行（本任务无测试用例，空套件不报错或提示无测试）
- [x] **单实例冒烟**：同进程内两次 `await import('@loop-agent/core')`，断言 `A.CoreError === B.CoreError`
- [x] **ESM 类型解析冒烟**：临时工程以 `file:` 引用 core，`tsc --noEmit` 能解析 `CoreError` 类型
- [x] `core/src/**` 无任何第三方 import（仅 `node:` 与 `./` 相对路径）

### 6.3 主工程零影响（本任务局部核对，全量留任务 05）

- [x] `npx tsc --noEmit`（主工程）零错误
- [x] 根 `vitest.config.ts` 的 `include` 未改动，仍为 `tests/**/*.test.ts`
- [x] 根 `tsconfig.json` 的 `include` 未改动，仍为 `src/**`+`examples/**`
- [x] `git status` 确认 `src/`、`tests/` 无改动
- [x] `desktop/node_modules`、`webui/node_modules` 仍存在
- [x] `webui/package-lock.json` 未被改写（哈希与改动前一致）
- [x] `package-lock.json` 变动仅预期条目

### 6.4 人工验证（真实环境）

- [x] Windows 下确认提升链接为 JUNCTION（`dir node_modules\@loop-agent` 显示 `<JUNCTION>`）
- [x] 干净克隆后 `npm install` → `npm run build -w @loop-agent/core` 可复现

---

## 七、完成记录

实施日期：2026-11-14

### 7.1 实际改动

| 文件 | 实际改动 |
|---|---|
| `package.json` | 新增 `"workspaces": ["core"]`（`type` 字段之后），未加 `private` |
| `package-lock.json` | +19 行、0 删除 = `workspaces` 字段 3 行 + `core` 条目 12 行 + `node_modules/@loop-agent/core`(link) 4 行 |
| `.gitignore` | `/dist/` 之后追加注释与 `/core/dist/` |
| `core/package.json` | 新增，包契约按 3.1 定案 |
| `core/tsconfig.json` | 新增，与根对齐 + `noEmit:true` |
| `core/tsup.config.ts` | 新增，单 ESM + dts + sourcemap + clean |
| `core/vitest.config.ts` | 新增，独立配置（见 7.3 两处调整） |
| `core/src/errors.ts` | 新增，`CoreError` 基类 + `CoreErrorOptions` |
| `core/src/index.ts` | 新增，最小导出面 |

### 7.2 实测结果

```
node_modules/@loop-agent/core  isSymbolicLink: true
realpath                    : D:\trae_workspace\loop-agent-command\core
core/node_modules 存在       : false
core/dist 文件              : index.d.ts, index.js, index.js.map（恰好 3 个）
含 .cjs / .d.cts            : false
产物体积                     : index.js 497B / index.js.map 1.48KB / index.d.ts 940B
core typecheck              : 零错误
主工程 npx tsc --noEmit     : 零错误（MAIN_TSC_PASSED）
单实例冒烟                   : a.CoreError === b.CoreError  →  true
resolve 结果                : file:///D:/trae_workspace/loop-agent-command/core/dist/index.js
CoreError 行为              : name/code/pluginName/fiberId/cause 全对，instanceof Error 与 instanceof CoreError 均 true
webui/package-lock.json     : sha256 ad37ce77… 与改动前逐字节一致
desktop/package-lock.json   : sha256 ff9dbafe… 与改动前逐字节一致
webui/node_modules          : 仍存在
desktop/node_modules        : 仍存在
```

### 7.3 两处实施期调整（已体现为最终代码）

1. **`core/vitest.config.ts` 加 `passWithNoTests: true`**
   起因：任务 01 阶段内核无测试用例，`vitest run` 因「No test files found」退出码 1，会让 `npm test` 失败。
   影响：仅放宽空套件；任务 02 起有真实用例后判定不受影响。

2. **`core/vitest.config.ts` 加 `cacheDir: 'dist/.vitest'`**
   起因：vitest 默认把缓存写到 `node_modules/.vite`，会在 `core/` 下**凭空造出 `core/node_modules` 目录**（实际内容仅 `.vite` 缓存，无任何依赖副本）。这会直接破坏「`core/node_modules` 不存在 ⇒ workspaces 提升生效」这条验收判据——目录存在时分不清是依赖副本还是纯缓存。
   处理：把缓存改到 `dist/.vitest`（`dist` 整体不入库），改后 `core/node_modules` 保持不存在。
   附带代价：`core/dist` 多出 `.vitest/` 缓存子目录，故验收项改为断言「`dist` 下恰好 3 个**产物文件**」，而非「`dist` 下恰好 3 个条目」。

### 7.4 `default` 条件反向验证（本任务已完成）

用 `temp/smoke01/verify-default.cjs` 临时移除 `exports["."].default` 后实测：

```
已临时移除 default，exports = {".":{"types":"...index.d.ts","import":"...index.js"}}
[无 default] require 失败 code=ERR_PACKAGE_PATH_NOT_EXPORTED
→ 结论 PASS：确认 default 条件是 CJS 侧可解析的前提
```

恢复后需在**独立进程**复验（同一进程的 require 缓存会保留失败结果）：

```
[已恢复 独立进程] CJS require 成功, 导出键: CoreError
                  CoreError instanceof: true
```

### 7.5 遗留说明

- `core/src/index.ts` 当前仅导出 `CoreError` 与 `CoreErrorOptions`，属任务 01 的**有意最小面**；完整导出面在任务 02。
- `core/tests/` 目录当前不存在（临时探针已删除），任务 02 起建立。
- 已验证主工程 vitest **不会**收集 `core/tests/**`（`npx vitest run --project unit probe` 返回 No test files found）。
- 主工程测试文件基数实测：`tests/**` unit 205 个 + integration 8 个 = **213**，与设计方案记载一致。
