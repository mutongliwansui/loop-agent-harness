# 任务 02：REST 与 CLI 的 scope 语义收敛 + skill 全局化

- 所属需求编号：**20261112-008**
- 所属批次：[00-总任务计划](./00-总任务计划.md)
- 设计方案：[设计方案-20261112-008+配置作用域全局化.md](../../designs/设计方案-20261112-008+配置作用域全局化.md)
- 依赖：任务 01（类型与方法签名）
- 状态：**已实施，待真机验收**（代码与单测完成，验收项未勾选）

---

## 一、任务目标需求

### 1.1 背景（痛点）

配置层四层化后，上层仍有多处按 `scope` 分支：五个 REST handler 用 `parseScope` 缺省写 workspace，六个 CLI 命令解析 `--workspace|--global`，`SkillLoader` 维护 workspace/global 双目录。若不随任务 01 一并收敛，会出现「底层已无 workspace 层，上层还传 `'workspace'`」的类型/语义断裂。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
|---|---|---|
| REST scope 解析 | `config.ts:17-24` `SCOPES` 双值、缺省 workspace | 改为 workspace → 400 |
| 工具启停 | `tools.ts:109,126` | 同上 |
| 模型五端点 | `models.ts:22-23,165,192,267,340` + 跨层归属提示 | 删跨层提示 |
| MCP | `mcp.ts:44`（sources 推导 scope）、`125,132`、`151-161`（layer 双分支） | scope 恒 global |
| skill | `skills.ts:20,26-30,66-70,100-110,161-189` + 7 处 `defaultRoot()` | 单目录 + 无 defaultRoot |
| skill 加载 | `skill/loader.ts:18-27` 双目录 scan | 只扫 globalDir |
| CLI | `config-command.ts:107-108,147,172`、`mcp-command.ts:129,171,257`、`model-command.ts:142,164-175`、`skill-command.ts:28-34,91-111` | `--workspace` 报错 |

### 1.3 任务目标

- `parseScope`：`undefined|null|''|'global'` → 全局；其余含 `'workspace'` → 400，文案指明「工作空间级配置已移除」
- `parseSkillScope`（auto/workspace/global）同步收敛：`workspace` → 400，`auto` 视作 `global`
- `GET /mcp/servers` 每项 `scope` 恒 `'global'`；删除 `mcp.ts:154` 的 `layer` 分支
- `models.ts` 删除 `scopeName()` 与两处跨层归属提示（`otherScope`）
- `SkillLoader`：`scan()` 只扫 `globalDir`；删除 `getWorkspaceDir()`；`SkillMetadata.scope` 恒 `'global'`
- `skills.ts` 内 7 处 `ctx.defaultRoot()` 全部消失，targetRoot 恒 `globalDir`
- CLI：`--workspace` 解析到即输出明确错误 + 替代写法；删除 `model-command.ts:164-175` 的 workspace 冲突清理向导

### 1.4 设计约束

- 响应字段形态尽量稳定（`scope` 字段保留但恒 `'global'`），降低前端与测试的连带破坏
- 400 必须带可纠正信息，不能只说「参数错误」
- 不改变「删除当前激活模型 409」等既有业务语义

---

## 二、方案设计

### 2.1 总体思路

```
请求 ?scope=workspace ──► 400（文案含替代写法）
请求 ?scope=global / 无 ──► 全局读写
请求 ?scope=auto（skill）──► 视作 global

skill 目录：~/.loop-agent/skills  ← 唯一
```

### 2.2 关键设计决策

- **D4**：`parseScope` 对 `workspace` 显式 400，不静默落全局。
  - 理由：静默落全局会让「写成功了」与「写到了别处」无法区分；旧客户端能立刻发现
  - 被否决：静默忽略（最危险）、静默落 global
- **D5**：`SkillMetadata.scope` 保留字段恒 `'global'`，不从协议删除。
  - 理由：`/skills` 响应结构与前端类型、单测夹具零破坏
  - 被否决：同时删字段（推翻前端筛选与多处夹具，收益不足）
- **D9**：MCP `scope` 字段恒 `'global'`，删 `layer` 双分支；DELETE 带 `scope=workspace` → 400。
- **D10**：CLI 保留 `--workspace` 的**解析位置**，命中即报错并给出替代写法。
  - 理由：让旧习惯用户得到「已移除」的明确反馈，而非「未知参数」的误导
  - 被否决：直接删除解析（用户会以为命令坏了）

