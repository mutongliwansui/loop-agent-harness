# task-20261104-006 · 前台 commandRun 行为收敛

> 对应需求编号：**20261104-006**（前台 commandRun 行为收敛）
> 来源：优化建议 20261021-006 / task-20261022-002「3.6 演进项」第 4 条
> 状态：**已实施（2026-11-05，按推荐值：D1 spawn+累积器 / D2 头尾各 128KB / D7 默认 30s）**
> 涉及：[commandRun.ts](../../../../src/tools/commandRun.ts)、[command-background.test.ts](../../../../tests/command-background.test.ts)

## 一、任务目标需求

### 1.1 背景（痛点）

前台 `commandRun` 走 `exec(cmd, {timeout:30000, maxBuffer:1MB})`：

- 输出超过 1MB 直接以 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` 失败，且 `stdout` 截断内容拿不到完整头部，排障信息反而丢失；
- 错误汇编里 `stderr` 标签重复（`[stderr]\n[stderr]\n…`），输出格式不严谨；
- 超时与退出码只体现在 `err.message` 文本里，没有稳定的结构化标记；
- 与后台模式（完整日志落盘、明确状态机）口径割裂。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
| --- | --- | --- |
| 前台执行 | [commandRun.ts](../../../../src/tools/commandRun.ts#L46-L72) `exec` + 30s 默认超时 + 1MB `maxBuffer` | 改为 spawn 流式捕获 |
| 输出上限 | `maxBuffer` 超限直接失败 | 改为头尾保留 + 中间省略 |
| 错误汇编 | 第 58 行 `[stderr]\n[stderr]` 重复标签 | 修正 |
| 超时语义 | `err.killed`/`err.code` 混在 message | 增加 `[timeout=…ms]` 标记 |
| 取消语义 | `ctx.signal` abort + `killProcessTree` 兜底 | 保留 |
| 后台口径 | taskId/状态/exitCode/日志路径 | 前台输出格式对齐（退出码、耗时） |

### 1.3 任务目标

1. **不再因 `maxBuffer` 失败**：无论输出多大，都返回「头 + 尾 + 省略字节数」，总大小可控（默认 ≤256KB）。
2. 输出结构稳定：`[stdout]` / `[stderr]` / `[exit=N]` / `[timeout=30s]` / `[duration=…]`，标签不重复。
3. 超时有明确标记，仍返回已捕获输出，而非只剩一句错误。
4. 取消（`ctx.signal`）保留进程树终止兜底，返回内容与超时区分。
5. 默认行为对现有短命令零变化（输出格式仅修正重复标签）。
6. 输出上限、头尾配额可通过 `tools.commandRun` 配置或参数覆盖（默认值合理即可）。

### 1.4 设计约束

- 不改变 `commandRun` 参数 schema 的既有字段（`command` / `cwd` / `timeout` / `background`）。
- 保持零新依赖（`node:child_process` + `node:path`）。
- Windows 上仍走 shell（cmd.exe），POSIX 走 `/bin/sh`，与后台一致。
- 大输出处理不得阻塞事件循环（分块累积，超过配额即丢弃中段）。
- 取消行为不得回归（`tests/command-background` 的 abort 用例必须继续通过）。

## 二、方案设计

### 2.1 总体思路

```
前台 commandRun
   └─ spawn(cmd, { shell:true, cwd, env, signal? 不直接传 })
        ├─ stdout.on('data') ─┐
        ├─ stderr.on('data') ─┴─▶ OutputAccumulator
        │                          ├─ 头部配额 128KB：追加
        │                          ├─ 尾部配额 128KB：环形保留
        │                          └─ 丢弃中段时累计 omittedBytes
        ├─ 定时器 timeoutMs → killProcessTree + timeout 标记
        └─ close(code, signal) → 渲染
                                   [stdout]<head>…<omitted>…<tail>
                                   [stderr]…
                                   [exit=N] / [timeout=…] / [duration=…]
