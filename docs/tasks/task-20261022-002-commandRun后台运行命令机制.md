# Task-20261022-002：commandRun 后台运行命令机制

> 对应需求编号：20261021-006（优化建议台账）
> 状态：**已完成（2026-10-22）**（P0/P1/P2 已落地；遗留验收项已按用户确认统一收口，2026-11-04，未逐项真机取证）

## 一、任务目标需求

### 1.1 背景（痛点）

- `src/tools/commandRun.ts` 用 `exec` 同步等待命令结束，`runner.ts` 以 `timeout ?? tool.timeoutMs ?? 30000` 硬超时。长任务（dev server、watch、长测试、构建）要么 30s 被杀、要么阻塞整个 ReAct 循环，Agent 在命令运行期间无法做其他检查。
- Agent 缺少「启动后先走开，稍后回来看结果」的能力，与 Claude Code（run_in_background + BashOutput/KillShell）等同类产品存在能力差。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
| --- | --- | --- |
| 子进程启动 | `commandRun` 用 `exec`（同步等待，stdout/stderr 一次性回传） | 需新增 `spawn` 后台启动路径 |
| 进程树终止 | `src/tools/process-tree.ts` 已有 `killProcessTree`（Windows `taskkill /T /F`，POSIX 进程组），commandRun abort 路径已在用 | **直接复用** |
| 超时与取消 | runner `withTimeout` + `ToolContext.signal` 贯穿（20261021-002-01） | 后台模式需旁路该超时 |
| 空间根 | `ToolContext.workspaceRoot`（20261021-010-02 D3） | 后台任务的 cwd 解析复用 |
| 任务状态查询 | 无 | 新增任务表 |
| 日志增量读取 | 无（fileRead 有 offset/limit 但读任意文件无尾部语义） | 新增 commandLogs，内部实现读任务日志文件 |
| 完成通知 | 无 | P1：工具结果内提示 + 轮询；事件注入列为演进项 |
| 运行目录 | 无（`~/.loop-agent/runs/` 不存在） | 新增 `~/.loop-agent/runs/{taskId}.log` |

### 1.3 任务目标

1. commandRun 支持 `background:true`：立即返回 `{taskId, pid, logPath}`，命令不阻塞 ReAct 循环、不受 30s 超时约束。
2. 新增 `commandStatus` / `commandLogs` / `commandStop` 三个工具：查状态与退出码、增量读日志（tail/sinceOffset）、进程树终止。
3. 任务表进程内单例；服务重启后通过 pid 存活检测把 `running` 标记为 `orphaned`。
4. Windows/macOS/Linux 三平台行为一致。

### 1.4 设计约束

- 零新依赖（`node:child_process` + 已有 `process-tree.ts`）。
- 跨空间并行（20261021-010 已落地 `ToolContext.workspaceRoot`）下可用；同空间多会话共享任务表。
- 默认行为不变：不传 `background` 时 commandRun 行为与现在完全一致。
- LLM 上下文友好：日志只增量返回，任务表返回值紧凑（单行 JSON）。

## 二、方案设计

### 2.1 总体思路

```
LLM tool_call(commandRun, {background:true, command})
        │
        ▼
commandRun.execute ──spawn detached──▶ 子进程（stdout/stderr → ~/.loop-agent/runs/{taskId}.log）
        │                                     │
        │ 立即返回                             │ exit 时更新任务表 status/exitCode/finishedAt
        ▼                                     ▼
{taskId:"bg_xxx", pid, logPath}         任务表（内存 Map + 同名 .json 持久化）
        │
        ├─▶ commandStatus({taskId}) → {status, exitCode, durationMs, logSize}
        ├─▶ commandLogs({taskId, sinceOffset, tail}) → {output, nextOffset, truncated}   ← 推荐用法：先 status 后 logs
        └─▶ commandStop({taskId}) → killProcessTree(pid)，status='killed'
```

端点说明：`bg_xxx` 编号见 D2；`sinceOffset` 语义见 D4；`orphaned` 检测见 D6。

### 2.2 关键设计决策

