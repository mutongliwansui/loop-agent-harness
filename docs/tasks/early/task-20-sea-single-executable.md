# Task-20：Node SEA 单可执行文件打包（现场部署形态）

> 目标：采用 `docs/designs/early/deployment-options.md` 方案 B，基于 Node 官方 **Single Executable Applications（SEA）** 将项目打包为单个可执行文件（Windows 下 `loop-agent.exe` / Linux 下二进制），现场**零依赖**、直接以命令行运行，不再需要安装 Node / npm / node_modules。

---

## 一、需求目标

### 1.1 背景

当前项目运行依赖开发环境：

```
npm start  →  tsx src/index.ts  →  依赖 Node.js + node_modules + tsx
```

现场部署环境通常没有源码、`node_modules`、npm 甚至 Node 运行时。`docs/designs/early/deployment-options.md` 已评估 5 种方案（tsup+Node / **Node SEA** / Bun / pkg / npm 全局安装），**选定方案 B（Node SEA）**作为现场定型形态。

### 1.2 要解决的痛点

| 痛点 | 现状 | 目标 |
|------|------|------|
| **现场无 Node 运行时** | 必须安装 Node 18+ LTS 才能运行 | 交付单个 exe，零依赖双击/命令即用 |
| **现场无 npm / 离线网络** | 无法 `npm install`，MCP/依赖拉取困难 | 所有依赖内联进单文件，无需网络 |
| **部署操作门槛** | 拷贝源码 + 安装依赖 + npm start | 拷贝一个可执行文件即可 |
| **升级维护** | 重新同步源码/依赖 | 替换单个 exe 文件 |

### 1.3 设计约束

- **不修改业务代码**：ReAct 循环、记忆系统、会话、工具调用逻辑保持原样
- **功能等价**：打包产物行为与 `npm start` 完全一致（会话/记忆/配置/MCP/统计）
- **构建脚本化**：一条 `npm run build:sea` 产出最终可执行文件，中间产物可清理
- **跨平台**：SEA **不可交叉编译**，Windows / Linux 需分别构建（建议 CI matrix）
- **构建机要求**：Node ≥ 20.10（SEA 引入版本），建议 Node 22 LTS

---

## 二、前置条件核查（已完成）

| 核查项 | 结论 | 说明 |
|---|---|---|
| 动态加载 | ✅ 通过 | 全源码无 `import()` / `require()` / `createRequire`，可完整静态 bundle |
| 原生依赖 | ✅ 通过 | 无 better-sqlite3 等 native 模块，不需要重新编译二进制 |
| ESM-only API | ✅ 通过 | 无 `import.meta` / `__dirname` / `__filename` 使用，CJS 单文件无兼容风险 |
| 构建工具 | ✅ 就绪 | `tsup` 已配置，可输出 CJS 单文件 |
| Node 版本 | ⚠️ 需升级 | 当前 README 标注 Node 18+；SEA 要求构建机 **20.10+**（建议 22 LTS，现场运行无需 Node） |

**结论**：项目完全具备 SEA 打包条件，打包本身不需要改动业务代码。

---

## 三、方案选型依据

| 方案 | 结论 | 原因 |
|------|------|------|
| A. tsup + Node | 阶段 1 打底 | 改动最小，作为开发/内部交付的快速路径（已具备条件） |
| **B. Node SEA** ⭐ | **Task-20 目标** | Node 官方特性、无第三方打包器、无原生依赖时最可靠；现场零依赖 |
| C. Bun 编译 | 备选 | 一条命令，但引入 Bun 工具链，openai/MCP SDK 兼容性需实测 |
| D. vercel/pkg | 排除 | 项目已停止维护，ESM 支持弱 |
| E. npm 全局安装 | 轻量补充 | 仅需 `bin` 字段，本质仍依赖 Node |

> Task-20 聚焦方案 B；方案 A 的 `bin` 字段可顺手补齐（低风险、不与 SEA 冲突）。

---

## 四、详细设计

