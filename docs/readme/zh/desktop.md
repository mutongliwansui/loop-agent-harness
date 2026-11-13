# 🖥 桌面端（Windows 安装包）

> [⬅ 返回 README](../../../README.md)

把 LoopAgent 装成一个**普通桌面应用**：双击图标即可打开窗口，**不需要装 Node.js、不需要开浏览器、不需要敲命令行**。

---

### 一、选择你的安装方式

构建产物落在 `dist-desktop/`，共两个 exe，**按你的场景二选一**：

| 产物 | 适用场景 | 说明 |
|---|---|---|
| `LoopAgent-Setup-<版本>-x64.exe` | **推荐**。日常办公电脑 | 一键安装，自动创建桌面与开始菜单快捷方式，可在「设置 → 应用」里卸载 |
| `LoopAgent-Portable-<版本>-x64.exe` | 公司禁止安装软件；或想装到 D 盘等非系统盘 | 单文件免安装，放到任意目录（含中文/空格路径）双击即用，删掉文件即卸载 |

> 两者功能完全一致，出自同一份程序代码。区别只在「是否往系统里登记」。

### 二、安装（安装包方式）

1. 双击 `LoopAgent-Setup-<版本>-x64.exe`
2. **首次运行会看到 SmartScreen 拦截**（见下一节），点「更多信息 → 仍要运行」
3. 安装**自动完成**，无需点「下一步」：全程约 10–30 秒，进度条走完窗口自动关闭
4. 桌面出现 **LoopAgent** 图标，双击启动

安装位置固定在当前用户目录下，**不需要管理员权限，全程无 UAC 提权弹窗**：

```text
%LOCALAPPDATA%\Programs\LoopAgent\
   LoopAgent.exe                 ← 应用主程序（双击这个）
   resources\loop-agent-core.exe ← 后端服务（由主程序自动拉起，无需手动运行）
   resources\app.asar            ← 界面代码
   ...
```

> **为什么装到 `LOCALAPPDATA` 而不是 `Program Files`**：装进 `Program Files` 必须提权，而现场多为**非管理员账户**，一遇 UAC 就装不上。装用户目录是让非管理员账户也能一键装成功的唯一可靠方式。
>
> 想装到 D 盘或其它位置 → 用**便携版**，放到哪就跑在哪。

### 三、首次运行：SmartScreen 提示

程序**未做代码签名**（现场无签名证书），Windows 会拦一次。这是预期行为，不是病毒：

1. 弹出「**Windows 已保护你的电脑**」蓝框
2. 点左侧「**更多信息**」
3. 点右下角「**仍要运行**」

![SmartScreen 拦截示意：点「更多信息」→「仍要运行」]

之后同一台机器不再拦截。

> 如果双击**完全没反应、也没有任何提示**：是安全软件在静默隔离。请把 `dist-desktop` 里的 exe 加入杀毒软件信任/白名单，或改用便携版放到非扫描目录重试。

### 四、使用

双击图标后：

1. 应用会自动**在后台拉起后端服务**并等待就绪（通常 1–3 秒）
2. 窗口自动加载界面，直接进入对话
3. **首次使用需在「设置」里填模型 API Key**（与 Web UI 完全一致）

**端口说明**：默认从 **3000** 开始，若该端口已被占用（例如你同时开着 `npm run serve` 或另一个实例），会自动顺延到 3001、3002……**无需任何配置**，窗口会直接连到实际端口。

**关窗口 = 退出程序**：后端进程会一并干净退出，不会残留在任务管理器里。

### 五、数据在哪里

配置、会话、记忆全部存放在用户目录，**与程序本体分离**：

```text
%USERPROFILE%\.loop-agent\
```