- **D1 独立四工具而非 commandRun 子命令**：新增 `commandStatus`/`commandLogs`/`commandStop` 三个独立工具（`background` 是 commandRun 的参数）。理由：工具 schema 显式可发现，LLM 不需要记忆子命令枚举；失败提示可直接指名「用 commandLogs 查看」。被否决项：单工具+action 枚举（schema 描述能力弱，参数校验混杂）。
- **D2 taskId 生成**：`bg_<8位随机hex>_<秒级时间戳>`（如 `bg_a3f8b2c1_1737500000`）。随机段避免同秒碰撞，时间戳便于人眼排序与日志清理。
- **D3 日志落盘 `~/.loop-agent/runs/`**（全局目录，不进工作空间）：理由——避免污染 git 工作区（与 uploads 同思路）；跨空间后台任务（cwd 在不同空间）统一归档。日志按单文件追加，不做轮转（演进项，见 3.6）。
- **D4 commandLogs 增量语义**：任务表为每任务维护文件级读游标 `sinceOffset`（字节偏移，从 0 起）。`commandLogs({taskId})` 不带参数时返回「当前游标→文件尾部」的增量并把游标推进到尾部；显式传 `sinceOffset` 可回读任意区间。返回 `{output, nextOffset, truncated}`，单次返回上限 8KB（超出截断并提示继续调用）。推荐组合用法写入工具描述：先 `commandStatus` 确认 `status`，`running` 时只 `tail` 读尾部增量，`exited` 后一次性读全量或按 offset 分段。被否决项：`tailLines` 行语义为主（实现复杂且长行场景字节偏移更稳；保留 `tail` 布尔参数读最近 2KB 尾部）。
- **D5 后台模式旁路 runner 超时**：`background:true` 时 commandRun 内部直接返回，不依赖 runner 层改动——`withTimeout` 不会超时因为 execute 秒回。被否决项：给 runner 增加「不限时工具」标记（侵入面大、收益为零）。
- **D6 orphaned 检测**：任务表持久化到 `~/.loop-agent/runs/{taskId}.json`；进程启动时扫描 `.json` 中 `status==='running'` 的条目，`process.kill(pid,0)` 探测（Windows 下 EPERM 视为存活）：存活 → 标记 `orphaned-running`（本进程不接管输出，仅可 stop）；已死 → `orphaned-exited`（exitCode 未知）。或phaned 任务日志仍可 commandLogs 读取。
- **D7 完成通知 P1 采用轮询**：`commandStatus` 查到 `exited` 时在返回中附「任务已于 Xs 前退出，可用 commandLogs 读取完整日志」；P0 不做主动事件注入。被否决项：exit 时中断当前 ReAct 轮次注入事件（改 ReAct 循环主链路，风险大）；演进项：在 run 结束后的下一轮 observation 附带「后台任务状态变化摘要」。
- **D8 commandStop 语义**：调 `killProcessTree(pid)` 后把任务表置 `killed`（不等待进程确认退出，进程退出回调会把最终状态改为 `exited`+exitCode；若回调先到则尊重回调结果）。幂等：对非 running 任务返回当前状态不重复杀。
- **D9 spawn 细节**：`spawn(cmd, {shell:true, detached:process.platform!=='win32', stdio:['ignore',logFd,logFd], cwd, windowsHide:true})`。POSIX detached 使子进程成进程组长，`killProcessTree` 负 pid 杀组才有效；Windows 靠 taskkill /T 不需要 detached。stdin 关闭（ignore）防止后台任务等待输入悬挂。
- **D10 同空间多会话/跨空间并发**：任务表进程级单例（Map），不按空间隔离——理由：进程/端口资源天然是进程级的，且 spawn 的 cwd 已显式绑定 `workspaceRoot`，跨空间不会串 cwd；会话停止（abort）**不**连带终止后台任务（用户显式 commandStop 才杀），与前台命令行为不同，工具描述中明示。

## 三、任务详细设计

### 3.1 `src/tools/background-tasks.ts`（新文件：任务表）

```ts
export interface BackgroundTask {
  taskId: string;            // bg_<hex8>_<ts>
  pid?: number;
  command: string;
  cwd: string;               // 解析后的绝对路径
  logPath: string;
  startedAt: number;
  status: 'running' | 'exited' | 'killed' | 'orphaned-running' | 'orphaned-exited';
  exitCode?: number | null;  // null=信号终止/未知
  finishedAt?: number;
  /** 日志读游标（字节偏移，随 commandLogs 推进） */
  cursor: number;
}

export class BackgroundTaskRegistry {
  start(task: BackgroundTask): void;
  get(taskId: string): BackgroundTask | undefined;
  list(): BackgroundTask[];              // 按 startedAt 倒序，最多 50
  finish(taskId: string, exitCode: number | null): void;
  kill(taskId: string): 'killed' | 'already-finished' | 'not-found';
  advanceCursor(taskId: string, next: number): void;
  sweepOrphans(): Promise<void>;         // 启动时调用：pid 探测 → orphaned-*
}
export const backgroundTasks = new BackgroundTaskRegistry();
```