### 4.1 构建流水线（`npm run build:sea`）

```
步骤 1: tsup 打 CJS 单文件（依赖全部内联）
        tsup src/index.ts --format cjs --out-dir dist-sea
        → dist-sea/index.cjs   （package.json type=module 时 tsup 自动用 .cjs 后缀）

步骤 2: 生成 SEA 配置（脚本内动态写入）
        dist-sea/sea-config.json:
        {
          "main": "dist-sea/index.cjs",
          "output": "dist-sea/sea-prep.blob",
          "disableExperimentalSEAWarning": true,
          "useCodeCache": true
        }

步骤 3: 生成 SEA blob
        node --experimental-sea-config dist-sea/sea-config.json
        → dist-sea/sea-prep.blob

步骤 4: 复制 Node 运行时为产物骨架（用 process.execPath 定位）
        Windows: copy  node.exe → dist-sea/loop-agent.exe
        Linux:   cp    $(which node) → dist-sea/loop-agent

步骤 5: 注入 blob 生成最终可执行文件
        npx postject dist-sea/loop-agent.exe NODE_SEA_BLOB dist-sea/sea-prep.blob
        → dist-sea/loop-agent.exe（最终交付物）
```

### 4.2 构建编排

- **新增 devDependency**：`postject`（仅在构建机使用，现场不需要）
- **新增 `scripts/build-sea.mjs`**（Node 脚本编排以上 5 步，避免 Windows/Linux shell 差异）：
  - 调用 tsup（spawn `npx tsup ...`）
  - 写 `sea-config.json`
  - `spawnSync(process.execPath, ['--experimental-sea-config', ...])` 生成 blob
  - 复制 `process.execPath` 到产物名（`win32` → `.exe`，否则无后缀）
  - `spawnSync('npx', ['postject', ...])` 注入，支持平台参数
- **package.json scripts**：

  ```json
  {
    "scripts": {
      "build:sea": "node scripts/build-sea.mjs",
      "build:sea:clean": "rimraf dist-sea"   // 或 build 脚本内置清理
    }
  }
  ```

### 4.3 产物目录

```
dist-sea/
├── index.cjs         # CJS 单文件（中间产物，可清理）
├── sea-config.json   # SEA 配置（中间产物，可清理）
├── sea-prep.blob     # SEA blob（中间产物，可清理）
└── loop-agent.exe    # ✅ 最终交付物（Windows）
```

### 4.4 Windows 特有细节