| 内容 | 位置 |
|---|---|
| 应用配置（含 API Key） | `%USERPROFILE%\.loop-agent\config.json` |
| 会话历史 | `%USERPROFILE%\.loop-agent\sessions\` |
| 记忆（SOUL / USER / MEMORY） | 项目工作空间下的 `.loop-agent\` 与记忆文件 |

> 升级、重装、换便携版位置都**不会丢数据**——数据不在程序目录里。

### 六、卸载

**安装包方式**：

- 「设置 → 应用 → 已安装的应用」找到 **LoopAgent** → 卸载
- 或「开始菜单 → LoopAgent → 卸载」
- 卸载前请**先退出应用**（关掉窗口即可），避免后端进程占用文件
- 卸载会清空程序目录，**不会删除 `%USERPROFILE%\.loop-agent`**

**便携版**：直接删除那个 exe 文件即可，不写注册表、不留残留。

> **彻底清除**（含所有对话与配置）：卸载后再手动删除 `%USERPROFILE%\.loop-agent` 目录。
> ⚠ 此操作不可恢复，删除前请备份重要会话。

### 七、从源码构建（开发者）

一次性串联构建全部产物：

```bash
npm run build:desktop
```

脚本按顺序执行 6 个阶段，任一失败即停止并打印指引：

| 阶段 | 动作 | 校验 |
|---|---|---|
| 1 | `npm run build:webui` | 产出 `webui/dist/index.html` |
| 2 | `npm run build:sea` | 产出 `dist-sea/loop-agent.exe` |
| 3 | **校验 SEA 已内嵌 WebUI** | 见下方说明 |
| 4 | `npm --prefix desktop run build` | 产出 `desktop/dist/main.cjs` |
| 5 | 准备资源 | 后端重命名拷贝为 `desktop/resources/loop-agent-core.exe` |
| 6 | `electron-builder --win --x64` | 产出 `dist-desktop/` 下两个 exe |

> **阶段 3 是必须的拦截**：安装后布局里 `resources/` 下**没有 `webui/dist` 目录**，界面只能来自 SEA 内嵌资源。而 `build-sea.mjs` 在缺 `webui/dist` 时只打印一行提示、**不报错不阻断**——放任流过就会得到「构建成功、安装成功、双击白屏」的包。所以脚本强制检查 `build:sea` 输出中是否出现「内嵌 WebUI 资源: N 个文件」，未出现即失败退出。
>
> 想验证这个拦截是否真的生效：临时把 `webui/dist` 改名，再跑 `npm run build:desktop`，应当**明确报错**而不是产出安装包。

**首次构建会下载 Electron 二进制**（约 100MB），若卡住或超时，设置国内镜像后重试：

```bash
# PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm run build:desktop
```

**构建环境要求**：Node.js ≥ 20.10；Windows 上构建 Windows 产物（不支持交叉编译，见 [SEA 单文件部署](./sea-deployment.md)）。

**产物体积**（实测回填）：后端 SEA 单文件 102.2MB，安装包 123.8MB，便携版 114.2MB，安装后占用 426.5MB。

### 八、常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 双击无任何反应 | 安全软件静默隔离 / SmartScreen 被直接关掉 | 加信任白名单；或右键「属性」勾「解除锁定」；改用便携版 |
| 窗口白屏 | 构建时未内嵌 WebUI（自建包才会遇到） | 重新执行 `npm run build:desktop`，确认阶段 3 校验通过 |
| 提示端口被占用 | 3000 已被别的程序占据 | 无需处理，程序会自动顺延端口 |
| 双击快捷方式没反应，但进程在 | 上一次异常退出留下的单实例锁 | 任务管理器结束 `LoopAgent.exe` 后重启 |
| 想换安装盘 | 安装包固定装用户目录 | 改用便携版放目标盘 |
| 卸装后配置还在 | 设计如此，数据与程序分离 | 需要时手动删 `%USERPROFILE%\.loop-agent` |

---

> 桌面端与浏览器方式（`npm run serve` + 打开浏览器）**互不影响**，可同时使用。
> 浏览器方式的说明见 [Web UI](./web-ui.md)，单文件后端见 [SEA 单文件部署](./sea-deployment.md)。
