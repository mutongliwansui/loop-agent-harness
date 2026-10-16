# 🎯 Skill 技能包

> [⬅ 返回 README](../../../README.md)

Skill（技能包）是一组针对特定领域任务的**可复用指令集**，采用 `SKILL.md` 标准格式（YAML frontmatter + Markdown 正文）。Agent 根据用户意图**渐进式加载** Skill 的完整指令，用于处理复杂领域任务。

### Skill 目录结构

```
~/.loop-agent/skills/           # 全局 Skill（所有项目可用）
└── example-skill/
    └── SKILL.md

<workspace>/.loop-agent/skills/   # 工作空间 Skill（仅当前项目可用，优先级更高）
└── my-skill/
    ├── SKILL.md
    ├── scripts/                # 可选：可执行脚本
    ├── references/             # 可选：参考文档
    └── assets/                 # 可选：模板/资源
```

### SKILL.md 格式规范

```markdown
---
name: example-skill
description: 示例技能包，演示 Skill 的创建和使用方式
---

# Example Skill

## When to use this skill
...

## How to ...
1. ...
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | Skill 唯一标识，用于 LLM 匹配与 `activate_skill` 调用 |
| `description` | ✅ | 简短描述，LLM 据此判断何时使用该 Skill |

> **优先级**：同名 Skill 同时存在时，工作空间版本覆盖全局版本。

### 工作流程

1. **启动时**：自动扫描全局 + 工作空间 Skill，元信息（name + description）注入 System Prompt；**若没有任何技能，System Prompt 也会显式声明"当前没有可用的技能"，避免模型误去检索文件系统**
2. **运行时**：LLM 判断用户意图匹配某个 Skill → 调用 `activate_skill` 工具
3. **加载后**：工具返回 SKILL.md 完整内容**及技能所在目录**，Agent 据此继续推理执行；若技能引用了内部脚本/文档，可用该目录拼接路径后再读取
4. **手动管理**：可通过 `/skill` 命令查看、刷新

### 编程式激活

```typescript
import { skillLoader } from './src/skill/index.js';

// 扫描（全局 + 工作空间）
const skills = skillLoader.scan(process.cwd());

// 渐进式加载完整内容
const content = skillLoader.load('example-skill');
console.log(content?.fullContent);
```
