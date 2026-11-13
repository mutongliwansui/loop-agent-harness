# 🎯 Skill 技能包

> [⬅ 返回 README](../../../README.md)

Skill（技能包）是一组针对特定领域任务的**可复用指令集**，采用 `SKILL.md` 标准格式（YAML frontmatter + Markdown 正文）。Agent 根据用户意图**渐进式加载** Skill 的完整指令，用于处理复杂领域任务。

### Skill 目录结构

```
~/.loop-agent/skills/           # 唯一 Skill 目录（所有项目共用，需求 20261112-008 后工作空间目录不再扫描）
└── example-skill/
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

> **单一目录**：Skill 目录已收敛为全局唯一（`~/.loop-agent/skills/`），不再存在「工作空间版本覆盖全局版本」的优先级规则。

### 工作流程

1. **启动时**：自动扫描全局 Skill，元信息（name + description）注入 System Prompt；**若没有任何技能，System Prompt 也会显式声明"当前没有可用的技能"，避免模型误去检索文件系统**
2. **运行时**：LLM 判断用户意图匹配某个 Skill → 调用 `activate_skill` 工具
3. **加载后**：工具返回 SKILL.md 完整内容**及技能所在目录**，Agent 据此继续推理执行；若技能引用了内部脚本/文档，可用该目录拼接路径后再读取
4. **手动管理**：可通过 `/skill` 命令查看、刷新

> **多工作空间（serve 模式）**：Skill 加载器为进程级单例，所有空间共用同一个全局 Skills 目录与扫描结果，不再按空间根分别扫描。

### 编程式激活

```typescript
import { skillLoader } from './src/skill/index.js';

// 扫描（全局唯一目录）
const skills = skillLoader.scan(process.cwd());

// 渐进式加载完整内容
const content = skillLoader.load('example-skill');
console.log(content?.fullContent);
```
