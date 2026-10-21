# 🖥️ Web UI（浏览器图形界面）

> [⬅ 返回 README](../../../README.md)

`--serve` 模式在 REST API 之外同端口托管浏览器界面（Vue 3 + Vite 构建链，产物提交在 `webui/dist/`，由 `node:http` 静态层直接服务）：**打开网址即得聊天 + 全量运维管理台**，全部复用既有 REST 端点，API 行为零变化。

### 启动

```bash
npm run build:webui   # 首次或改动前端后构建（产物输出 webui/dist/，已随仓库提交，克隆即可用）
npm run serve
# 或
npx tsx src/index.ts --serve
```

浏览器打开 `http://127.0.0.1:3000/` 即可使用。

```
HTTP API 服务已启动
  地址:    http://127.0.0.1:3000
  鉴权:    仅本机（未配置 api.token）
  端点:    47 个（会话 5 + 健康 1 + 命令资源化 40 + 上传 raw 1）
  静态页:  webui/dist 托管（聊天 + 管理台）
  提示:    Ctrl+C 退出；配置变更需重启生效
```

> 若 `webui/dist` 不存在（如自行清理过），静态层自动跳过，纯 API 服务不受影响；重新执行 `npm run build:webui` 即可恢复。

### 鉴权（token 门）

与 REST API 完全同策略：静态页面本身不鉴权，页面内所有 API 调用走 Bearer。

- **未配置 token（默认）** → 本机访问零感，打开即用；
- **配置 token 后**（`/config set api.token xxx`，重启生效）→ 首次访问弹出 token 输入框，校验通过后记忆在浏览器 `localStorage`；token 失效（401）自动清空并重新弹出；
- 远程（局域网）访问时服务端需 `api.host` 绑定 `0.0.0.0` 且配置 `api.token`，浏览器端输入同一 token 即可。

### 界面总览

左侧导航 8 项（中文界面，深浅色跟随系统，窄屏下导航横排折叠为图标条）：

| 视图 | 能力 | 背后端点 |
|---|---|---|
| 💬 聊天 | 多会话（新建/切换/删除，删除 in-flight 409 提示）、SSE 流式渲染（思考/工具调用折叠块/最终回答）、停止生成、对话内上传 | `/sessions`、`/sessions/:id/messages`、`/uploads/raw`、`/uploads` |
| ⚙️ 配置 | 遮蔽配置树浏览、单键读取（含来源层）、写入/删除（workspace/global 分层）、`api.*` 修改提示重启 | `/config`、`/config/path`、`/config/:key` |
| 🤖 模型 | 登记簿管理（增/删/改）、一键切换 active、连通性测试（延迟）、当前生效快照 | `/models`、`/model`、`/models/:alias/test` |
| 🔧 工具 | 内置工具启用/禁用（开关即生效）、参数 schema 查看、热重载 | `/tools`、`/tools/:name`、`/tools/reload` |
| 🔌 MCP | 服务器登记（stdio/SSE/HTTP）、连接测试、批量重连、删除、工具明细；登记连接失败提示「配置已落盘」半态 | `/mcp/servers`、`/mcp/reload` |
| 🧩 技能 | 从本地目录安装（同名可选覆盖）、卸载（自动作用域）、SKILL.md 正文查看、热重载 | `/skills`、`/skills/reload` |
| 🧠 记忆 | 三层记忆状态、情景记忆按天浏览、Curated 常驻条目、语义检索、Promotion Gate 决策、Dreaming 受理、初始化 | `/memory/*` |
| 🩺 诊断 | 一键体检卡片流（✅ 通过 / ⚠ 缺失 / ⛔ 阻断 三态配色）与整体健康徽标 | `/doctor` |

<!-- 截图位：待补 -->

### 对话内上传

聊天输入框 📎 按钮打开上传面板：文件选择框（可多选）→ 逐文件以二进制直传 `POST /uploads/raw`（浏览器拿不到本地完整路径，故新增该端点；CLI 的 `/upload` 路径模式不受影响）→ 上传成功在输入框上方显示上下文 chip（文件名 + 大小），随下一条消息注入 Agent 上下文。chip ✕ 仅前端移除不再注入；「管理列表」可查看/清空已上传文件（动词即确认）。

### 多标签页同步与后台完成提醒

同一浏览器打开多个标签页时，运行态自动互相同步（Task-20261021-002-07）：A 页发起/完成的运行，B 页 ≤1 秒出现运行点/未读点并刷新侧栏；A 页删除会话，B 页同步移除；A 页查看过的会话，B 页未读红点一并清除。通道为 `BroadcastChannel('loop-agent')`，旧浏览器自动降级 localStorage；广播只传派生状态（运行开始/结束/已读/删除），消息内容始终以服务端为准。

后台完成提醒在输入区 🔔 面板配置，两项独立开关且持久化：**系统通知**（仅窗口切走时弹，同会话通知互替防刷屏，点击通知回跳会话；权限仅在勾选时请求，浏览器拒绝后可去浏览器设置恢复）与**提示音**（WebAudio 合成双音，无需授权）。前台完成保持页内 toast 不变。通过局域网 IP + http 访问时浏览器不提供系统通知，🔔 面板会显示降级说明，提示音与页内提醒不受影响。

### 安全细节

- 静态层防路径穿越（`..%2f` 等 → 403）；`/assets/*` immutable 缓存一年，`index.html` 不缓存（升级即生效）。
- Markdown 渲染经 `marked` + `DOMPurify` 消毒，防模型输出注入脚本。
- API 错误以 toast 显示后端 `error.message`；409 busy、413 超限（单文件 100MB）等均有对应文案。

### 前端开发

```bash
cd webui
npm install
npm run dev        # Vite dev server :5173，按端点前缀（/sessions、/config…）代理到本地 --serve :3000
npm run build      # 产物输出 dist/（主仓库 npm run build:webui 等价）
```

技术栈：Vue 3 `<script setup>` + TypeScript + Vite；hash 路由（`#/chat` 等，零路由依赖）；SSE 用 `fetch` + `ReadableStream` 手动分帧（`EventSource` 无法携带 Bearer header）。

### 非目标

移动端原生 App、多用户账号体系、SEO/公开站点、i18n 双语 UI（当前中文单语）、拖拽/粘贴上传（演进项）。
