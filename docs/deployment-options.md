# 部署方案：以可执行命令形态交付

> 背景：目前项目通过 `npm start`（`tsx src/index.ts`）运行，开发机需安装 Node.js 与全部依赖。现场部署环境通常没有源码、`node_modules`、npm 甚至 Node 运行时，需要以**可执行命令**形态交付。
>
> 本文档评估 5 种候选方案，给出推荐的两阶段落地路线，并列出现场部署必须处理的 3 个注意点。**本文档仅分析，不含代码改动。**

---

## 一、现状分析（打包友好性评估）

| 评估项 | 结论 | 说明 |
|---|---|---|
| 构建工具 | ✅ 已有 | `npm run build` = `tsup src/index.ts --format esm`，tsup 默认 bundle 依赖，产出自包含的 `dist/index.js` |
| 动态加载 | ✅ 无阻碍 | 全源码**无任何动态 `import()` / `require()` / `createRequire`**，全部静态导入，esbuild 可完整打包 |
| 原生模块 | ✅ 无阻碍 | 无 `better-sqlite3` 等 native 二进制依赖，不需要重新编译原生模块 |
| 依赖体积 | ⚠️ 中等 | `openai` + `@modelcontextprotocol/sdk` + `dotenv`，纯 JS，单文件体积约数 MB，可接受 |
| 数据落盘 | ✅ 无影响 | 数据均在文件系统（`~/.loop-agent/`、`{cwd}/.loop-agent/`、`{cwd}/memory/`），打包不改变读写路径 |
| 子进程依赖 | ⚠️ 需注意 | `node:child_process` 用于 `commandRun` 工具与 **MCP stdio 子进程**（按配置 `npx` 启动），现场离线环境需另行处理 |

**核心结论**：项目完全具备单文件打包条件，推荐路线不要求修改业务代码。

---

## 二、候选方案对比

| 方案 | 交付形态 | 现场要求 | 优点 | 缺点 |
|---|---|---|---|---|
| **A. tsup 单文件 + Node 运行** | `dist/index.js` + 启动器 | 安装 Node 18+ LTS | 改动最小、构建已就绪、跨平台 | 现场仍需 Node 运行时 |
| **B. Node SEA 单可执行文件** ⭐ | 单个 `loop-agent.exe` / 二进制 | 零依赖 | Node 官方特性、无第三方打包器、无原生依赖时最可靠 | 构建机需 Node 20.10+；产物分平台；需新增 CJS+SEA 构建脚本 |
| **C. Bun 编译** | 单个可执行文件 | 零依赖 | 一条命令、原生支持 TS | 引入 Bun 工具链；openai/MCP SDK 兼容性需实测 |
| **D. vercel/pkg** | 原生可执行文件 | 零依赖 | 传统方案、支持交叉编译 | **项目已停止维护**；ESM 支持弱需打 CJS；动态 require 需补丁 |
| **E. npm 全局安装** | `loop-agent` 命令 | Node + npm | 一行 `npm i -g` | 本质同 A，依赖 Node 与 npm registry |

---

## 三、方案详情

### 方案 A：tsup 单文件 + Node 运行（短期推荐）

**思路**：`npm run build` 已能产出依赖全部内联的 `dist/index.js`，现场只需「Node 运行时 + 一个启动命令」。

**关键改动点**：

1. `package.json` 增加 `bin` 字段，使 `npm i -g .` 后获得 `loop-agent` 命令：

   ```json
   {
     "name": "loop-agent-command",
     "bin": { "loop-agent": "./dist/index.js" }
   }
   ```

2. 注意 ESM 解析：`dist/index.js` 依赖项目根 `package.json` 的 `"type": "module"` 才能按 ESM 运行。若拷贝到无 `package.json` 的目录会按 CJS 解析报错。两种解决方式：
   - 保留「产物 + package.json + node_modules（仅运行时无需依赖）」，或
   - tsup 输出改为 `.mjs` 扩展名（`--out-extension .js=.mjs`），单文件随处可跑。

3. 提供 `start:dist` 脚本与 Windows 启动器：

   ```json
   { "scripts": { "start:dist": "node dist/index.js" } }
   ```

   ```bat
   @echo off
   chcp 65001 >nul
   node "%~dp0dist\index.js" %*
   ```

**验证方式**：`npm run build && npm run start:dist`，确认 REPL 正常启动、会话/记忆/工具可用。

**现场要求**：安装 Node 18+ LTS（绿色版解压即可，无需安装器）。

---

### 方案 B：Node SEA 单可执行文件（现场定型推荐）

**思路**：Node 20.10+ 官方支持的 **Single Executable Applications（SEA）**，把 JS 单文件与 Node 运行时合并为一个 `.exe`，现场零依赖、可直接作为命令运行。

**实施步骤**（Windows 为例，Linux/macOS 流程相同但二进制不同）：

1. **打 CJS 单文件**（SEA 对 CJS 最稳妥；ESM SEA 仅在高版本实验性支持）：

   ```bash
   npx tsup src/index.ts --format cjs --out-dir dist-sea
   ```

