# 🔧 内置工具

> [⬅ 返回 README](../../../README.md)

| 工具 | 名称 | 说明 | 参数 |
|---|---|---|---|
| 🖥️ **命令执行** | `commandRun` | 在本地执行 shell 命令，返回 stdout + stderr | `command`（必填）, `cwd`（可选）, `timeout`（可选，默认 30000ms） |
| 📄 **文件读取** | `fileRead` | 读取文件内容，支持按行范围部分读取，默认每行带 `行号: ` 前缀 | `path`（必填）, `startLine`（可选）, `endLine`（可选）, `encoding`（可选）, `lineNumbers`（可选，默认 `true`） |
| ✏️ **文件写入** | `fileWrite` | **整文件写入**：`overwrite` 用 `content` 完整替换文件全部内容（**原内容会永久丢失，不支持区域/局部覆盖**，局部修改请用 `editFile`）；`append` 追加到末尾，自动创建父目录 | `path`（必填）, `content`（必填，overwrite 时为覆盖后的完整文件内容）, `mode`（可选，`overwrite` / `append`） |
| 🔁 **文件编辑** | `editFile` | 三种模式：①字面量替换（要求唯一出现，多处匹配报错以防误改）；②`regex=true` 正则替换（支持 `$1`/`$&` 捕获引用）；③指定 `startLine`/`endLine` 整段行替换 | `path`（必填）, `newText`（必填）, `oldText`（未指定行范围时必填）, `startLine`（可选）, `endLine`（可选）, `replaceAll`（可选，默认 `false`）, `regex`（可选，默认 `false`）, `flags`（可选，如 `i`/`m`/`s`） |
| 🔍 **内容检索** | `grep` | 在文件或目录中检索内容，支持正则、忽略大小写、递归搜索 | `pattern`（必填）, `path`（必填）, `ignoreCase`（可选）, `recursive`（可选）, `maxResults`（可选，默认 50） |
| 🎯 **Skill 激活** | `activate_skill` | 激活指定 Skill（技能包），返回 SKILL.md 完整指令**及技能所在目录（技能目录 / SKILL.md 绝对路径）**，便于定位技能内附带的脚本、参考文档等文件 | `name`（必填） |
| 👁️ **图片描述** | `describe_image` | 对图片做整体描述（主体、场景、可见文字、颜色、数量等）；不确定该问什么时先用它获取全局信息 | `image`（必填，本地路径或 http(s) URL） |
| ❓ **图片问答** | `ask_image` | 针对图片回答一个具体问题（界面文字、错误码、按钮状态、颜色、数量等），比 `describe_image` 更精准、输出更短 | `image`（必填）, `question`（必填） |
| 🧾 **结构化提取** | `extract_json` | 按字段列表从图片提取结构化数据并返回 JSON（表单 / 表格 / 配置界面等场景）；解析失败自动降级返回原始文本 | `image`（必填）, `fields`（必填，字段名数组） |
| 📝 **文字识别** | `ocr_image` | 识别图片中全部文字（OCR），保持原始阅读顺序与换行输出 | `image`（必填） |

### 工具使用示例

```bash
# 命令执行
commandRun({ "command": "dir", "cwd": "." })

# 文件读取（全文，默认带行号）
fileRead({ "path": "package.json" })

# 文件读取（部分行，行号为文件真实行号）
fileRead({ "path": "src/agent/react-agent.ts", "startLine": 1, "endLine": 20 })

# 文件读取（关闭行号，返回原始内容，适合读-改-写）
fileRead({ "path": "src/agent/react-agent.ts", "lineNumbers": false })

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

# Skill 激活（渐进式加载，返回 SKILL.md 完整内容 + 技能目录 / SKILL.md 绝对路径）
activate_skill({ "name": "example-skill" })

# 图片描述（本地路径自动转 base64 data URL，需 vision.enabled = true）
describe_image({ "image": "screenshots/login.png" })

# 图片问答（支持本地路径或 http(s) URL）
ask_image({ "image": "https://example.com/chart.png", "question": "这张图里最高的柱子对应哪个月份？" })

# 结构化提取（返回 JSON 字符串，解析失败自动降级返回原始文本）
extract_json({ "image": "invoice.png", "fields": ["标题", "金额", "日期"] })

# 文字识别（OCR，保持原始阅读顺序与换行）
ocr_image({ "image": "receipt.jpg" })
```
