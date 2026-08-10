# SlideP — Python PPT 生成生态（Skill 形态）

基于 Python 技术栈的 PPT 生成引擎，最终交付形态为可被 AI Agent 安装调用的 **Skill 包**：
声明式 DSL → Flexbox 布局 → OOXML 渲染 → 设计规范 lint 门禁 → 实时预览。

## 目录结构

```
py-pptx/
├── SKILL.md               # Skill 入口（T5.2 完善）
├── references/            # 方法论文档（story/design/component-*，T0.2）
├── scripts/
│   └── slidep/            # 核心引擎包
│       ├── errors.py      # 统一错误码体系（T0.1 ✅）
│       ├── logging_setup.py  # 结构化 JSON 日志（T0.1 ✅）
│       ├── dsl/           # 组件模型（T1.1）
│       ├── layout/        # Flexbox 布局引擎（T1.2）
│       ├── render/        # OOXML 渲染器（T1.3）
│       ├── components/    # 组件库（T2.x）
│       ├── validate/      # 设计规范 lint（T3.1）
│       └── cli/           # typer CLI（T0.1 ✅ 骨架）
├── tests/                 # pytest 测试
├── docs/                  # 架构文档
└── examples/              # 示例项目
```

## 开发

```bash
# 安装（含开发依赖，联网自动解析下载）
pip install -e ".[dev]"

# 跑测试
pytest

# CLI 验证
slidep --help
slidep version
```

## 安装（目标服务器）

```bash
# 联网环境直接安装，pip 自动解析并下载全部依赖
pip install .
# 可选组件：pip install ".[optional]"（matplotlib，FAIcon/SVG/CodeBlock/Math 的 PNG 渲染）
```
