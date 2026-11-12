# 🔧 内置工具

> [⬅ 返回 README](../../../README.md)

| 工具 | 名称 | 说明 | 参数 |
|---|---|---|---|
| 🖥️ **命令执行** | `commandRun` | 在本地执行 shell 命令，返回 stdout + stderr；长任务可 `background:true` 后台运行（立即返回 `taskId`，不受 30s 超时限制）；会话空闲期间任务完成时，API 服务以合成输入发起一轮唤醒 run 主动消费完成通知（`tools.backgroundNotify.wakeIdle`，默认开启）。前台输出默认头尾各保留 32KB（总上限 64KB，可配置；超限时完整输出同步落临时文件并给出路径），中间省略并标注字节数，不再因 maxBuffer 失败；结束标签统一为 `[exit=N]` / `[timeout=Nms]` / `[aborted]` / `[signal=…]` + `[duration=…]` | `command`（必填）, `cwd`（可选）, `timeout`（可选，默认取 `tools.commandRun.timeoutMs`，仅前台生效）, `background`（可选，默认 `false`） |
| ⏱️ **后台任务状态** | `commandStatus` | 查询后台命令任务状态（running/exited/killed/orphaned-*）、退出码、耗时与日志大小；不带 `taskId` 时返回最近 5 个任务摘要 | `taskId`（可选） |
| 📜 **后台任务日志** | `commandLogs` | 增量读取后台任务日志：不传 `sinceOffset` 返回「上次读到处→尾部」并推进游标；单次上限 8KB；`tail:true` 只读最近 2KB 尾部 | `taskId`（必填）, `sinceOffset`（可选，字节偏移）, `tail`（可选） |
| ⏹️ **后台任务停止** | `commandStop` | 终止后台任务：杀掉其进程树（Windows `taskkill /T /F`；POSIX 进程组）。幂等；会话停止不连带终止后台任务，必须显式调用 | `taskId`（必填） |
| 📄 **文件读取** | `fileRead` | 读取文件内容，支持按行范围部分读取（`startLine`/`endLine`，1-based 含端点），默认每行带 `行号: ` 前缀。默认读取上限：全文最多 2000 行 / 256KB，单行超过 8192 字符会截断，超出时末尾附截断提示并给出续读行号；超过 16MB 的全文读取直接拒绝（需分段）。**文档支持（需求 20261112-001）**：自动识别 doc/docx/pdf/xlsx/pptx/rtf/odt（魔数 + 扩展名）并提取为 UTF-8 纯文本，复用行号/区间/`maxBytes` 语义；PDF/PPTX 插入 `=== 第 N 页 ===` 页标记、XLSX 插入 `=== Sheet: 名称 ===`，分页文档（PDF/PPTX/XLSX）可用 `pages` 按页读取（`3` / `3-7` / `3-` / `1,4,9`，xlsx 的 page 为工作表序号，与 `startLine`/`endLine` 互斥）；文档行号为**提取文本行号**，输出首行会显式声明；源文件上限 50MB、单文档解析预算 15s；加密 PDF 提示无法解密，扫描件提示没有文本层（系统存在 `pdftotext` 时自动兜底）；截断时完整提取文本落临时文件并注明「非原始二进制文档」；旧版 .xls/.ppt 提示另存为。**文档内图片取文（需求 20261112-002 / 20261112-004）**：`ocr.enabled` 且 `ocr.doc.enabled=true` 时，docx/pptx/xlsx/odt 的内嵌图片（`*/media/*` 位图，`emf`/`wmf` 矢量图跳过）与 PDF 无文本层页会被逐张取文，结果以 `[图片 N（word/media/image2.png）：视觉描述] … [/图片 N]` 块追加到提取文本尾部（块前有一行 `=== 文档内图片文本 ===`），行号/`startLine`/`endLine`/`maxBytes` 管线与正文完全一致。**取文顺序与 `analyzeImage` 一致：视觉优先 → 本地 OCR 兜底**（开关 `ocr.doc.preferVision`，默认 `true`，但需 `vision.enabled=true` 才实际生效）：视觉成功时块头为 `视觉描述`；视觉失败则降级本地 OCR，块头写 `OCR 文本（视觉不可用：<摘要>；已降级为本地 OCR（<引擎>））` 并附一行 OCR 能力边界说明（只给文字，答不了颜色/布局/数量）；两者都失败时块内保留两条原因（`取文失败（视觉：…；OCR：…）`）。PDF 扫描页优先用 **Windows 内建渲染器**（`Windows.Data.Pdf`，零安装、不起外部进程依赖），不可用时回落到 `pdftoppm`/`mutool`/`gs` 或配置的 `ocr.pdfRasterizer`；后端策略由 `ocr.pdfRasterEngine`（`auto`/`winrt`/`external`）控制，全部不可用时保持原「扫描件」提示并给出安装指引。三重预算（视觉与本地 OCR 共用）：`ocr.doc.maxImages`（默认 20 张）、`ocr.doc.timeBudgetMs`（默认 15s，视觉单图超时取 `min(vision.timeoutMs, 剩余预算)`）、`ocr.doc.maxCharsPerImage`（默认 4000 字符，视觉结果同样截断），超限逐张给出「未取文（超过 …）」可操作提示；单张失败只污染该块；视觉与 OCR 都不可用时整块不产出。**行为变化（需求 20261112-004）**：非 Windows 平台（本机无 OCR 引擎）在 `vision.enabled=true` 时文档图片块**照常产出视觉描述**，不再整块消失。二进制文件（前 8000 字节含 NUL）仍拒绝读取。**需求 20261111-003 起已移除 `offset`/`limit` 别名参数**，行范围只保留 `startLine`/`endLine` 一套语义 | `path`（必填）, `startLine`（可选，1-based 起始行，须与 `endLine` 成对）, `endLine`（可选，含该行，须与 `startLine` 成对）, `pages`（可选，分页文档页码：PDF/PPTX/XLSX，如 `3` / `3-7` / `3-` / `1,4,9`）, `maxBytes`（可选，返回内容字节上限）, `encoding`（可选）, `lineNumbers`（可选，默认 `true`） |
| ✏️ **文件写入** | `fileWrite` | **整文件写入**：`overwrite` 用 `content` 完整替换文件全部内容（**原内容会永久丢失，不支持区域/局部覆盖**，局部修改请用 `editFile`）；`append` 追加到末尾，自动创建父目录。已存在文件的换行自动适配该文件主导行尾（如 CRLF），新文件保持 LF；同文件写操作自动串行化 | `path`（必填）, `content`（必填，overwrite 时为覆盖后的完整文件内容）, `mode`（可选，`overwrite` / `append`） |
| 🔁 **文件编辑** | `editFile` | 三种模式：①字面量替换（要求唯一出现，多处匹配报错以防误改）；②`regex=true` 正则替换（支持 `$1`/`$&` 捕获引用）；③指定 `startLine`/`endLine` 整段行替换。**行尾归一化**：匹配与校验对 `\r\n`/`\n` 等价（多行 oldText 可直接编辑 CRLF 文件），写回保持原文件行尾风格（未触及区域字节级不变，替换段适配主导行尾）；同文件写操作自动串行化；失配时报错附首个差异行与近似候选，文件 mtime 变化时提示「可能已被并发修改，先 fileRead 再编辑」 | `path`（必填）, `newText`（必填）, `oldText`（未指定行范围时必填）, `startLine`（可选）, `endLine`（可选）, `replaceAll`（可选，默认 `false`）, `regex`（可选，默认 `false`）, `flags`（可选，如 `i`/`m`/`s`） |
| 🔍 **内容检索** | `grep` | 在文件或目录中检索内容（模仿 grep）：支持正则、忽略大小写、递归搜索（自动跳过 `node_modules` / `.git` / `dist`，目录递归深度上限 5 层）。**文档支持（需求 20261112-001）**：doc/docx/pdf/xlsx/pptx/rtf/odt 会先提取为文本再逐行匹配，结果仍为 `path:line: content`（行号为提取文本行号）；PDF 命中在 content 前加 `[p.N]` 页码；单个文档失败不中断检索，末尾输出「跳过 N 个文档」汇总（最多列 5 条）；单文档上限 50MB、单次检索文档提取合计预算 20s。**流式按行扫描**：文本文件以 `createReadStream` + `readline` 逐行处理，内存只驻留当前行，GB 级日志不会整读入内存；`crlfDelay: Infinity` 顺带剥离行尾 `\r`，CRLF 文件上的行尾 `$` 锚点不再失配。**二进制嗅探**：前 8000 字节含 NUL 视为二进制直接跳过（与 `fileRead` 同一口径）。**超长行防护**：单行超过 1200 字符（如 minified 文件）时围绕正则命中点截取前后各 500 字符，两端标注省略字符数与总行长，短行原样返回。**匹配硬上限**：达 2000 条即提前停止扫描（`maxResults` 调大时上限跟随放大），避免匹配风暴撑爆上下文，落盘文件如实声明结果不完整并建议收紧正则。匹配数超出 `maxResults` 时完整结果落临时文件并给出路径与分段读取建议 | `pattern`（必填）, `path`（必填）, `ignoreCase`（可选，默认 `false`）, `recursive`（可选，默认 `true`）, `maxResults`（可选，默认 50） |
| 🎯 **Skill 激活** | `activate_skill` | 激活指定 Skill（技能包），返回 SKILL.md 完整指令**及技能所在目录（技能目录 / SKILL.md 绝对路径）**，便于定位技能内附带的脚本、参考文档等文件 | `name`（必填） |
| 🧑‍🤝‍🧑 **子任务委托** | `delegate` | 把自包含子任务交给独立子 Agent 执行，返回其最终结论。子 Agent 拥有独立消息历史、共享 L2/L3 记忆、独立 L1 工作记忆；工具集**排除 `delegate`**防无限递归；不落盘独立会话；取消信号透传。执行器由主 Agent 在 run 内注入（`ToolContext.runSubAgent`），未注入时降级报错。过程可见：WebUI 在卡片内提供「子 Agent 过程」折叠区（默认收起），CLI 结束打印一行摘要、`verbose` 时逐行缩进展开。支持 `background:true` 并行后台执行（立即返回 `sub_<id>`，完成后自动落盘结果卡片；并发上限 `agent.subAgent.maxConcurrent`，默认 3）。完成通知双通道（需求 20261107-011）：主 Agent 仍在运行时于下一轮 LLM 调用前注入通知，已结束时自动发起一轮唤醒 run；结果 >2000 字符时完整落盘 `~/.loop-agent/tmp/<sessionId>/subagent-*.txt`（复用 7 天 TTL 清理），通知只带 400 字符预览 + 路径 + `fileRead` 分段读取建议，落盘失败降级回截断（需求 20261108-001） | `task`（必填，自包含任务描述）, `context`（可选，背景补充）, `background`（可选，`true`=后台并行，缺省同步阻塞） |
| 🖼️ **图片理解** | `analyzeImage` | 把图片交给视觉大模型「看图说话」（需求 20261111-004 起四工具合一）：只给 `image` = 整体描述；给 `question` = 定向问答（界面文字、错误码、颜色、数量）；给 `fields` = 结构化提取并返回 JSON（解析失败降级为原文）。需 `vision.enabled=true` 且模型支持图像；视觉不可用而 OCR 可用时按 `ocr.fallbackFromVision` 降级为本地 OCR 并显式标注「已降级」（`extract` 分支不降级——OCR 产不出结构化字段）。支持本地路径、http(s) URL、`data:` URI | `image`（必填，本地路径 / URL / dataURI，或它们的数组）, `question`（可选，给则走问答）, `fields`（可选，给则走结构化提取） |
| 📝 **文字识别** | `ocrImage` | 用**本机引擎**从图片提取文字（Windows 原生 OCR，离线、不外发、不花 token，需求 20261112-002 / 20261112-003）。适合截图、扫描件、表格图片取字：按词的 `BoundingRect` 做 **y 中心聚类重建视觉行**——引擎会把同一行的「名称」与「修改日期」切成两个 `Line`，重排后两者同行（实测 45 个引擎行 → 23 个视觉行），行内列间距用 ` \| ` 标记（同一词内部的字距过小时直接相连而**不插空格**，因此 `2026/11/12 17:19` 这类被引擎切碎的日期能还原成连续串，而非 `2026 / 1 1 / 1 2`）；`layout=table` 用 **x 投影空白带**聚列输出 markdown 表格（日期内部的空格不会把日期切成多列），`layout=words` 输出词坐标 TSV 供精确几何推理；`scale` / `crop` 在 PowerShell 内用 `BitmapTransform` 预处理（整数放大 + `HighQualityCubic`，不引图像库、不落中间文件）。结果首行固定标注 `[OCR 引擎: … \| 语言: … \| 布局: … \| 行数: … \| 词数: … \| 耗时: …]`（耗时按「识别 + 进程与解码」分段，缓存命中显示 `0s（缓存）`），避免与视觉描述混淆。无坐标引擎（`ocr.http`）在 `layout≠text` 时降级为纯文本并提示当前引擎不提供坐标，不抛错。仅当 `ocr.enabled=true` 且探测到可用引擎时注册（否则工具列表不变，保护前缀缓存） | `image`（必填，本地路径 / `file://` / dataURI；不支持 http(s)）, `lang`（可选，如 `zh-Hans-CN`，缺省取 `ocr.lang`）, `layout`（可选，`text` 默认 / `table` / `words`，缺省取 `ocr.layout`）, `scale`（可选，整数 1–4 放大倍数，默认 1；小字误识时试 2）, `crop`（可选，裁剪区域 `[x,y,w,h]` 原图像素，默认整图）, `maxChars`（可选，本次结果字符上限，缺省取 `ocr.maxChars` 且不超过 `ocr.maxCharsHardLimit`；截断按整行进行并标注丢弃行数） |