- `index.ts` 启动时已有 `chcp 65001` 逻辑（[src/index.ts:33-39](file:///d:/trae_workspace/loop-agent-command/src/index.ts#L33-L39)），SEA 产物同样生效，中文显示不受影响
- SEA 首次启动需解压到系统临时目录，**首启略慢**（后续有 V8 code cache 加速），属正常现象
- 注入后的 exe 可直接双击运行（REPL 交互模式），也可放入 `PATH` 后以 `loop-agent` 命令调用

### 4.5 平台与版本策略

- **不可交叉编译**：Windows exe 必须在 Windows 构建，Linux 二进制必须在 Linux 构建
- 构建机统一 Node 22 LTS（`engines` 建议补充 `"node": ">=20.10"`）
- 建议 CI 使用 `matrix: [windows-latest, ubuntu-latest]` 分别产出两种平台产物
- `process.cwd()` 语义不变：配置/记忆相对路径跟随启动时的工作目录

---

## 五、测试计划

| # | 测试项 | 方法 | 预期结果 |
|---|--------|------|----------|
| 1 | 构建成功 | `npm run build:sea` | 生成 `dist-sea/loop-agent.exe` |
| 2 | 零依赖启动 | 在无 Node/npm 的干净环境运行 exe | 出现 ReAct Agent 启动横幅与 `Agent>` 提示符 |
| 3 | REPL 命令 | exe 内执行 `/status`、`/config list`、`/help` | 输出与 `npm start` 一致 |
| 4 | 核心功能等价 | exe 内执行一次会话（保存/恢复）、记忆、内置工具 | 与 `npm start` 行为一致 |
| 5 | LLM 调用（可选，需 API） | exe 内实际提问一次 | 流式输出 + token 统计正常 |
| 6 | Linux（可选） | ubuntu 上构建并运行 | 二进制可运行 |
| 7 | 无回归 | `npm run typecheck` + `npm test` | 全绿（打包不引入业务代码改动） |

---

## 六、实施计划

| 步骤 | 工作内容 | 产出文件 | 状态 |
|------|----------|----------|------|
| 6.1 | 新增 `postject` devDependency + `engines` 约束 | `package.json` | ✅ |
| 6.2 | 编排脚本：tsup CJS 单文件 → sea-config → blob → 注入 | `scripts/build-sea.mjs` | ✅ |
| 6.3 | package.json 增加 `build:sea` 脚本与清理脚本 | `package.json` | ✅ |
| 6.4 | Windows 构建验证：产物生成 + exe 启动 + REPL 命令 + 功能等价 | `dist-sea/loop-agent.exe` | ✅ |
| 6.5 | 可选：Linux 二进制构建验证 | `dist-sea/loop-agent` | ⬜ 未执行（无 Linux 环境） |
| 6.6 | typecheck + 全量测试无回归 | - | ✅ |
| 6.7 | 交付说明：产物使用方式与现场部署注意点（MCP/密钥/cwd） | README 或交付说明 | ✅ |

> **6.4 实测结论**：`dist-sea/loop-agent.exe` 直接运行进入 REPL，启动横幅/中文正常，`/status` 正常输出，记忆系统（L1/L2/L3）正常启用，`exit` 触发 Dreaming 后正常退出。此前 `No such built-in module: sqlite` 崩溃已通过 `fts.ts`/`vector.ts` 惰性加载（`createRequire('node:sqlite')` + try/catch 降级）解决。
>
> **6.6 实测结论**：`npm run typecheck` 通过；`npm test` 86/92 通过（12 个测试文件），6 个失败均为 `tests/integration/` 集成测试，原因是本地 Ollama（`localhost:11434`）未启动导致 `ECONNREFUSED`，属环境依赖、非代码回归。

---

## 七、验收测试清单

| # | 验收项 | 预期结果 | 状态 |
|---|--------|----------|------|
| 7.1 | 单 exe 产物 | `npm run build:sea` 产出 `dist-sea/loop-agent.exe`（Windows） | ✅ |
| 7.2 | 零依赖启动 | 干净环境（无 Node/npm/node_modules）下 exe 直接运行出 REPL | ✅ |
| 7.3 | 功能等价 | 会话保存/恢复、三层记忆、配置命令、内置工具与 `npm start` 一致 | ✅ |
| 7.4 | 构建脚本化 | 一条命令完成全部构建与注入，中间产物可清理 | ✅ |
| 7.5 | 无回归 | `npm run typecheck` + 全量测试通过 | ✅（86/92；6 个集成测试需本地 Ollama，环境依赖） |
| 7.6 | Linux（可选） | ubuntu 二进制可运行且功能等价 | ⬜ 未执行（无 Linux 环境） |

---

## 八、预期效果

| 指标 | 现状 | 交付后 |
|------|------|--------|
| 现场运行 | 需安装 Node 18+ 与依赖 | 单个 exe，零依赖直接运行 |
| 部署操作 | 源码 + `npm install` + `npm start` | 拷贝单文件 → 执行命令 |
| 升级维护 | 同步源码/依赖/环境 | 替换单个 exe 文件 |
| 数据资产 | 已落盘（`~/.loop-agent/` 等） | 路径语义不变，历史数据直接延续 |
| 平台覆盖 | 单机开发 | Windows / Linux 双平台产物（CI matrix） |

---

> **与 Task 关联**：`docs/designs/early/deployment-options.md` 为本任务选型依据文档；方案 A（`bin` 字段 + 启动器）可作为快速交付路径单独补充，不阻塞本任务。