---

## 三、任务详细设计

### 3.1 `src/api/handlers/config.ts`

```ts
export function parseScope(raw: unknown): void;   // 校验用，无返回值
// 或保留签名但恒返回 'global'，由调用方忽略
```
建议改为 `assertGlobalScope(raw: unknown): void`，命中 workspace 抛：
`bad_request: 工作空间级配置已移除（需求 20261112-008），请去掉 scope 参数或使用 scope=global`

`GET /config/path`：响应删除 `workspacePath` / `workspaceExists`，仅留 `globalPath` 与废弃说明字段（或整体改为 `{ globalPath }`，前端同步）。

### 3.2 `src/api/handlers/models.ts`

- 删 `scopeName()`
- `POST /models/:alias/use|...`、`POST /models`、`PUT /models/:alias`、`DELETE /models/:alias`：不再调 `readLayerRaw(..., scope)` 做跨层归属判断；`DELETE` 直接在 global 判定存在性，不存在则 404（文案去掉「但存在于另一层」）
- 响应 `scope` 字段保留恒 `'global'`

### 3.3 `src/api/handlers/mcp.ts`

- `handleListServers`：`scope: 'global'` 常量
- `handleDeleteServer`：删 `layer` 分支，直接判 global 存在性

### 3.4 `src/api/handlers/skills.ts`

- `SKILL_SCOPES` 收敛；`parseSkillScope` 中 `workspace` → 400，`auto`→`global`
- 安装/上传：`targetRoot = ctx.skillLoader.globalDir` 恒定
- 删除列表：`candidates = scanSkillsDir(globalDir, 'global')`
- `reload()` 不再传 root

### 3.5 `src/skill/loader.ts`

```ts
scan(): SkillMetadata[];               // 只扫 globalDir
// getWorkspaceDir() 删除
get globalDir(): string;               // 保留
```

### 3.6 `src/commands/*.ts`

| 命令 | 改动 |
|---|---|
`config-command.ts` | 保留 `--workspace` 解析位，命中即 `out.log` 错误 + 用法行改为 `[--global]` |
`mcp-command.ts` | 同上（add/remove） |
`model-command.ts` | 同上（use）；**删除 164-175 行整段 workspace 冲突清理向导**及 `collectConflictKeys`/`readLayerRaw` 引用 |
`skill-command.ts` | 同上（upload/remove）；`getWorkspaceDir` 调用改为 `globalDir`；scopeTag 文案去掉「工作空间」 |

### 3.7 演进项

- 彻底移除响应中的 `scope` 字段
- REST 端点的 scope 参数全量删除（取代 400）

---

## 四、实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P0** | REST 五组 handler 的 scope 收敛 + SkillLoader 单目录 | handler 与 loader 编译通过 |
| **P1** | CLI 六命令 `--workspace` 报错 + model-command 清理向导删除 | commands 编译通过 |
| **P2** | 单测改写：`api-endpoints.test.ts` 约 20 处 `scope:'workspace'` 断言改为 400 或 `'global'` | 全量回归绿 |

---

## 五、文件清单

| 文件 | 改动 | 阶段 |
|---|---|---|
| `src/api/handlers/config.ts` | `parseScope` 改 400；`/config/path` 去 workspace | P0 |
| `src/api/handlers/tools.ts` | 去 scope 分支 | P0 |
| `src/api/handlers/models.ts` | 删 `scopeName`/跨层提示 | P0 |
| `src/api/handlers/mcp.ts` | `scope` 恒 global；删 layer 分支 | P0 |
| `src/api/handlers/skills.ts` | 单目录 + 去 7 处 `defaultRoot()` | P0 |
| `src/skill/loader.ts` | `scan()` 单目录，删 `getWorkspaceDir` | P0 |
| `src/commands/config-command.ts` | `--workspace` 报错 | P1 |
| `src/commands/mcp-command.ts` | 同上 | P1 |
| `src/commands/model-command.ts` | 同上 + 删冲突清理向导 | P1 |
| `src/commands/skill-command.ts` | 同上 + 单目录 | P1 |
| `tests/api-endpoints.test.ts` | 断言改写 | P2 |
| `tests/skill-installer.test.ts`、`tests/skill-loader-dual-semantics.test.ts` | 双语义用例改写 | P2 |

