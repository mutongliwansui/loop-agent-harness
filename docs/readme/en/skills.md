# 🎯 Skills

> [⬅ Back to README](../../../README.md)

A Skill is a set of **reusable instructions** for a specific domain task, using the `SKILL.md` standard format (YAML frontmatter + Markdown body). Based on user intent, the agent **progressively loads** a Skill's full instructions to handle complex domain tasks.

### Skill Directory Structure

```
~/.loop-agent/skills/           # Global Skills (available to all projects)
└── example-skill/
    └── SKILL.md

<workspace>/.loop-agent/skills/   # Workspace Skills (only for the current project; higher priority)
└── my-skill/
    ├── SKILL.md
    ├── scripts/                # Optional: executable scripts
    ├── references/             # Optional: reference docs
    └── assets/                 # Optional: templates/resources
```

### SKILL.md Format Spec

```markdown
---
name: example-skill
description: An example skill demonstrating how to create and use a Skill
---

# Example Skill

## When to use this skill
...

## How to ...
1. ...
```

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique Skill identifier, used for LLM matching and `activate_skill` calls |
| `description` | ✅ | A short description the LLM uses to decide when to use the Skill |

> **Priority**: When a Skill of the same name exists in both locations, the workspace version overrides the global one.

### Workflow

1. **On startup**: Automatically scan global + workspace Skills; inject metadata (name + description) into the System Prompt; **if there are no skills at all, the System Prompt explicitly states "no skills are currently available" to prevent the model from mistakenly searching the file system**
2. **At runtime**: The LLM decides a user intent matches a Skill → calls the `activate_skill` tool
3. **After loading**: The tool returns the full SKILL.md content **along with the skill's directory**; the agent continues reasoning from there. If the skill references internal scripts/docs, it can concatenate paths using that directory before reading
4. **Manual management**: View and refresh via the `/skill` command

> **Multiple workspaces (serve mode)**: the server scans skills from **each workspace root** separately, and each workspace holds its own skill loader instance so they never overwrite each other; `scan(root)` yields the same result for a given directory as the CLI's `scan(process.cwd())`.

### Programmatic Activation

```typescript
import { skillLoader } from './src/skill/index.js';

// Scan (global + workspace)
const skills = skillLoader.scan(process.cwd());

// Progressively load the full content
const content = skillLoader.load('example-skill');
console.log(content?.fullContent);
```
