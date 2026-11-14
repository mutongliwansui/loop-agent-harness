# task-20261015-002：Skill 删除（/skill remove）

对应需求编号：20261015-002

## 一、任务目标需求

### 1.1 背景

`/skill upload` 已上线，但卸载仍需用户手动找到深层目录（`~/.loop-agent/skills` 或 `<cwd>/.loop-agent/skills`）再执行删除，形成「装得上删不掉」的交互断点。用户提出增加 `/skill remove` 命令闭环安装/卸载流程。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
|---|---|---|
| Skill 列表与元数据（name / scope / dir） | [loader.ts](file:///d:/trae_workspace/loop-agent-command/src/skill/loader.ts#L50-L54) `list()` → `SkillMetadata[]`，含 `dir` 绝对路径 | 复用，无需改动 |
| 按名定位（同名两作用域） | `list()` 包含 scope，可过滤 | 命令层决定取哪个 scope |
| 递归删除目录 | `node:fs/promises` `rm(dir, { recursive: true, force: true })` | 内置，零新依赖 |
| y/N 确认交互 | 同 upload 覆盖确认、/upload clean 同款 | 复用临时 readline |
| Tab 动态参数补全 | [index.ts](file:///d:/trae_workspace/loop-agent-command/src/index.ts#L226-L228) 已有 `/skill show` 补全 skill 名 | 复用 provider 条件 |
| 护栏（路径穿越防护） | 无现成实现 | 新增：dirname 校验 |

### 1.3 任务目标

新增 `/skill remove` 命令：
- 按 frontmatter `name` 删除已安装 Skill 目录（支持批量，单项失败不阻断）。
- 作用域默认工作空间优先（`auto`），`--global` / `--workspace` 严格限定单一作用域。
- 删除前校验目标目录为对应 skills 根的直接子目录（防路径穿越）。
- 逐个 y/N 确认（默认 N），无 `--yes`。
- 删完自动 reload，`/skill list` 立即不可见。
- `/skill remove <Tab>` 动态补全可删 skill 名。

### 1.4 设计约束

- **零新依赖**：仅使用 `node:fs/promises rm`（Node 16+，项目 engines ≥ 20.10）。
- **复用最大化**：flag 剥离同 upload；确认交互同 upload 覆盖；provider 复用 show。
- **防删除**：护栏拒绝任何非 skills 根直接子目录的目标。

## 二、方案设计

### 2.1 总体思路

```
用户输入 /skill remove <name...> [--global|--workspace]
         │
         ▼
      [命令层] 剥离 flag，拆分 name 数组，构造临时 readline 确认器
         │
         ▼
      [纯逻辑 removeSkills]
         ├─ 按 name 在 SkillMetadata[] 中匹配（auto=工作空间优先） D2
         ├─ 护栏：dirname(resolve(dir)) === resolve(root)            D5
         ├─ y/N 确认（默认 N）                                        D3
         └─ rm -rf → removed / failed
         │
         ▼
      [命令层] 渲染清单 + skillLoader.reload()
```

### 2.2 关键设计决策

- **D1 按 frontmatter name 定位，不做目录名兜底**：Skill 用户可见标识始终是 frontmatter `name`（`/skill show` 亦按 name）。拒绝「目录名不同也可删」的歧义行为。被否决项：目录名兜底、basename 模糊匹配。
- **D2 作用域消歧：auto 工作空间优先，--global/--workspace 严格限定**：
  - `auto`（默认无 flag）：先在工作空间列表中找同名，有则删工作空间；无则删全局；都不存在 → 未找到。
  - `--global`：仅在全局列表中找；找不到 → 未找到（不 fallback 工作空间）。
  - `--workspace`：仅在工作空间列表中找。
  与 upload 默认安装到工作空间对齐。被否决项：默认两作用域都删、优先全局。
- **D3 逐个 y/N 确认（默认 N），无 `--yes` 跳过 flag**：删除是高风险操作，必须逐一手动确认。与 upload 覆盖确认、/upload clean 确认风格一致，不引入 `--yes`。被否决项：批处理静默删、`-y` flag。
- **D4 无参报错提示用法**：删除是精确操作，不提供弹框/交互选择。被否决项：无参弹列表让用户选。
- **D5 护栏：resolve(dir) 必须是 skills 根的直接子目录**：`dirname(resolve(dir)) === resolve(root)`。防御目标：防止 name 被篡改（如元数据注入）后删除非预期目录。被否决项：仅检查 dir 是否以 root 开头（宽松）、不做护栏。
- **D6 删完自动 reload**：与 upload 装完 reload 一致，保证 `/skill list` 立即反映最新状态。
- **D7 Tab 补全复用 `/skill show` 的 provider**：在 `index.ts` 的 `ArgCompletionProvider` 中将 `/skill show` 条件扩展为 `subcommand === 'show' || subcommand === 'remove'`，无需额外实现。

## 三、任务详细设计

### 3.1 installer.ts 新增 `removeSkills`

```ts
export interface SkillRemoveEntry {
  name: string;
  dir: string;
  scope: SkillScope;
}

export interface SkillRemoveResult {
  removed: SkillRemoveEntry[];
  failed: { name: string; reason: string }[];
}

export async function removeSkills(
  names: string[],
  opts: {
    skills: SkillMetadata[];
    scope: 'auto' | 'global' | 'workspace';
    globalDir: string;
    workspaceDir: string;
    confirm: (name: string, dir: string, scope: SkillScope) => Promise<boolean>;
  },
): Promise<SkillRemoveResult>
```

**行为：**
1. `opts.skills` 按 `opts.scope` 过滤（`auto` 时不过滤，由匹配逻辑决定）。
2. 对每个 name：
   - 若 `scope === 'auto'`：先在工作空间找同名，有则取工作空间；无则在全局找。
   - 若 `scope === 'global'`：仅在全局找。
   - 若 `scope === 'workspace'`：仅在工作空间找。
   - 未找到 → `failed.push({ name, reason: '未找到已安装的 Skill' })`；继续下一个。
3. 护栏：令 `abs = resolve(skill.dir)`，`root = resolve(对应作用域根)`。若 `dirname(abs) !== root`，则 `failed.push({ name, reason: '目标路径异常，拒绝删除' })`；继续下一个。
4. 调用 `opts.confirm(name, abs, skill.scope)`。返回 false → `failed.push({ name, reason: '已跳过' })`。
5. 确认 → `await rm(abs, { recursive: true, force: true })` → `removed.push(...)`。
6. 返回 `{ removed, failed }`。

### 3.2 skill-command.ts 修改

- `description` → `'Skill 管理（list/reload/show/upload/remove）'`
- `subcommands` → `['list', 'reload', 'show', 'upload', 'remove']`
- execute() 的 `upload` 分支之后、未知子命令报错之前，插入：
  ```ts
  if (sub === 'remove') {
    const names = removeArgNames(input);
    if (names.length === 0) {
      out.log(`${COLORS.red}用法: /skill remove <name...> [--global|--workspace]${COLORS.reset}`);
      out.blank();
      return;
    }
    const scopeRaw = removeScope(input);
    // 确认交互同上 upload 覆盖，临时 readline
    // 调用 removeSkills(...)
    // 渲染 ✓/✗
    // skillLoader.reload()
    return;
  }
  ```
- 报错文案 → `'支持 list / reload / show / upload / remove'`

### 3.3 index.ts ArgCompletionProvider

将 `command === '/skill' && subcommand === 'show'` 条件扩展为：
```ts
if (command === '/skill' && (subcommand === 'show' || subcommand === 'remove')) { ... }
```

### 3.4 skill/index.ts

新增：
```ts
export { validateSkillDir, installSkillDirs, pickDirectoryViaDialog, removeSkills } from './installer.js';
export type { SkillInstallEntry, SkillInstallResult, ValidateResult, SkillRemoveEntry, SkillRemoveResult } from './installer.js';
```

### 3.5 边界与错误处理

| 场景 | 行为 |
|---|---|
| 无参调用 | 报错提示用法（D4） |
| name 不存在 | 红色 ✗「未找到已安装的 Skill」 |
| 同名两作用域 | auto 删工作空间（D2） |
| 目标路径异常（护栏触发） | 红色 ✗「目标路径异常，拒绝删除」 |
| 用户按 N 或回车 | 红色 ✗「已跳过」 |
| 删除 IO 失败 | 红色 ✗ 抛出 Error message |
| 批量 | 逐 name 处理，失败不阻断其余 |

## 四、实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| P0 | installer.removeSkills + skill-command remove 分支 + index.ts provider + reload + renderer.ts /help | 代码 |
| P1 | 单测（removeSkills 定位/护栏/确认/批量/作用域语义）+ 无参用法 + typecheck + 全量回归 | 测试全绿 |
| P2 | README 双语命令表与 /skill 详解、需求台账收口、任务文档打勾 | 文档 |

## 五、文件清单

| 文件 | 改动 | 阶段 |
|---|---|---|
| src/skill/installer.ts | 新增 removeSkills + SkillRemoveEntry + SkillRemoveResult | P0 |
| src/commands/skill-command.ts | description/subcommands/execute remove 分支/报错文案 | P0 |
| src/index.ts | provider 条件扩增 remove | P0 |
| src/skill/index.ts | 导出 removeSkills 与类型 | P0 |
| tests/skill-installer.test.ts | 追加 removeSkills 用例（定位/护栏/确认/批量/作用域消歧） | P1 |
| src/ui/renderer.ts | /help 描述行更新 | P2 |
| README.md / README.en.md | 命令表 + /skill 详解 | P2 |
| docs/requirements/需求.md | 收口置完成 | P2 |
| docs/tasks/本文件 | 验收清单打勾 + 完成记录 | P2 |

## 六、任务验收清单

- [x] 6.1 `/skill remove <name>` 删除工作空间 skill，`/skill list` 立即消失（D6 自动 reload；单测覆盖删除路径）
- [x] 6.2 同名两处：默认删工作空间；`--global` 删全局；`--workspace` 对称（单测：auto 优先 ws / --global 只删 gl / --workspace 不 fallback）
- [x] 6.3 只存在全局时无 flag 直接删全局（单测：auto 仅全局 fallback）
- [x] 6.4 批量删除，单项失败（未找到）不阻断（单测：a/ghost/b 三参）
- [x] 6.5 y/N 确认：y 删除、N 跳过（默认 N）（单测：confirmNo → 已跳过、目录保留）
- [x] 6.6 无参报错提示用法（D4，runSkillRemove 分支 names.length === 0）
- [x] 6.7 护栏：dir 非 skills 根直接子目录拒绝（防路径穿越）（单测：nested/evil → 目标路径异常）
- [x] 6.8 Tab 补全 `/skill remove <前缀>` 出 skill 名（index.ts provider 条件扩展为 show || remove）
- [x] 6.9 单测全绿 + `npx tsc --noEmit` + 全量回归（installer 28 用例；全量 466 用例）
- [x] 6.10 /help、README 双语同步
- [ ] 6.11 人工验证（真实环境）：安装一个 skill 再用 remove 删除

### 完成记录

- 2026-10-15 P0：installer.ts 追加 removeSkills + SkillRemoveEntry/SkillRemoveResult；skill-command.ts 新增 runSkillRemove 分支（flag 剥离/无参报错/逐项确认/reload），description/subcommands/报错文案同步；index.ts provider 条件扩展 remove；skill/index.ts 导出。
- 2026-10-15 P1：tests/skill-installer.test.ts 追加 removeSkills 11 个用例（空数组/auto 三态/--global/--workspace/未找到/护栏/确认 N/批量不阻断/D1 按 frontmatter name 定位）；`npx tsc --noEmit` 通过；全量回归 466 用例全绿。
- 2026-10-15 P2：renderer.ts /help 行更新；README.md / README.en.md 命令表、/skill 详解、Tab 补全说明同步；需求台账置完成。
- 2026-10-15 Bugfix：修复「执行 /skill remove 后进程退出」——根因是临时 readline 与主 REPL 共享 process.stdin，close() 会 pause 共享流导致主 REPL 永久失聪、TTY 下进程退出。修复：废弃全部临时 readline，在 index.ts 用主 rl.question 实现统一 askConfirm 并加入 confirming 守卫防止答案行被主循环重复消费；同步替换 skill-command（upload overwrite + remove）、session-command（delete-all）、upload-command（clean）共 4 处。类型检查 + 全量 466 用例回归全绿。