2. **编写 `sea-config.json`**：

   ```json
   {
     "main": "dist-sea/index.cjs",
     "output": "dist-sea/sea-prep.blob",
     "disableExperimentalSEAWarning": true
   }
   ```

3. **生成 SEA blob**：

   ```bash
   node --experimental-sea-config sea-config.json
   ```

4. **注入生成单 exe**：

   ```bash
   copy /b node.exe loop-agent.exe
   npx postject loop-agent.exe NODE_SEA_BLOB dist-sea/sea-prep.blob
   ```

5. 产物 `loop-agent.exe` 即最终可交付命令；把 SEA 构建流程封装为 `npm run build:sea`。

**注意事项**：
- `postject`（npm 包）只在**构建机**使用，现场不需要。
- SEA 单文件在启动时会先解压到临时目录，**首次启动略慢**，属正常现象。
- 打开即用的 exe 中，`process.cwd()` 仍是启动时的工作目录，配置/记忆路径语义不变。
- 交叉编译不可行：**必须在目标平台构建**（Windows exe 在 Windows 上打，Linux 二进制在 Linux 上打），建议 CI 多平台构建。

---

### 方案 C：Bun 编译（备选）

```bash
bun build --compile src/index.ts --outfile loop-agent
```

- 一条命令生成原生可执行文件，体积通常比 SEA 小，启动快。
- 缺点：团队需引入 Bun 工具链；`openai` / `@modelcontextprotocol/sdk` 在 Bun 运行时下的行为需实测（含流式、SSE、子进程）。
- 适合愿意切换工具链的团队，作为 SEA 出问题时的备选。

### 方案 D：vercel/pkg（不推荐）

- 经典方案，但 `vercel/pkg` 仓库已归档停更（2024），社区 fork 为 `@yao-pkg/pkg`。
- 对 ESM 支持弱，本项目需先打 CJS；遇到动态 `require` 需逐个打补丁。
- 仅在团队已有 pkg 经验且不想升级 Node 到 20.10+ 时考虑。

### 方案 E：npm 全局安装（轻量方案）

- 仅需 `bin` 字段 + `npm i -g .`，本质是方案 A 的安装形态。
- 与 A 不冲突：A 的 `bin` 配置同时满足 E 的全局安装需求。

---

## 四、推荐路线（两阶段）

### 阶段 1：方案 A —— 打通构建产物直跑（短期交付）

- 目标：`npm run build` 后 `node dist/index.js` 即可运行，配 `bin` 字段 + 启动器。
- 现场最低要求：绿色版 Node LTS 解压即用。
- 风险：极低（构建已存在，仅加 bin/启动器）。

### 阶段 2：方案 B —— Node SEA 单 exe（现场定型）

- 目标：交付单个 `loop-agent.exe`（Windows）/ 二进制（Linux），现场零依赖，注册为命令或放入 `PATH`。
- 前提：构建机升级到 Node 20.10+；在 CI 或目标平台构建。
- 风险：中等（新增 CJS+SEA 构建脚本，需在真实环境验证流式/工具/MCP 行为）。

> 两阶段可并行推进：阶段 1 先保证当前可交付，阶段 2 作为最终形态。

---

## 五、现场部署注意点（无论选哪个方案）

### 5.1 MCP stdio 子进程依赖 npx / 网络

- MCP server 默认配置为 `npx -y @modelcontextprotocol/server-xxx`，**现场离线/无 npm 时必然失败**。
- 处理方式二选一：
  - 提前在目标机 `npm i -g` 对应的 MCP server，并把 `.mcp.json` 的 `command` 改为本地命令（如 `C:\tools\mcp-server-filesystem.cmd`）；
  - 现场不需要 MCP 时，`/mcp remove` 或配置留空即可（启动有失败隔离，不影响主功能）。

### 5.2 配置与密钥迁移

- `.env`（API Key / BaseURL / 模型）需随部署分发，或在目标机用 `/config set` 写入 `~/.loop-agent/config.json`。
- `~/.loop-agent/.keyfile` 是历史加密会话的**唯一解密凭证**：迁移到新机必须一并拷贝，或先用 `keychain.exportKey()` 导出、目标机 `importKey()` 恢复，否则历史会话无法解密。
- 若现场不需要恢复历史，可在目标机重置会话存储。

### 5.3 工作目录语义

- `{cwd}/memory/`、`{cwd}/.loop-agent/skills/` 等相对路径依赖启动时的工作目录。
- 建议现场固定专用工作目录，用快捷方式 / 计划任务 / 服务固定 `cwd` 启动，避免误在不同目录启动导致记忆"分家"。

---

## 六、附录：决策待定项

| 待定项 | 影响 | 建议 |
|---|---|---|
| 现场是否离线 | 决定 MCP 子进程处理方式 | 提前确认，离线则预装 MCP server |
| 现场操作系统 | SEA/pkg 产物分平台 | 确认 Windows / Linux 占比，按平台构建 |
| 构建机 Node 版本 | 决定是否可直接上 SEA | 目标机装 Node 20.10+ 或升级构建机 |
| 是否需要历史会话迁移 | 决定密钥迁移工作 | 需要则用 `exportKey`/`importKey` |