```

### 2.2 关键设计决策

| 编号 | 决策 | 取舍 / 被否决项 |
| --- | --- | --- |
| D1 | 用 `spawn` + 自建 `OutputAccumulator` 替换 `exec`，**彻底移除 `maxBuffer`** | 否决继续调大 `maxBuffer`：总有更大的输出；否决保留 `exec` 只做错误兜底：拿不到完整头尾 |
| D2 | 头尾各保留 128KB，中段省略并输出 `…(省略 N 字节)…`；总输出上限 256KB | 否决只保留尾部：丢失命令开头的关键报错；否决只保留头部：看不到最终失败原因 |
| D3 | 默认超时仍为 30s，`timeout` 参数沿用；超时输出 `[timeout=30000ms]` 并附已捕获输出 | 否决取消默认超时：长任务应走后台模式；否决超时只返回错误：丢失诊断信息 |
| D4 | 非零退出统一 `[exit=N]`；被信号终止 `[signal=SIG]`；abort 由 `ctx.signal` 标记 `[aborted]` | 否决沿用 `err.message` 散文：不可解析、易变 |
| D5 | 修正 `stderr` 重复标签；`[stderr]` 仅在非空时输出 | 纯 bug 修正 |
| D6 | 前台输出不落盘（保持内存语义）；长任务引导用 `background:true` | 否决前台也写 runs/*.log：会与后台任务生命周期混淆 |
| D7 | 配置 `tools.commandRun: { outputLimitKb=256, timeoutMs=30000 }`，参数优先 | 否决硬编码：不同团队输出规模不同 |
| D8 | 保留 `killProcessTree` 的 abort 兜底监听，先杀树再 close | 与后台一致，Windows 防孙进程残留 |

### 2.3 联网检索结论

- Node 官方文档：`exec` 的 `maxBuffer` 超限会直接 destroy 子进程，`stdout` 只保留部分内容——这是本任务的核心动机。
- 常见做法（VS Code Task / GitHub Actions runner）均为「流式累积 + 头尾截断 + 明确 omitted 标记」，避免日志爆内存同时保留首尾上下文。
- 已知坑：`spawn` 若未消费 `stdout/stderr` 会造成子进程阻塞（管道背压），必须持续 `data` 监听并在超限后仍 drain。
- 来源：Node.js `child_process` 文档、VS Code Task API 文档（2026-11 检索）。

## 三、任务详细设计

### 3.1 OutputAccumulator

```ts
class OutputAccumulator {
  constructor(headBytes = 128 * 1024, tailBytes = 128 * 1024)
  push(chunk: Buffer): void   // 超限后中段丢弃并累计 omitted
  render(): { text: string; omittedBytes: number }
}
```

- 两个独立 accumulator（stdout/stderr），各自头尾配额；渲染顺序 `[stdout]` → `[stderr]`。
- 输出前做 UTF-8 解码容错（`Buffer.toString` 分段可能截断多字节字符 → 按行边界回退，避免乱码）。

### 3.2 执行与终止

| 事件 | 处理 |
| --- | --- |
| `timeout` | `killProcessTree(child.pid)`；`timedOut=true`；等待 `close` 后渲染 |
| `ctx.signal.abort` | `killProcessTree`；`aborted=true`（ToolRunner 的 `raceAbort` 仍会 reject） |
| spawn error | 返回 `工具执行失败: 启动失败 (…)`，与后台同文案口径 |
| close(code, signal) | `exitCode=code`；`signal` 非空时 `[signal=…]` |

### 3.3 边界与错误处理

| 场景 | 行为 |
| --- | --- |
| 空输出 | `(无输出，exit=0)` |
| 仅 stderr | 只输出 `[stderr]` 段，不出现空 `[stdout]` |
| 输出 10MB | 返回 256KB，`omittedBytes` 明确 |
| 命令不存在 | shell 返回 127，`[exit=127]` + stderr |
| 超时后仍有孙进程 | `killProcessTree` 树杀；Windows `taskkill /T /F` |
| 取消 | 返回标记 `[aborted]`（内容随后被 raceAbort 丢弃，语义不变） |

### 3.4 演进项（本任务不做）

- 前台输出也落盘（临时日志 + 清理）。
- 交互式 stdin。
- 输出流式回传 WebUI（当前仍一次性返回）。

## 四、实施计划

| 阶段 | 内容 | 交付物 |
| --- | --- | --- |
| P0 | `OutputAccumulator` + spawn 前台路径 + 稳定输出格式 | command-run-output.ts、commandRun.ts |
| P1 | 超时/取消/树杀接线 + 配置项 + 参数覆盖 | commandRun.ts、schema.ts |
| P2 | 单测（大输出/超时/非零退出/stderr 标签/abort）+ 中英文档 | tests、docs/readme |

## 五、文件清单

| 文件 | 改动 | 阶段 |
| --- | --- | --- |
| [src/tools/command-run-output.ts](../../../../src/tools/command-run-output.ts)（新增） | 头尾累积器与渲染 | P0 |
| [commandRun.ts](../../../../src/tools/commandRun.ts#L46-L72) | 前台改 spawn；错误汇编修正；超时/取消标记 | P0/P1 |
| [schema.ts](../../../../src/config/schema.ts) | `tools.commandRun` 默认值 | P1 |
| tests/command-run-output.test.ts（新增） | 11 个用例（累积器 4 + commandRun 5 + 配置 2） | P2 |
| tests/command-background.test.ts | 保持既有 abort/后台用例全绿 | P2 |
| docs/readme 中英 | 输出格式与配置说明 | P2 |

## 六、任务验收清单

### 6.1 P0

- [x] 10MB 输出不再失败，返回头尾 + 文本内标注省略字节数
- [x] `[stdout]`/`[stderr]`/`[exit=N]` 标签唯一且稳定
- [x] 短命令输出与旧版肉眼一致（仅 stderr 修正）

### 6.2 P1

- [x] 超时返回 `[timeout=…]` + 已捕获输出，孙进程被清理
- [x] `ctx.signal` 取消仍走 `killProcessTree`，既有 abort 用例全绿
- [x] 配置/参数可覆盖输出上限与默认超时

### 6.3 P2

- [x] 新增单测 11 例；`tsc --noEmit`、全量 `vitest run` 通过
- [x] 中英文档同步输出格式与配置项

### 人工验证（真实环境）

- [ ] Windows：`dir /s` 大输出、`ping -n 5` 超时、`cmd /c exit 1` 非零退出
- [ ] macOS/Linux：`yes | head -c 5000000` 大输出、`sleep 40` 超时、Ctrl+C 取消

## 七、待确认决策点

1. **D1 实现方式**：spawn + 自建累积器（推荐）还是保留 `exec` 仅调大 `maxBuffer`（改动小但仍有上限）。
2. **D2 配额**：头尾各 128KB（推荐）还是 64KB（更省上下文）。
3. **D7 默认超时**：保持 30s（推荐，长任务走后台）还是放宽到 120s。

## 八、完成记录（2026-11-05）

- 决策：按推荐值通过（D1 spawn + OutputAccumulator；D2 头尾各 128KB、总量 256KB；D7 默认 30s）。
- 新增 `src/tools/command-run-output.ts`：头填满后进入尾部环形区，超限从最旧块丢弃并累计 `omittedBytes`；UTF-8 截断按字节补齐，不出现替换符；容量配置注入与单侧配额换算。
- `commandRun` 前台改 spawn（`shell:true`、`stdio:['ignore','pipe','pipe']`），持续消费 stdout/stderr 避免背压；`[stdout]`/`[stderr]` 各一标签，非零退出附 `[exit=N]` 与 `[duration=…]`，超时 `[timeout=Nms]`、取消 `[aborted]`、信号 `[signal=…]`；已取消 signal 不启动进程。
- 配置：`tools.commandRun.outputLimitKb/timeoutMs`，`init.ts` 注入；`tools.backgroundNotify` 同批注入。
- 既有契约调整：`tests/command-background.test.ts` 中「前台走 exec 不走 spawn」改为「前台走 spawn 并流式收集」；后台 spawn 用例日志目录改用临时目录，避免污染 `~/.loop-agent/runs`。
- 单测：`tests/command-run-output.test.ts` 11 例。