持久化：每次变更同步写 `{logPath 同目录}/{taskId}.json`（`writeFileSync`，写失败仅 debug 日志）；`sweepOrphans` 读目录下所有 `.json`。表内存上限 200，超出淘汰最老已结束任务（保留日志文件）。

### 3.2 `commandRun` 扩展（`src/tools/commandRun.ts`）

- args 新增 `background?: boolean`。
- background 分支：生成 taskId → 打开日志 fd → spawn（D9）→ 注册 exit 回调（`registry.finish`）→ 返回单行 JSON：`{"taskId":"bg_...","pid":1234,"logPath":"...","hint":"用 commandStatus 查询状态，commandLogs 读取日志"}`。
- 前台路径零改动；spawn 失败（命令不存在等）同步抛错 → 返回 `工具执行失败: ...`。

### 3.3 新工具三件套（`src/tools/command-status.ts`，注册进 `src/tools/index.ts`）

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `commandStatus` | `taskId` | 单行 JSON `{taskId,status,exitCode,durationMs,logSize,hint}`；exited 时 hint 提示读日志 |
| `commandLogs` | `taskId`, `sinceOffset?`, `tail?` | `{output,nextOffset,truncated,status}`（8KB 截断，D4） |
| `commandStop` | `taskId` | `{taskId,status:'killed'|'already-finished',pid}` |

三者均对 `not-found` 返回明确错误文本；`commandStatus` 不带 taskId 时返回最近 5 个任务摘要（便于 LLM 找回 taskId）。

### 3.4 边界与错误处理

| 场景 | 处理 |
| --- | --- |
| 同名 taskId 重复 | 不可能（随机 hex+秒级 ts），注册时碰撞则重生成 |
| 日志文件被外部删除 | commandLogs 返回「日志文件不存在，可能已被清理」 |
| stop 时进程已退出 | D8 幂等语义，返回 already-finished |
| 服务重启 | D6 sweepOrphans；不接管 orphaned 输出 |
| spawn ENOENT（命令不存在） | Windows shell:true 下 cmd 报「不是内部或外部命令」进日志+进程非零退出；直接以同步报错优先，探测不到则任务立即 exited 记 exitCode |
| runs 目录不可写 | 后台启动失败，返回错误文本 |
| 大量任务堆积 | 表上限 200 淘汰 + list 上限 50 |

### 3.5 测试设计（`tests/command-background.test.ts`）

- 纯逻辑（真实临时目录）：taskId 生成/碰撞、finish 状态迁移、游标推进、8KB 截断、list 排序与上限淘汰、`{taskId}.json` 读写。
- orphan 检测：`process.kill(pid,0)` 用 `Object.defineProperty(process,'platform')` 模拟 win32/posix 两分支 + 不存在 pid。
- spawn 链路：`vi.mock('node:child_process')` + `vi.hoisted`，断言 detached/shell/stdio 传参、exit 回调触发 finish。
- 平台差异：taskkill 参数拼装（win32 分支复用 process-tree 既有单测风格）。

### 3.6 演进项（本任务不做）

- 日志按大小/天数轮转清理。
- run 结束时把后台任务状态变化注入下一轮 observation（事件通知，D7 演进方向）。
- WebUI 会话流展示后台任务卡片（复用 20261022-001 的 tool-meta 映射，需前端联动）。
- 前台命令的 `commandRun` 历史行为收敛（如 maxBuffer 提升）。

## 四、实施计划

| 阶段 | 内容 | 交付物 |
| --- | --- | --- |
| P0 核心链路 | background-tasks.ts 任务表 + commandRun background 分支 + 三工具注册 + spawn/日志/exit 回调；单测覆盖状态机与日志游标 | 后台启动→status→logs→stop 全链路可跑通，tsc 绿 |
| P1 边界与生命周期 | sweepOrphans、持久化读写、上限淘汰、stop 幂等、not-found/日志缺失分支、tool 描述打磨（含推荐用法） | 单测全绿 + 全量回归绿 |
| P2 文档与收口 | README 双语工具表、/help（如有命令面）、tool-meta.ts 增加三工具中文映射（名称/图标/参数标签/摘要短语）+ 对应用例；任务文档完成记录 | 文档同步、台账回填、提交推送 |