---

## 六、任务验收清单

> 全部保持未勾选，真机验证通过后再打勾。

### 6.1 P0

- [ ] `GET/PUT/DELETE /config/:key` 带 `scope=workspace` 返回 400，文案含「已移除」
- [ ] `/config/path` 不再返回 workspace 路径
- [ ] `/tools/:name` PATCH 带 `scope=workspace` → 400
- [ ] `/models` 五端点带 `scope=workspace` → 400，无跨层归属提示
- [ ] `/mcp/servers` 每项 `scope==='global'`；DELETE 带 workspace → 400
- [ ] `/skills` 全部端点不再出现 `scope:'workspace'`；`defaultRoot` 零引用
- [ ] `SkillLoader.scan()` 只扫 `~/.loop-agent/skills`

### 6.2 P1

- [ ] `/config set --workspace` 输出明确错误与替代写法
- [ ] `/mcp add|remove --workspace` 同上
- [ ] `/model use --workspace` 同上，且冲突清理向导已删除
- [ ] `/skill upload|remove --workspace` 同上

### 6.3 P2

- [ ] `tests/api-endpoints.test.ts` 全部 scope 断言更新且通过
- [ ] skill 双语义用例改为单目录语义
- [ ] `npx vitest run` 全绿

### 6.4 人工验证（真实环境）

- [ ] WebUI 里修改工具启停、模型、MCP、skill，均落到 `~/.loop-agent/`
- [ ] 用 curl 带 `?scope=workspace` 请求五组端点，确认均为 400 且文案可读
- [ ] 切换两个不同工作空间，MCP 连接数与 skill 列表一致（不再随空间变化）

---

## 七、完成记录

### 7.1 实施结果（2026-11-12）

| 交付项 | 落点 | 说明 |
|---|---|---|
| REST scope 校验 | `src/api/handlers/config.ts` | `parseScope` 语义收敛：`undefined/null/''/global` → 全局；`workspace` → 400，文案含「工作空间级配置已移除（需求 20261112-008），请去掉 scope 参数或使用 scope=global」 |
| `/config/path` | `src/api/handlers/config.ts` | 响应不再返回工作空间路径 |
| 工具启停 | `src/api/handlers/tools.ts` | 去 scope 分支，PATCH 直接落全局 |
| 模型五端点 | `src/api/handlers/models.ts` | 删 `scopeName()` 与跨层归属提示（`otherScope`）；DELETE 只在全局判存在性（不存在 404，文案不再提「存在于另一层」）；响应 `scope` 恒 `'global'` |
| MCP | `src/api/handlers/mcp.ts` | `GET /mcp/servers` 每项 `scope` 恒 `'global'`；删 `layer` 双分支；`DELETE ... ?scope=workspace` → 400 |
| skill 端点 | `src/api/handlers/skills.ts` | `parseSkillScope` 收敛（`workspace` → 400，`auto` → global）；`targetRoot` 恒 `skillLoader.globalDir`；**7 处 `ctx.defaultRoot()` 全部消失**，顺带修复「Skills 页面暗绑最近使用空间」缺陷 |
| skill 加载器 | `src/skill/loader.ts` | `scan()` 只扫 `globalDir`；`getWorkspaceDir()` 删除；`SkillMetadata.scope` 恒 `'global'`（字段保留，D5） |
| CLI 六命令 | `config-command` / `mcp-command` / `model-command` / `skill-command` / `tools-command` / `setup-command` | `--workspace` 保留解析位，命中即输出明确错误与替代写法（D10）；`model-command.ts` 的 workspace 冲突清理向导整段删除 |
| 接口文档 | `src/api/api-docs.ts` | 相关端点参数描述统一为「可省略；仅接受 global，传 workspace 返回 400」 |

### 7.2 验证结果

- `npx tsc --noEmit`：**通过**
- 全量 `vitest run --project unit`：**182 文件 / 2369 用例全部通过**
- `tests/api-endpoints.test.ts` 的 scope 断言已随实现改写为 400 / `'global'`，验证强度未放松

### 7.3 遗留（需真机验证）

curl 带 `?scope=workspace` 逐端点核对 400 文案、以及「切换两个空间后 MCP 连接数与 skill 列表不再变化」，属 6.4 人工验证范围，尚未在运行中服务上执行。
