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
| 全平台 | `dist-sea/node_modules/@lydell/` | **可选**：兼容旧分发形态。不拷也能用——exe 已内嵌原生模块（见下） |

> **不可交叉编译**：Node SEA 要求在**目标操作系统上构建**（Windows 产物只能在 Windows 运行）。现场是哪种系统，就在哪种系统上执行一次 `npm run build:sea`。

> **只拷 exe 就够了**：构建脚本把交互式终端需要的 `@lydell/node-pty` 原生模块**整树内嵌**进 exe，
> 首次用到终端时自动释放到 `%TEMP%/loop-agent-pty-<指纹>/`（Windows 约 1.59 MB / 24 个文件），
> 之后按内容指纹复用，升级 exe 会换新目录、不干扰正在运行的旧实例。
>
> 解析顺序是**磁盘优先、内嵌兜底**：
> 1. `exe 同级 node_modules/`（向上查找，兼容旧分发形态 → 命中则不释放，零开销）
> 2. 内嵌释放目录（单文件部署 → 首次释放后复用）
>
> 所以「exe + 同级 `node_modules/`」的老分发方式**仍然可用**；而只拷 exe 时终端同样开箱可用，
> 不再降级为「交互式终端不可用」。

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
4. **内嵌原生依赖**：把 `node_modules/@lydell/node-pty`（JS 包装）与其平台子包
   `@lydell/node-pty-<platform>-<arch>`（真正的 `.node`、`conpty.dll`、`OpenConsole.exe`）
   **整树作为 SEA assets 内嵌**进 exe，同时仍拷贝一份到产物同目录 `node_modules/` 作为兼容形态

第 4 步为什么必须「整树」而不是只嵌 `.node`：`lib/*.js` 用相对路径 require
`prebuilds/<platform-arch>/conpty.node`，`windowsPtyAgent.js` 用 `__dirname` fork 子进程，
`conpty.dll` / `OpenConsole.exe` 躺在子目录里——只嵌单个 `.node` 必炸。

`.node` 无法直接从内存 dlopen（`process.dlopen()` 要求真实文件系统路径），
所以运行时走「内嵌 asset → 写入临时文件 → 再加载」（见 `src/terminal/pty-embed.ts`）。
释放目录用内容指纹命名，配合 `.ready` 标记与**逐文件尺寸校验**，可幂等复用与损坏自愈；
多实例并发首次启动时先写 `.tmp-<pid>-<rand>` 再原子 rename，读到半个文件的窗口为零。

Windows 上还有个坑：若另一个实例正在运行、已把 `conpty.node` 映射进地址空间，
那么整个释放目录既删不掉（`rmSync` EPERM）也覆盖不了那个文件。
此时不是放弃，而是**原地补缺**——只写缺失或被截断的文件，最后才补 `.ready`；
实在补不齐（缺的正好是被锁的文件）才退到备用目录 `loop-agent-pty-<指纹>-b1`。
所以「另一个实例开着」不会让新实例的终端永久不可用。

对应编排脚本：[scripts/build-sea.mjs](../../../scripts/build-sea.mjs)（`package.json` 的 `build:sea`）。

### 现场注意点

| 事项 | 说明 |
|---|---|
| **MCP 依赖** | 使用 stdio 型 MCP server（如 `npx -y @modelcontextprotocol/...`）时，目标机仍需安装 Node/npx 才能拉起子进程；SSE 型无此要求 |
| **全局配置与密钥迁移** | 首次运行会在 `~/.loop-agent/` 生成全局配置、`.keyfile`（会话加密主密钥）等；迁机时建议一并迁移，否则历史加密会话无法解密（可用 `keychain.exportKey()` 备份） |
| **工作目录语义** | 程序以**当前工作目录**为工作空间根：L2 记忆写入 `<cwd>/memory/`。配置与 Skill 已全局化（`~/.loop-agent/`，见需求 20261112-008），不再随目录变化；记忆仍按目录区分，在不同目录启动会看到不同的"项目记忆上下文" |
| **无需 Node 运行时** | 单文件产物自带 Node 运行时，目标机只需操作系统本身 |
| **原生模块已内嵌** | `@lydell/node-pty` 整树内嵌在 exe 内，首次使用终端时释放到 `%TEMP%/loop-agent-pty-<指纹>/`。**只需分发 exe**；旧「exe + 同级 `node_modules/`」形态仍受支持（磁盘优先，命中则不释放）。若 `%TEMP%` 不可写或空间不足，终端会降级并给出实际查找路径与失败原因。目录被其他实例占用而无法删除时能原地补缺自愈；万一仍失败，按提示删除 `%TEMP%` 下对应的 `loop-agent-pty-*` 目录后重启即可 |
