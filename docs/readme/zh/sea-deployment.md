# 🚀 SEA 单文件部署

> [⬅ 返回 README](../../../README.md)

将 Agent 打包为**单个可执行文件**（Node SEA，Single Executable Applications），现场部署**无需安装 Node.js 与任何依赖**，直接运行即可。

### 构建

```bash
# 构建机需 Node.js >= 20.10
npm run build:sea
```

产物输出到 `dist-sea/`：

| 平台 | 产物 | 说明 |
|---|---|---|
| Windows | `dist-sea/loop-agent.exe` | 已实测验证（Node v24） |
| Linux | `dist-sea/loop-agent` | 需在 Linux 上构建 |
| macOS | `dist-sea/loop-agent` | 需在 macOS 上构建 |
| 全平台 | `dist-sea/node_modules/@lydell/` | 原生 PTY 模块，**必须与 exe 同目录分发**（见下） |

> **不可交叉编译**：Node SEA 要求在**目标操作系统上构建**（Windows 产物只能在 Windows 运行）。现场是哪种系统，就在哪种系统上执行一次 `npm run build:sea`。

> **分发时要连 `node_modules/` 一起拷走**：exe 本身是单文件（含 Node 运行时与 WebUI 资源），
> 但**原生模块无法内嵌**进 SEA blob。交互式终端依赖 `@lydell/node-pty`，构建脚本已自动把
> `node_modules/@lydell` 拷到 exe 同目录，所以分发单位是「exe + 同级 `node_modules/`」。
> 只拷 exe 时服务仍能正常启动，只是终端降级为「交互式终端不可用」并提示缺失路径。

### 运行

```bash
# Windows
.\dist-sea\loop-agent.exe

# Linux / macOS（先 chmod +x）
./dist-sea/loop-agent
```

运行体验与 `npm start` 完全一致：进入交互式 REPL，`/status`、`/config`、`/memory`、`/session` 等命令全部可用，记忆系统（L1/L2/L3）正常启用。

### 构建原理

1. **打包**：`tsup` 将 TypeScript 编译为单文件 CJS，第三方依赖全部内联（`noExternal`）
2. **生成 blob**：`node --experimental-sea-config` 根据 `sea-config.json` 生成准备 blob
3. **注入**：复制 Node 运行时作为产物骨架，用 `postject` 注入 `NODE_SEA_BLOB`
4. **拷贝原生依赖**：把 `node_modules/@lydell/node-pty`（JS 包装）与其平台子包
   `@lydell/node-pty-<platform>-<arch>`（真正的 `.node`）复制到产物同目录的 `node_modules/` 下

第 4 步不能省：SEA blob 只能内嵌 JS 与静态 assets，**原生模块必须在运行时从磁盘加载**。
终端启动时的解析基准是 exe 所在目录（SEA 下 `process.argv[1]` 是 CLI 参数，已排除），
所以 `node_modules/@lydell` 只有落在 exe 同级目录才生效。

对应编排脚本：[scripts/build-sea.mjs](../../../scripts/build-sea.mjs)（`package.json` 的 `build:sea`）。

### 现场注意点

| 事项 | 说明 |
|---|---|
| **MCP 依赖** | 使用 stdio 型 MCP server（如 `npx -y @modelcontextprotocol/...`）时，目标机仍需安装 Node/npx 才能拉起子进程；SSE 型无此要求 |
| **全局配置与密钥迁移** | 首次运行会在 `~/.loop-agent/` 生成全局配置、`.keyfile`（会话加密主密钥）等；迁机时建议一并迁移，否则历史加密会话无法解密（可用 `keychain.exportKey()` 备份） |
| **工作目录语义** | 程序以**当前工作目录**为工作空间根：L2 记忆写入 `<cwd>/memory/`，工作空间配置读取 `<cwd>/.loop-agent/`。在不同目录启动会看到不同的"项目上下文" |
| **无需 Node 运行时** | 单文件产物自带 Node 运行时，目标机只需操作系统本身 |
| **原生模块需随 exe 分发** | `@lydell/node-pty` 是原生 `.node`，SEA blob 装不进去。分发单位是「exe + 同级 `node_modules/`」；漏拷时终端报「交互式终端不可用」并在提示里给出实际查找路径 |
