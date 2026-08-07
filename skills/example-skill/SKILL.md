---
name: example-skill
description: 示例技能包，演示 Skill 的创建和使用方式
---

# 示例 Skill

这是一个演示 Skill，用于说明如何创建和使用 Skill 能力。

## 使用场景

当用户询问"如何创建 Skill"时，可以激活此 Skill 获取详细说明。

## 执行步骤

1. 在工作空间 `skills/` 目录下创建文件夹
2. 在文件夹内创建 `SKILL.md` 文件
3. 文件顶部必须包含 YAML frontmatter，格式如下：

```
---
name: your-skill-name
description: Skill 的简短描述，LLM 据此判断何时使用
---
```

4. frontmatter 之后的内容为 Skill 的正文，会在激活时完整返回给 Agent

## 注意事项

- name 必须唯一，不能与其他 Skill 重名
- description 要简洁明确，便于 LLM 匹配
- 全局 Skill 存放于 `~/.loop-agent/skills/` 目录
- 工作空间 Skill 存放于 `<项目根目录>/skills/` 目录