> **路径基准**：`commandRun` 省略 `cwd` 时、以及文件类工具（`fileRead` / `fileWrite` / `editFile` / `grep`）的相对路径，均以**会话所属工作空间根**为基准（`ToolContext.workspaceRoot`，越界路径会被拒绝）。MCP server 的工作目录固定为进程启动目录（或配置中的显式值），不随空间切换。

> **描述分层**：工具 `description` 面向模型、随每次请求发送，已按需求 20261111-003 精简（14 个内置工具 `description` + 参数 schema 合计 6316 → 4721 字符，按项目口径「字符数 / 4」估算 1579 → 1180 token，约 -25%）；本页保留完整行为细节供人阅读，两者不一致时以代码为准。

### 工具使用示例

```bash
# 命令执行
commandRun({ "command": "dir", "cwd": "." })

# 后台运行长任务（dev server / watch / 长测试），立即返回 taskId
commandRun({ "command": "npm run dev", "background": true })

# 查询后台任务状态（不带 taskId 返回最近 5 个任务）
commandStatus({ "taskId": "bg_a1b2c3d4_1737500000" })

# 增量读日志（不带参续读增量；tail:true 只看最新 2KB）
commandLogs({ "taskId": "bg_a1b2c3d4_1737500000", "tail": true })

# 终止后台任务（杀整个进程树）
commandStop({ "taskId": "bg_a1b2c3d4_1737500000" })

# 文件读取（全文，默认带行号）
fileRead({ "path": "package.json" })

# 文件读取（部分行，行号为文件真实行号）
fileRead({ "path": "src/agent/react-agent.ts", "startLine": 1, "endLine": 20 })

# 文件读取（关闭行号，返回原始内容，适合读-改-写）
fileRead({ "path": "src/agent/react-agent.ts", "lineNumbers": false })

# 读取 Word 文档（doc/docx 自动提取为文本；行号为提取文本行号）
fileRead({ "path": "docs/需求说明.docx" })

# Word 文档按提取文本行号分段读取
fileRead({ "path": "docs/需求说明.docx", "startLine": 10, "endLine": 30 })

# 读取 PDF（正文带 === 第 N 页 === 页标记与行号）
fileRead({ "path": "docs/manual.pdf" })

# 只读 PDF 第 3-5 页（与 startLine/endLine 互斥）
fileRead({ "path": "docs/manual.pdf", "pages": "3-5" })

# 读取 Excel（按工作表输出）/ PowerPoint（按幻灯片输出）
fileRead({ "path": "reports/summary.xlsx" })
fileRead({ "path": "reports/deck.pptx", "pages": "2" })

# 文件写入（overwrite 为整文件覆盖：content 即覆盖后的完整文件内容，原内容会丢失）
fileWrite({ "path": "output.txt", "content": "Hello World", "mode": "overwrite" })

# 文件写入（append 追加到末尾，保留原内容）
fileWrite({ "path": "output.txt", "content": "\nMore text", "mode": "append" })

# 局部修改已有文件（不要用 fileWrite overwrite，会丢内容）→ 用 editFile
editFile({ "path": "output.txt", "oldText": "Hello World", "newText": "Hello TRAE" })

# 文本替换（字面量匹配；多处匹配时需显式加 replaceAll）
editFile({ "path": "src/config/schema.ts", "oldText": "gpt-4o-mini", "newText": "deepseek-chat" })

# 正则替换（regex=true，支持 flags 与 $1 捕获引用）
editFile({ "path": "src/version.ts", "oldText": "v\\d+\\.\\d+\\.\\d+", "newText": "v2.0.0", "regex": true })

# 行范围整段替换（把第 10-12 行整体替换为 newText；newText 为空串表示删除这些行）
editFile({ "path": "src/a.ts", "startLine": 10, "endLine": 12, "newText": "// TODO" })

# 行范围替换 + oldText 校验（可选，用于防止行号偏移改错位置）
editFile({ "path": "src/a.ts", "startLine": 10, "endLine": 12, "oldText": "function legacy() {", "newText": "function modern() {" })

# 内容检索
grep({ "pattern": "config", "path": "src", "ignoreCase": true, "maxResults": 20 })

# 在 Word/PDF 文档中检索（PDF 命中带 [p.N] 页码；失败文档会在末尾汇总）
grep({ "pattern": "预算", "path": "docs" })

# 大文件 / 日志检索（流式扫描不整读入内存；二进制文件自动跳过；minified 超长行自动截窗）
grep({ "pattern": "ERROR|FATAL", "path": "logs/app.log" })

# Skill 激活（渐进式加载，返回 SKILL.md 完整内容 + 技能目录 / SKILL.md 绝对路径）
activate_skill({ "name": "example-skill" })

# 子任务委托（子 Agent 独立执行，结果作为 observation 返回）
delegate({ "task": "调研本项目的三层记忆实现并输出要点", "context": "项目根目录为当前工作空间" })

# 两个互不相干的任务并行后台执行：立即返回 taskId，主 Agent 继续推理
delegate({ "task": "统计 src/ 下各目录的代码行数", "background": true })
delegate({ "task": "整理 docs/ 中已过期的设计文档清单", "background": true })

# 图片理解（本地路径自动转 base64 data URL，需 vision.enabled = true）
analyzeImage({ "image": "screenshots/login.png" })

# 图片定向问答（支持本地路径或 http(s) URL）
analyzeImage({ "image": "https://example.com/chart.png", "question": "这张图里最高的柱子对应哪个月份？" })

# 结构化提取（返回 JSON 字符串，解析失败自动降级返回原始文本）
analyzeImage({ "image": "invoice.png", "fields": ["标题", "金额", "日期"] })

# 文字识别（本机 OCR，离线；按 y 聚类重建视觉行，名称与日期自然同行）
ocrImage({ "image": "receipt.jpg" })

# 多列表格图：x 投影聚列出 markdown 表格（列数 ≥2 且行数 ≥3，否则自动回落 text 并提示）
ocrImage({ "image": "screenshots/files.png", "layout": "table" })

# 词级坐标（TSV: x\ty\tw\th\ttext），供「第 3 行第 2 列是什么」这类精确几何推理
ocrImage({ "image": "screenshots/files.png", "layout": "words" })

# 小字误识：整数放大 2 倍（实测把「调厍方案」修回「调用方案」；放大收益非单调，3 倍可能反而劣化）
ocrImage({ "image": "plan.png", "scale": 2 })

# 小区域辨认的最有效组合：先裁（原图像素 [x,y,w,h]）再放大
ocrImage({ "image": "plan.png", "crop": [120, 340, 480, 60], "scale": 3 })
```

> **原先靠手写脚本的两件事，现在都是参数**（20261112-003 固化）：曾需要 `temp/` 里的「整图放大」脚本先把图片放大 2–3 倍再 OCR，现在传 `scale` 即可（引擎在 PowerShell 内用 `BitmapTransform` + `HighQualityCubic` 完成，不落中间文件、不引图像库）；曾需要「裁剪小区域」脚本先把感兴趣的一列/一行切出来，现在传 `crop`。放大后若超过引擎 `MaxImageDimension`，工具会明确报 `image_too_large` 并提示降 `scale` 或加 `crop`，不会静默失败。
