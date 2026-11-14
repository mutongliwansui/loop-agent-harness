# Task-20261015-001：Skill 上传（/skill upload）

> 对应需求编号：20261015-001（[需求台账](../../requirements/需求.md)）
> 参考实现：[upload-command.ts](file:///d:/trae_workspace/loop-agent-command/src/commands/upload-command.ts) / [manager.ts](file:///d:/trae_workspace/loop-agent-command/src/upload/manager.ts)（Task-20261012-001）

## 一、任务目标需求

### 1.1 背景（痛点）

安装 skill 需用户手动找到深层目录（`~/.loop-agent/skills` 或 `<cwd>/.loop-agent/skills`）再复制目录，门槛高、路径深、易放错位置；希望像 `/upload` 一样一条命令完成安装。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
| --- | --- | --- |
| skill 扫描/加载 | [scanner.ts](file:///d:/trae_workspace/loop-agent-command/src/skill/scanner.ts) `scanSkillsDir`/`parseSkillMd`（校验 frontmatter name/description）、[loader.ts](file:///d:/trae_workspace/loop-agent-command/src/skill/loader.ts) `reload(cwd)` | 直接复用 |
| 作用域目录约定 | 全局 `~/.loop-agent/skills`（`skillLoader.globalDir`）、工作空间 `<cwd>/.loop-agent/skills`（`getWorkspaceDir`） | 直接复用 |
| 路径参数跨平台归一 | [manager.ts](file:///d:/trae_workspace/loop-agent-command/src/upload/manager.ts) `parseUploadArgs`（引号/file:// URI/转义） | 直接复用 |
| 系统弹框探测链 | `pickFilesViaDialog`（文件选择框；内部 `runDialogCommand`/`hasCommand` 为私有） | 需导出私有件，新增目录选择框变体 |
| /skill 命令骨架 | [skill-command.ts](file:///d:/trae_workspace/loop-agent-command/src/commands/skill-command.ts)（list/reload/show，subcommands 参与二级 Tab 补全） | 加 upload 子命令 |
| /help 说明 | [renderer.ts](file:///d:/trae_workspace/loop-agent-command/src/ui/renderer.ts) L85 `/skill → Skill 管理（list/reload/show）` | 更新描述 |

### 1.3 任务目标

`/skill upload` 把本地 skill 目录装入指定作用域：路径参数（拖拽/手输，跨平台归一）或无参弹系统目录选择框 → 校验 → 复制到目标 skills 目录 → 同名冲突询问覆盖 → 自动 reload 立即可用；输出成功清单与失败原因，单项失败不阻断其余。

### 1.4 设计约束

- 零新 npm 依赖（沿用 `node:` 内置模块 + 平台命令探测链）
- 跨平台（Windows/macOS/Linux）：路径归一与目录选择框三平台可用，无框环境降级提示用法
- 单项失败不阻断批量；校验失败拒绝并说明原因

## 二、方案设计

### 2.1 总体思路

```
/skill upload [目录...] [--global|--workspace]
        │                              │
        ├─ 无路径 → 目录选择框（D3 探测链）│ 作用域解析（D2，默认 workspace）
        ▼                              ▼
  parseUploadArgs 归一（复用）   targetRoot = 全局/工作空间 skills 目录
        │                              │
        └────────► installer.installSkillDirs(paths, { targetRoot, confirmOverwrite })
                        │  per dir: validateSkillDir（D4）→ 同名? confirmOverwrite（D5）→ 复制
                        ▼
                   skillLoader.reload(cwd)（D6）→ 渲染成功/失败清单
```

### 2.2 关键设计决策

- **D1 输入形态仅本地目录**：不支持 zip/SKILL.md 单文件/远程 URL（非目标；zip 解压需跨平台探测链，留作演进项）。
- **D2 作用域默认工作空间**：`--global` 切全局、`--workspace` 显式等价默认；参数可出现在路径前或后（先剥离 flag 再归一路径）。被否决项：每次交互询问（打断心流）；默认全局（污染所有项目）。
- **D3 无参弹系统目录选择框（单选）**：win `FolderBrowserDialog` / macOS `osascript choose folder` / Linux `zenity --file-selection --directory → kdialog --getexistingdirectory → yad --file --directory` 探测链；全部不可用 → 提示用法不报错。多目录走路径参数，弹框仅单选。
- **D4 校验强度（拒绝即说明原因）**：必须是目录、含 `SKILL.md`、`parseSkillMd` 可解析出合法 name/description——与 scanner 扫描条件完全对齐，避免「装完扫不出」。
- **D5 同名冲突 y/N 询问后覆盖**：目标已存在同名目录时交互确认（复用 /upload clean 的临时 readline 模式）；确认 = 先删目标再整体复制；拒绝 = 该项跳过记 failed。非交互场景（测试）通过注入 `confirmOverwrite` 回调控制。
- **D6 装完自动 reload**：成功后 `skillLoader.reload(process.cwd())`，`/skill list` 立即可见；提示语注明作用域目录。
- **D7 目标目录名 = 源目录 basename**：不做改名；frontmatter name 与目录名不一致时仍以 name 为 skill 标识（scanner 现有行为），不额外干预。
- **D8 复用上传承载件**：从 manager.ts 导出 `hasCommand`/`runDialogCommand`（现私有，纯导出行为不变）供 installer 复用；复制用 `fs.cp`（`node:fs/promises`，recursive）而非逐文件。

### 2.3 联网检索结论

参考 Claude Code 插件体系（本地目录装入受管目录、reload 生效、作用域 user/project 二级），与本设计一致；无额外可借鉴坑。

## 三、任务详细设计

### 3.1 `src/skill/installer.ts`（新增，纯逻辑）

```ts
export interface SkillInstallEntry { sourcePath: string; targetDir: string; name: string; description: string; }
export interface SkillInstallResult {
  installed: SkillInstallEntry[];
  failed: { path: string; reason: string }[];
}
/** 校验 skill 目录：是目录 + 含 SKILL.md + frontmatter 合法（D4） */
export function validateSkillDir(dir: string): { ok: true; name: string; description: string } | { ok: false; reason: string };
/** 批量安装：校验 → 冲突 confirmOverwrite（D5）→ fs.cp 复制（D8）；单项失败不阻断 */
export async function installSkillDirs(
  paths: string[],
  opts: { targetRoot: string; confirmOverwrite: (name: string, targetDir: string) => Promise<boolean> },
): Promise<SkillInstallResult>;
/** 系统目录选择框（D3 探测链，单选）：取消/不可用不抛错，reason 区分 */
export async function pickDirectoryViaDialog(): Promise<DialogPickResult>;
```

| 边界/错误 | 处理 |
| --- | --- |
| 路径不存在 | failed「目录不存在」 |
| 路径是文件 | failed「仅支持目录」 |
| 缺 SKILL.md / frontmatter 非法 | failed 带具体原因（D4） |
| 同名 + 拒绝覆盖 | failed「已存在同名目录，已跳过」 |
| 复制异常（权限等） | failed 带原始 message |
| 弹框不可用 | 命令层提示用法（不报错） |

### 3.2 `src/skill` 命令扩展（skill-command.ts）

- subcommands 加 `upload`（二级 Tab 补全自动生效）。
- 解析：剥离 `--global`/`--workspace` flag（位置无关）→ 剩余文本 `parseUploadArgs` 归一为目录数组；无路径且无 flag → 目录选择框；仅有 flag 无路径 → 同样弹框（作用域按 flag）。
- 冲突确认：临时 readline `question`（与 /upload clean 同款），回调注入 installer。
- 渲染：成功项「✓ name → targetDir（作用域）」，失败项「✗ path：原因」；成功≥1 时自动 reload 并提示可见性。

### 3.3 manager.ts 小重构

`hasCommand`、`runDialogCommand` 加 `export`（行为不变），供 installer 的目录选择框复用。

### 3.4 演进项（本任务不做）

zip 压缩包安装、远程 URL/Git 安装、`/skill remove`、skill 版本管理。

## 四、实施计划

| 阶段 | 内容 | 交付物 |
| --- | --- | --- |
| P0 | installer 校验+复制+覆盖回调；/skill upload 路径链路；自动 reload；单测 | installer.ts + skill-command.ts + 测试 |
| P1 | 无参目录选择框三平台探测链；冲突交互确认接 readline；多目录批量 | installer 弹框 + 命令层交互 |
| P2 | /help 描述、README 双语、台账收口 | renderer.ts / README* / 需求.md |

## 五、文件清单

| 文件 | 改动 | 阶段 |
| --- | --- | --- |
| src/skill/installer.ts | 新增 | P0/P1 |
| src/commands/skill-command.ts | 加 upload 子命令 | P0/P1 |
| src/upload/manager.ts | 导出 hasCommand/runDialogCommand | P0 |
| src/skill/index.ts | 视情况导出 installer 类型 | P0 |
| tests/skill-installer.test.ts | 新增（校验/复制/覆盖/批量/弹框 mock） | P0/P1 |
| src/ui/renderer.ts | /help 描述行 | P2 |
| README.md / README.en.md | 命令表 + 详解 | P2 |
| docs/requirements/需求.md | 收口置完成 | P2 |

## 六、任务验收清单

- [x] 6.1 `/skill upload <目录>` 安装到工作空间 skills 目录，`/skill list` 立即可见
- [x] 6.2 `--global` 安装到全局目录；`--workspace` 等价默认
- [x] 6.3 无参弹目录选择框；无框环境提示用法不报错
- [x] 6.4 缺 SKILL.md / frontmatter 非法 → 拒绝并说明原因
- [x] 6.5 同名冲突询问；y 覆盖、N 跳过
- [x] 6.6 多目录批量，单项失败不阻断
- [x] 6.7 路径含空格/引号/file:// URI 归一正确（复用 parseUploadArgs 既有行为）
- [x] 6.8 单测全绿 + `npx tsc --noEmit` + 全量回归
- [x] 6.9 /help、Tab 补全、README 双语同步
- [ ] 6.10 人工验证（真实环境）：三平台目录选择框各跑一次；拖拽目录到终端安装

### 完成记录

- 2026-10-15 P0/P1 实施完成：`src/skill/installer.ts` 新增（validateSkillDir / installSkillDirs / pickDirectoryViaDialog）；`src/commands/skill-command.ts` 新增 upload 子命令（flag 剥离、弹框、y/N 冲突确认、装完自动 reload）；`src/upload/manager.ts` 导出 hasCommand/runDialogCommand（行为不变）；`src/skill/index.ts` 导出 installer 能力。
- 2026-10-15 测试与回归：新增 `tests/skill-installer.test.ts` 17 个用例（校验 5 + 安装/护栏/冲突/批量 7 + 弹框平台探测链 5）；`npx tsc --noEmit` 通过；全量回归 455/455 全绿。
- 2026-10-15 P2 文档同步：`/help` 使用说明行、README 双语命令表与 `/skill` 详解已更新；Tab 二级补全经 `subcommands` 自动生效。
- 实施偏差说明：作用域 flag 解析由「replace 回调副作用」改为「先 regex test 判定 scope 再清洗文本」，规避 TS 对闭包捕获变量的窄化误报（TS2367），行为等价。
