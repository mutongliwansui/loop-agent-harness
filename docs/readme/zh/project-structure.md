# 📁 项目结构

> [⬅ 返回 README](../../../README.md)

```
loop-agent-command/
├── src/
│   ├── index.ts                      # 🚪 CLI 入口（交互式 REPL + 多命令支持）
│   ├── config.ts                     # ⚙️ 环境变量配置（deprecated，兼容旧代码，请改用 config/index.ts）
│   ├── debug.ts                      # 📝 调试日志（文件输出，LLM/工具/迭代日志）
│   ├── types.ts                      # 📐 核心类型定义（Tool, ChatMessage, AgentEvents 等）
│   ├── agent/
│   │   ├── react-agent.ts            # 🔄 ReAct 主循环（流式版本 + 会话自动保存）
│   │   ├── prompt.ts                 # 📝 System Prompt 构造器（含 Skill 元信息注入）
│   │   ├── logger.ts                 # 🎨 ConsoleLogger（彩色日志输出，实现 AgentEvents）
│   │   └── stats.ts                  # 📊 LLM 统计聚合（buildLLMStatsSummary）
│   ├── llm/
│   │   └── client.ts                 # 🤖 LLM 客户端（chat + chatStream + 自动重试）
│   ├── api/                          # 🌐 HTTP API 服务层（--serve 与 WebUI 共用后端）
│   │   ├── router.ts                 # 路由注册（createRoutes，开发者中心反射数据源）
│   │   ├── server.ts                 # HTTP 服务器（token 鉴权 / 静态托管 / SSE）
│   │   ├── handlers/                 # 各资源处理器（sessions/messages/tools/models/mcp/memory/…）
│   │   ├── subagent-notice.ts        # 后台子任务完成通知构造（超长结果完整落盘）
│   │   └── run-journal.ts            # run 生命周期日志（running/done/failed/aborted）
│   ├── config/                       # ⚙️ 分层配置系统
│   │   ├── index.ts                  # 统一导出
│   │   ├── schema.ts                 # 配置类型定义 + 默认值（含 skill / memory 段）
│   │   ├── loader.ts                 # 配置加载器（分层合并）
│   │   ├── writer.ts                 # 配置写入器（持久化）
│   │   ├── merge.ts                  # 深度合并工具
│   │   └── mcp-manager.ts            # MCP 生命周期管理器
│   ├── skill/                        # 🎯 Skill 技能包
│   │   ├── index.ts                  # 统一导出
│   │   ├── types.ts                  # Skill 类型定义（SkillMetadata / SkillContent）
│   │   ├── scanner.ts                # 目录扫描 + SKILL.md YAML frontmatter 解析
│   │   └── loader.ts                 # SkillLoader（扫描 / 渐进式加载）
│   ├── memory/                       # 🧠 三层记忆管理（Phase 1-5）
│   │   ├── index.ts                  # 统一导出
│   │   ├── types.ts                  # 记忆类型定义 + 默认配置
│   │   ├── working.ts                # L1 WorkingMemory（token 估算 + 压缩）
│   │   ├── episodic.ts               # L2 EpisodicMemory（按天 Markdown 日记 + 检索）
│   │   ├── curated.ts                # L3 CuratedMemory（SOUL/USER/MEMORY 读写）
│   │   ├── context.ts                # ContextAssembler（L3 注入 + L2 检索组装）
│   │   ├── callback.ts               # ToolMemoryCallback（工具结果自动写入 L2）
│   │   ├── gate.ts                   # PromotionGate（晋升闸门：确认计数/阈值）
│   │   ├── dreaming.ts               # DreamingPipeline（L2 → L3 后台晋升）
│   │   ├── fts.ts                    # MemoryIndex（BM25 全文检索 + 分词）
│   │   ├── embedding.ts              # EmbeddingClient（向量嵌入客户端）
│   │   ├── vector.ts                 # VectorMemory（向量存储 + 余弦相似度）
│   │   └── hybrid.ts                 # 混合检索（FTS + 向量 RRF 融合）
│   ├── session/                      # 💾 会话持久化（加密存储）
│   │   ├── index.ts                  # 统一导出
│   │   ├── store.ts                  # SessionStore（会话读写/索引/工作空间隔离）
│   │   ├── keychain.ts               # Keychain（主密钥自动生成/加载/备份）
│   │   ├── crypto.ts                 # 加密原语（PBKDF2 + AES-256-GCM）
│   │   └── types.ts                  # 会话类型定义 + 默认配置
│   ├── documents/                    # 📄 文档解析（fileRead 复用）
│   │   ├── detect.ts                 # 类型探测（扩展名 + 魔数）
│   │   ├── extract.ts                # 解析分发入口（含文档内图片 OCR 整理）
│   │   ├── word.ts / docx.ts / pptx.ts / xlsx.ts / odt.ts / rtf.ts / pdf.ts   # 各格式正文提取（docx 走零依赖 zip 解包，不经 word-extractor 流式管道）
│   │   ├── images.ts                 # 内嵌图片抽取 + OCR 结果拼装为 [Image N] 块
│   │   ├── pdf-raster.ts             # 扫描版 PDF 逐页栅格化（pdftoppm / mutool / gs）
│   │   ├── external.ts               # 外部转换器调用（docx/pdf 兜底）
│   │   ├── text.ts                   # 纯文本读取（行范围 / 截断 / 编码）
│   │   └── zip-text.ts               # zip 文本平铺（避免二进制噪声）
│   ├── ocr/                          # 🔍 本地 OCR 引擎（零依赖）
│   │   ├── index.ts                  # 引擎工厂 + 可用性探测
│   │   ├── engine-winrt.ts           # Windows.Media.Ocr（经 powershell.exe 调用）
│   │   ├── engine-http.ts            # 可选 HTTP OCR 端点
│   │   ├── run-ocr.ts                # 单图编排（超时 / 缓存 / 限流 / 错误归类）
│   │   ├── layout.ts                 # 版面还原（y 聚类视觉行 / x 投影列聚类 / text|table|words 渲染）
│   │   ├── postprocess.ts            # 断行修复与后处理
│   │   └── cache.ts                  # 结果 LRU 缓存（文件指纹参与 key）
│   └── tools/
│       ├── index.ts                  # 🛠️ 工具系统聚合入口
│       ├── ocrImage.ts               # 🔤 内置工具：图片文字识别（ocrImage）
│       ├── registry.ts               # 📋 工具注册表（注册/查询/转 OpenAI 格式/MCP 管理）
│       ├── runner.ts                 # ⚡ 工具执行器（超时控制 + 异常捕获）
│       ├── commandRun.ts             # 🖥️ 内置工具：命令执行
│       ├── fileRead.ts               # 📄 内置工具：文件读取
│       ├── fileWrite.ts              # ✏️ 内置工具：文件写入
│       ├── editFile.ts               # 🔁 内置工具：文本编辑（字面量/正则/行范围）
│       ├── grep.ts                   # 🔍 内置工具：内容检索
│       ├── activateSkill.ts          # 🎯 内置工具：Skill 激活（渐进式加载）
│       ├── vision/                   # 👁️ 视觉工具（对接多模态视觉模型）
│       │   ├── tools.ts              # 视觉工具 analyzeImage（描述 / 定向问答 / 结构化提取三合一）
│       │   ├── image.ts              # 图片解析（本地转 base64 data URL / URL 校验 / 大小限制）
│       │   ├── cache.ts              # LRU 结果缓存（本地文件指纹参与 key，内容变更自动失效）
│       │   └── stats.ts              # 用量统计（成功 / 失败 / 缓存命中 / 耗时 / token）
│       └── mcp/                      # 🌐 MCP 工具接入
│           ├── index.ts              # 入口
│           ├── client.ts             # MCP 客户端（stdio / SSE 传输）
│           └── adapter.ts            # MCP 工具适配器（转 Tool 接口）
├── examples/
│   └── run.ts                        # 📝 编程式调用示例
├── tests/                            # 🧪 测试（unit 并行 / integration 串行，分层见 vitest.config.ts）
│   ├── integration/                  # 集成测试（8 个测试文件 / 17 个用例，真实 LLM/PTY，串行）
│   │   ├── a-no-tool.test.ts         # 无需工具的场景
│   │   ├── b-single-tool.test.ts     # 单工具调用
│   │   ├── c-multi-tool.test.ts      # 多工具调用
│   │   ├── d-tool-failure.test.ts    # 工具执行失败
│   │   ├── e-unknown-tool.test.ts    # 工具不存在
│   │   ├── f-max-iterations.test.ts  # 达到最大迭代次数
│   │   └── g-parallel-tools.test.ts  # 同轮并行工具
│   ├── memory-working.test.ts        # L1 工作记忆（token 估算 + 压缩）
│   ├── memory-callback.test.ts       # 工具回调自动写入 L2
│   ├── memory-flush.test.ts          # L2 按天日志 flush
│   ├── memory-dreaming.test.ts       # Dreaming 晋升流水线
│   ├── memory-gate.test.ts           # Promotion Gate
│   ├── memory-phase4.test.ts         # Phase 4 混合检索
│   ├── memory-phase5.test.ts         # Phase 5 向量检索
│   ├── session-isolation.test.ts     # 会话工作空间隔离
│   ├── edit-file.test.ts             # editFile 文本编辑工具（字面量/正则/行范围）
│   ├── file-read.test.ts             # fileRead 行号输出
│   ├── activate-skill.test.ts        # activate_skill 输出技能目录 / SKILL.md 路径
│   ├── system-prompt.test.ts         # System Prompt 的 Skill 区块注入
│   ├── llm-stats.test.ts             # LLM 统计聚合
│   ├── vision-cache.test.ts          # 视觉结果缓存（LRU / TTL / 文件指纹失效）
│   ├── vision-image.test.ts          # 图片解析（本地转 base64 / URL / 大小与格式校验）
│   ├── vision-client.test.ts         # chatVision 多模态客户端（jsonMode / 错误语境重写 / 重试）
│   ├── vision-registry.test.ts       # 视觉工具注册（vision.enabled 联动 / Tab 补全名单）
│   ├── vision-tools.test.ts          # 视觉工具管道（解析 / 缓存 / 回退 / 截断）
│   └── vision-command.test.ts        # /vision 命令（status / test）
├── docs/
│   ├── plan.md                       # 📋 开发总计划与里程碑
│   ├── openclaw_memory_management.md # 🧠 记忆管理设计参考（OpenClaw 风格）
│   └── tasks/                        # 📂 逐任务文档（15 个任务，含记忆管理 Phase 1-5 与 LLM 统计）
├── .loop-agent/                      # 📋 工作空间配置与 Skill（.agent-config.json + skills/，整体不进入版本控制）
│   ├── .agent-config.json            # ⚙️ 工作空间配置（可选，运行时生成）
│   └── skills/                       # 🎯 工作空间 Skill（example-skill、py-pptx 等）
├── memory/                           # 🧠 L2 情景记忆（运行时生成，按天分文件）
├── SOUL.md                           # 🧠 L3：Agent 人格
├── USER.md                           # 🧠 L3：用户画像
├── MEMORY.md                         # 🧠 L3：精炼事实
├── .env                              # 🔒 环境变量（需从 .env.example 复制创建）
├── .env.example                      # 📄 环境变量模板
├── .mcp.json                         # 🔌 MCP 配置（可选，从 .mcp.json.example 复制）
├── .mcp.json.example                 # 📄 MCP 配置模板
├── package.json
├── tsconfig.json
├── vitest.config.ts                  # 🧪 测试配置（unit 并行 / integration 串行分层）
└── README.md                         # 📖 项目说明文档
```