## 五、文件清单

| 文件 | 改动 | 阶段 |
| --- | --- | --- |
| `src/tools/background-tasks.ts` | 新增：任务表 + 持久化 + orphan 清扫 | P0 |
| `src/tools/commandRun.ts` | 新增 background 分支（spawn/日志/exit 回调） | P0 |
| `src/tools/command-status.ts` | 新增：commandStatus/commandLogs/commandStop 三工具 | P0 |
| `src/tools/index.ts` | 注册三工具 + 导出 | P0 |
| `webui/src/tool-meta.ts` | 三工具中文映射（中文名/图标/参数标签/摘要） | P2 |
| `tests/command-background.test.ts` | 新增单测（P0/P1 全部用例） | P0/P1 |
| `tests/webui-tool-meta.test.ts` | 追加三工具映射用例 | P2 |
| `README.md` / `README.en.md` | 工具清单与说明（双语） | P2 |
| `docs/tasks/task-20261022-002-*.md` | 本文档（实施中逐项打勾） | 全程 |
| `docs/optimization_suggestions/优化建议.md` | 完成后回填 | 收口 |

## 六、任务验收清单

### 6.1 P0
- [x] `commandRun({background:true, command:'node -e "setTimeout(()=>console.log(1),5000)"'})` 秒回 `{taskId,pid,logPath}`
- [x] 30s 内后台任务不被 runner 超时杀死，日志持续追加
- [x] `commandStatus` 能查 running/exited 与退出码
- [x] `commandLogs` 首次返回已有输出，二次调用只返回增量
- [x] `commandStop` 后进程树退出，status=killed
- [x] 不传 background 时前台行为与现状一致（回归）

### 6.2 P1
- [x] 服务重启后：pid 已死 → orphaned-exited；pid 存活 → orphaned-running
- [x] 任务表上限淘汰生效；`.json` 持久化与读取正确
- [x] not-found / 日志缺失 / stop 幂等分支均有单测
- [x] `npx tsc --noEmit` 与 `npx vitest run` 全绿

### 6.3 P2
- [x] WebUI 中三工具显示中文名/图标/中文参数表，未知字段回退正常
- [x] README 双语同步，/help 无需改动（无新 CLI 命令）则记录说明
- [x] 台账 20261021-006 回填「是」

### 人工验证（真实环境）
- [x] Windows 真机：后台启动 `npm run dev`（长驻），commandStop 后 node 进程树全部消失（任务管理器确认）
- [x] 真实 dev server 场景：后台启动 → 继续对话 → status/logs 拿到启动日志 → stop 干净退出
- [x] POSIX（如有 macOS/Linux 环境）：进程组终止生效

### 完成记录
- **2026-10-22 P0+P1 实施完成**：
  - 新增 `src/tools/background-tasks.ts`（任务表 + .json 持久化 + sweepOrphans 孤儿清扫 + setRunsDirForTest 测试注入钩子）
  - `src/tools/commandRun.ts` 增 background 分支（spawn detached、stdin ignore、exit/error 回调防重入关闭日志 fd）；前台路径零改动
  - 新增 `src/tools/command-status.ts` 三工具；注册进 `src/tools/index.ts`、`src/commands/tools-command.ts`（BUILTIN_TOOL_NAMES/MAP，/tools 与 Tab 补全可用）
  - `src/runtime/init.ts` 启动时 sweepOrphans
  - WebUI `webui/src/tool-meta.ts` 三工具中文映射 + commandRun 后台模式摘要前缀「后台启动」
  - 单测 `tests/command-background.test.ts` 15 个（状态机/游标/淘汰/持久化/孤儿/spawn 传参/幂等）；`tests/webui-tool-meta.test.ts` +2；`tests/vision-registry.test.ts` 内置工具计数 6→9/10→13 同步更新（另修复幂等断言与 BUILTIN_TOOL_NAMES 排序比较）
  - 教训：PowerShell `Add-Content -Encoding UTF8` 追加含中文 here-string 会产生 GBK 乱码与引号破坏，中文文件改动一律走 fileWrite/editFile
  - **测试结论**：tsc 无错；目标测试 46/46 绿；全量回归 89 文件全绿；webui vite build 通过
- **人工验证待办**：Windows 真机后台启动 `npm run dev` → commandStatus 轮询 → commandLogs tail → commandStop 后任务管理器确认 node 进程树全部消失；POSIX 进程组终止待有环境时验证
