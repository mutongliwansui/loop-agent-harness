# task-20261107-005 · delegate 工具展示中文化

> 对应需求编号：**20261107-005** ｜ 状态：**已实施（2026-11-07）** ｜ 创建：2026-11-07
> 原型：[20261107-001-子Agent委托原型.html](../prototypes/20261107-001-子Agent委托原型.html)

## 一、任务目标需求

### 1.1 背景（痛点）

20261107-002 上线后，WebUI 的 `delegate` 工具卡片头部显示英文原名 `delegate`，执行中的简报也读不出中文语义，与原型设计的「委托子任务」不一致。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
| --- | --- | --- |
| 工具中文名 | [tool-meta.ts](../../webui/src/tool-meta.ts#L141) 的 `TOOL_META` 未登记 `delegate` | `toolDisplay()` 走未知工具兜底，返回英文名 |
| 执行中简报 | [chat-stream.ts](../../webui/src/chat-stream.ts#L718-L733) 调 `toolSummary(progTool, s.args)` | 未登记 → 回退紧凑 JSON，用户不可读 |
| 参数标签 | `toolParamRows()` 依赖 `TOOL_META.params` | 未登记 → 显示原始 key |
| 既有约定 | 未知工具回退英文名 + 齿轮图标（[webui-tool-meta.test.ts](../../tests/webui-tool-meta.test.ts#L35-L40) 已锁定该约定） | 修法是「登记」而非改兜底 |
| 工具名 | [delegate.ts](../../src/tools/delegate.ts#L9-L16) 注册名 `delegate` | 协议名保持不变 |

### 1.3 任务目标

1. `TOOL_META` 登记 `delegate`：中文名「委托子任务」、图标、参数中文标签；
2. 摘要生成器输出「委托 + 任务首句（后台时标注『后台』）」，替代紧凑 JSON；
3. 卡片头部、执行中 brief、参数区全部显示中文；
4. 新增单测锁定映射，防止回退英文。

### 1.4 设计约束

- 只改前端展示层，**不改工具注册名与后端协议**；
- 复用既有 `TOOL_META` 结构、`toolSummary` 约定与图标集合，不新增图标资源；
- 未知工具兜底逻辑保持不变。

## 二、方案设计

### 2.1 总体思路

```
delegate tool_call
   ├─ toolDisplay('delegate') ──▶ { icon: 'puzzle', name: '委托子任务', known: true }
   ├─ toolSummary('delegate', args) ──▶ 「调研 xxx（后台）」
   └─ toolParamRows('delegate', args) ──▶ task / context / background 中文标签
```

### 2.2 关键设计决策

| 编号 | 决策 | 取舍 / 被否决项 |
| --- | --- | --- |
| D1 | 中文名定为「委托子任务」 | 与 20261107-001 原型一致；否决「子代理」「委派」等别名 |
| D2 | 图标 key 复用 `puzzle`（拼图块） | 语义为「拆分子任务」；否决新增 SVG 资源 |
| D3 | 参数标签：`task`→任务、`context`→背景上下文、`background`→后台执行 | 与原型参数区一致 |
| D4 | 摘要 = `委托 {task 首 40 字}`，`background=true` 追加「（后台）」；task 缺失回退「委托子任务」 | 与主对话 toolSummary 风格一致；否决展示 JSON |
| D5 | 不修改 `toolDisplay` 的未知工具兜底 | 保持 20261022-001 约定，避免波及其他工具 |

## 三、任务详细设计

### 3.1 元信息条目

```ts
delegate: {
  zh: '委托子任务',
  icon: 'puzzle',
  params: {
    task: '任务',
    context: '背景上下文',
    background: '后台执行',
  },
}
```

### 3.2 摘要规则

```ts
brief: (a) => {
  const task = str(a, 'task');
  if (!task) return '委托子任务';
  const head = clip(task, BRIEF_TEXT_MAX); // 40 字 + …
  return a.background === true ? `委托 ${head}（后台）` : `委托 ${head}`;
}
```

### 3.3 边界与错误处理

| 场景 | 行为 |
| --- | --- |
| `args` 为空/非对象 | 返回「委托子任务」 |
| `task` 非字符串 | 按缺失处理，返回「委托子任务」 |
| `background` 非布尔（如 `"true"`） | 仅 `=== true` 视为后台，避免误标 |
| MCP/未来同名工具 | 不受影响（MCP 仍走 `mcp-tool-meta` 覆盖） |

### 3.4 演进项（本任务不做）

- 其他未登记工具批量中文化；
- 工具参数区展示 `context` 全文（保持摘要/首行）；
- 后端返回展示名（仍由前端映射决定）。

## 四、实施计划

| 阶段 | 内容 | 交付物 |
| --- | --- | --- |
| P0 | `TOOL_META` 登记 + `toolSummary` 分支 + 单测 | 卡片显示「委托子任务」 |
| P1 | 执行中 brief、参数区回归检查；`webui build` | 全链路中文 |

## 五、文件清单

| 文件 | 改动 | 阶段 |
| --- | --- | --- |
| `webui/src/tool-meta.ts` | 新增 `delegate` 元信息与摘要分支 | P0 |
| `tests/webui-tool-meta.test.ts` | 增加 `delegate` 的中文名/图标/摘要/参数标签断言 | P0 |

## 六、任务验收清单

### 6.1 P0
- [x] `toolDisplay('delegate')` 返回 `{ icon:'puzzle', name:'委托子任务', known:true }`
- [x] 执行中简报显示「委托 调研…（后台）」，不再出现 JSON 报文
- [x] 参数区显示「任务 / 背景上下文 / 后台执行」
- [x] 单测覆盖 map + summary + 空参回退

### 6.2 P1
- [x] `npx tsc --noEmit` 0 错误
- [x] `npx vitest run` 无新增回归（全量 1876/1885；2 文件 9 条并行跑触发环境 `EPERM mkdir`，单独重跑通过，见 20261107-003 记录）
- [x] `npm --prefix webui run build` 成功
- [ ] WebUI 实测：同步/后台两种 delegate 卡片头部均为「委托子任务」（未执行，留待人工验收）

### 6.3 完成记录

**实施（2026-11-07）**

- `webui/src/tool-meta.ts` 的 `TOOL_META` 新增 `delegate`：中文名「委托子任务」、`puzzle` 图标、参数标签 `task/context/background`，摘要为「委托 {task 前 40 字}（后台）」；`task` 缺失或空参数回退固定中文名「委托子任务」，不再露出紧凑 JSON（`background` 仅 `=== true` 才标注）。
- `tests/webui-tool-meta.test.ts`：`BUILTIN_TOOLS` 增补 `delegate`（防回归：内置工具必须命中中文映射），新增 1 条断言（中文名/图标/前台与后台摘要/非布尔 background/空参数回退）。
- 定向验证：`tests/webui-tool-meta.test.ts` + `tests/webui-subagent-process.test.ts` 共 **53/53 通过**；`tsc --noEmit` 0 错误；`webui` build 成功（39.99s）。
- 遗留：真实 WebUI 卡片头部（同步 / 后台两种）未做实机走查。
