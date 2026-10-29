# task-20261029-001 CLI 模式 Ctrl+C 中断当前回答（而非退出进程）

> 对应需求编号：**20261029-001**（见 `docs/requirements/需求.md`）
> 状态：**方案待确认**（本文档只出方案，未改代码）
> 提出时间：2026-10-29

---

## 一、任务目标需求

### 1.1 背景（痛点）

CLI 模式（`npx tsx src/index.ts`，走 REPL，非 `--serve`）下，模型正在流式回答时按 **Ctrl+C**，期望「打断这次回答」，实际效果是**整个 CLI 退出**，而且不是立刻退出——先等 Dreaming（记忆晋升，可能数十秒）跑完才 `process.exit(0)`，体感像「卡一下然后没了」。本轮已生成的内容、已跑的工具步骤全部作废，会话也终结，必须重开 CLI。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
|---|---|---|
| run 级取消信号 | `AgentOptions.signal`（`src/types.ts:293`）已定义并全链路透传 | ✅ 已有 |
| LLM 流式请求可取消 | `src/llm/client.ts:227/441` 透传 `signal` 给 SDK；`495/507` 判 `aborted` 抛 `AgentAbortedError`，不进入重试 | ✅ 已有 |
| 工具执行可取消 | `src/tools/runner.ts:50-56/122-128` `raceAbort` 竞速；`commandRun.ts:52/65-67` 取消时杀 Windows 进程树 | ✅ 已有 |
| Agent 主循环检查点 | `src/agent/react-agent.ts:558-566` `throwIfAborted` C1–C5；`994-1008` 换绑完整 partial | ✅ 已有 |
| 取消后的消息序自洽 | `src/api/abort-utils.ts:12` `sealPendingToolCalls`（补合成 tool 消息） | ✅ 已有（当前仅 API 侧用） |
| API 侧取消接线 | `RunHub` + `/stop` → `handlers/messages.ts:118-120` 注入 signal，`225-264` 封口 + 部分落盘 + `aborted` 终态 | ✅ 已有 |
| **CLI 侧取消接线** | `src/cli/start.ts:340` `agent.run(input, { verbose, spinner })`——**未创建 AbortController、未传 signal** | ❌ **缺口** |
| **Ctrl+C 分派** | `src/cli/start.ts:356-360` `rl.on('SIGINT')` 不区分运行态/空闲态，一律 `disconnectAll()` + `rl.close()`；`362` 的 `close` 处理器先跑 Dreaming 再 `exit(0)` | ❌ **缺口（根因）** |

一句话：**取消这条链在下游早就修好了（Task-20261021-002 三批次），只有 CLI 这个入口没接上——Ctrl+C 被当成「退出」而不是「取消 run」。**

### 1.3 任务目标

把 CLI 的 Ctrl+C 改为**两态语义**：

| 状态 | Ctrl+C 行为 |
|---|---|
| 模型回答中（`running === true` 且本轮持有 AbortController） | **只中断本次回答**：停止流式输出/工具执行 → 补换行 → 打印中断提示 → 回到 `Agent>` 提示符，会话继续可用 |
| 空闲态（无任务在跑） | **退出 CLI**（保持现有链路：`disconnectAll` → `rl.close()` → Dreaming → `exit(0)`），但需防误触（D2） |
| 中断收尾中（已 abort、run 尚未返回） | **忽略**并提示「正在停止…」，**绝不退出**（D3） |
| y/N 确认中（`confirming === true`） | 视为回答 `n` 并退出确认，不中断 run、不退出进程（D6） |
| Dreaming 收尾中（`rl` 已 close） | 立即强退（D7，与 serve 模式二次信号强退对齐） |

### 1.4 设计约束

- **零新依赖**：只用 `node:readline` 已有的 `SIGINT` 事件 + 标准 `AbortController`。
- **不改 API/WebUI 语义**：`/stop`、`aborted` 终态、部分落盘逻辑一律不动。
- **跨平台**：Windows/macOS/Linux 统一走 readline `'SIGINT'`；Windows 的 Ctrl+Break 走 `SIGBREAK`、readline 不 emit，列为演进项。
- **非 TTY 不变**：管道/CI 场景下 readline 不产生 `SIGINT` 事件，行为与今天一致。
- **上下文自洽硬约束**：中断后**不得**留下孤立 `tool_calls` 污染下一轮（否则下一轮 400 `tool must be response to preceding tool_calls`）。

---

## 二、方案设计

### 2.1 总体思路

```
                    ┌──────────────────────────────────────────┐
                    │  rl.on('SIGINT')  ← Ctrl+C               │
                    └───────────────────┬──────────────────────┘
                                        ▼
                        decideSigint(state)   ← 纯函数，可单测（D1）
                                        │
        ┌───────────────┬───────────────┼────────────────┬──────────────┐
        ▼               ▼               ▼                ▼
   'abort-run'     'ignore-busy'   'cancel-confirm'  'arm-exit' / 'exit'
   （run 进行中）   （收尾中/命令中）  （y/N 确认中）    （空闲态，D2）
        │               │                │                │
        ▼               ▼                ▼                ▼
 currentRun.controller.abort()   提示"正在停止…"   rl.write('n')/  第一次打提示+3s 窗口
        │                                           resolve(false)   第二次 → exit 流程
        ▼
 agent.run 抛 AgentAbortedError（下游链路已存在，零改动）
        │
        ▼
 CLI catch 分支：spinner.stop() → 补换行 → 打印中断摘要
        │
        ▼
   D4-B（已选定）：封口 sealPendingToolCalls → 落盘部分输出 → 回写内存基线
        （sealPendingToolCalls 由 api/ 下移到 agent/，api 侧 re-export 保持引用不变）
        │
        ▼
   safePrompt()  →  会话继续
```

关键点：**中断能力本身不需要新造**，本任务做的是「状态分派 + signal 接线 + 收尾提示」。

### 2.2 关键设计决策（D1–D10）

**D1｜Ctrl+C 分派逻辑抽成纯函数 `decideSigint`，放在新文件 `src/cli/interrupt.ts`。**
输入 `{ running, aborting, confirming, exiting, dreaming }`，输出 `'abort-run' | 'ignore-busy' | 'cancel-confirm' | 'arm-exit' | 'exit'`。
取舍：不把分派写成 `start.ts` 里一大串 `if`——那样只能靠真实终端手按验证；抽纯函数后可零成本单测全部分支（含竞态顺序）。
被否决项：在 `process.on('SIGINT')` 上做全局分派（readline 已接管 stdin 的 Ctrl+C，双监听会重复触发）。

**D2｜空闲态退出需要「双击确认」：第一次打印提示并开 3s 窗口，第二次才退出。**
理由：用户中断时手指常连按两下；若空闲态一击即退，中断后紧接着的第二次按键会直接送命。
取舍：改变现有「一击退出」习惯（成本：一行提示）；换来误触防护。窗口 3s，超时自动复位。
被否决项：空闲态仍一击退出（无法防护误触）；`SIGINT` 一律忽略只允许 `/exit`（破坏现有习惯，且用户会以为卡死）。

**D3｜中断收尾中（已 abort、run 未返回）的 Ctrl+C 一律忽略并提示「正在停止…」。**
即 `aborting === true` 时任何后续 Ctrl+C 都不退出、不重复 abort。这是「连按两下也不退出」的关键闸门。
被否决项：第二次立即强退（会丢掉已生成的收尾输出，且与 D2 的防误触目标冲突）。

**D4｜中断后的上下文策略：保留部分输出（已选定 B，2026-10-29 用户确认）。**
- ~~A 回滚：本轮当作没发生~~（未采纳：用户已读到的半截回答不应凭空消失，与 WebUI `/stop` 语义也应一致）。
- **B（采用）保留部分输出，与 API 一致：** CLI 侧拿到 `AgentAbortedError.partial` 后，用 `sealPendingToolCalls` 为未响应的 `tool_call` 补合成 tool 消息（保证消息序自洽），落盘为会话内容，并**回写内存基线** `_chatHistory`，使下一轮上下文与磁盘一致；文案改为「已中断（已完成 N 轮 / M 步，已生成内容已保留）」。
  实现要点（三处配套，缺一不可）：
  1. `sealPendingToolCalls` 从 `src/api/abort-utils.ts` **下移到 `src/agent/abort-utils.ts`**（`api/abort-utils.ts` 保留 `export { sealPendingToolCalls } from '../agent/abort-utils.js'`，API 侧零改动）；
  2. `ReActAgent` 新增公共方法 `adoptHistory(messages)`：内部过滤 system 与 `is_compact===true` 后经 `repairMessageSequence` 修复再写入 `_chatHistory`（`restoreSession` 同款口径），供 CLI 中断后回写基线；
  3. CLI 侧落盘用 `updateSession(id, sealed, undefined, { transcript })`（已有会话）或 `createSession(...)`（本轮才建会话），以 store 归一化结果作为最终基线。
  风险与对策：模型下一轮会看到「半截 assistant + 合成 tool 消息」，故合成 tool 消息文案明确写「（运行已被用户停止，该工具调用未完成）」，让模型知道此前工具未完成而非失败重试。

**D5｜中断提示与输出收尾固定为四步。**
`spinner.stop()` → 补一个换行（`onLLMStream` 中断时 `_thoughtHeaderPrinted` 仍为 true，不补会与后续输出粘在一行）→ 打印 `⏹ 已中断（已完成 N 轮迭代 / M 步工具；本轮不计入上下文）`（灰色，文案随 D4 选择调整）→ `safePrompt()`。
被否决项：静默中断（用户无法判断「是停了还是卡了」）。

**D6｜y/N 确认中的 Ctrl+C = 取消确认（等价回答 `n`），不中断 run、不退出。**
`confirming === true` 时 `askConfirm` 的 promise 以 `false` 收尾，主循环继续。
被否决项：确认中也 abort run（用户只是想撤回答，不该顺手把任务杀掉）。

**D7｜退出链路与 Dreaming 保持现状，仅新增「Dreaming 期间 Ctrl+C 立即强退」。**
空闲退出仍走 `disconnectAll()` → `rl.close()` → Dreaming → `exit(0)`（`start.ts:362-381` 不动）；`exiting === true`（close 已发生）期间再按 Ctrl+C 直接 `process.exit(0)`，与 `api/bootstrap.ts` 二次信号强退语义对齐。
被否决项：完全屏蔽 Dreaming 期间的 Ctrl+C（长晋升会让人以为进程死了（用户已经在抱怨这一点））。

**D8｜必须搬动 `sealPendingToolCalls`（因 D4 选 B）；但保持 API 侧引用零改动。**
新位置 `src/agent/abort-utils.ts`（不依赖 `api/` 层，CLI 与 API 共用）；`src/api/abort-utils.ts` 改为单行 re-export，`handlers/messages.ts` 的 import 路径与行为均不变。
被否决项：CLI 直接 `import` `src/api/abort-utils.js`（CLI 反向依赖 API 层，分层污染）。

**D9｜非 TTY 与 `--serve` 行为一字不改。**
`--serve` 的 `SIGINT` 关停链在 `api/bootstrap.ts:163`，与本任务无关；`index.ts:38` 分支不变。

**D10｜Windows Ctrl+Break（`SIGBREAK`）不处理，列为演进项。**
readline 不 emit `SIGBREAK`，需另接 `process.on('SIGBREAK')` 才能覆盖；本任务只做 Ctrl+C（用户实际用法），避免顺带改退出语义。

---

## 三、任务详细设计

### 3.1 `src/cli/interrupt.ts`（新增，纯逻辑）

```ts
export interface SigintState {
  running: boolean;      // 有任务在跑（指令或 agent.run）
  aborting: boolean;     // 已 abort、run 尚未返回（收尾中）
  confirming: boolean;   // y/N 确认中
  exiting: boolean;      // rl 已 close（Dreaming 收尾中）
  abortable: boolean;    // 本轮是否持有 AbortController（普通提问为 true，命令执行为 false）
}

export type SigintAction =
  | 'abort-run'      // 中断当前回答
  | 'ignore-busy'    // 命令执行中 / 正在停止
  | 'cancel-confirm' // 取消 y/N 确认
  | 'force-exit'     // Dreaming 期间强退
  | 'arm-exit'       // 空闲第一次：开退出窗口
  | 'exit';          // 空闲第二次（窗口内）：退出

export function decideSigint(s: SigintState): SigintAction;
```

优先级顺序（自上而下短路）：`exiting → force-exit`；`confirming → cancel-confirm`；`aborting → ignore-busy`；`running && abortable → abort-run`；`running → ignore-busy`；空闲 → `arm-exit | exit`（由调用方持有窗口状态，函数只负责归类，窗口判定用第二个纯函数 `resolveExitArm(lastArmAt, now, windowMs)`）。

### 3.2 `src/cli/start.ts` 改动点

1. **新增状态**：`let currentRun: { controller: AbortController } | null = null;`、`let aborting = false;`、`let exitArmedAt = 0;`、`const EXIT_WINDOW_MS = 3000;`。
2. **普通提问分支**（现 338-345 行）：创建 `AbortController`，`agent.run(input, { verbose, spinner, signal: currentRun.controller.signal })`；`finally` 里 `currentRun = null; aborting = false;`。
3. **新增 `abortRun()`**：`if (aborting) return;` → `aborting = true; currentRun?.controller.abort();`（幂等，只 abort 一次）。
4. **重写 `rl.on('SIGINT')`**：`switch (decideSigint(state))` 六分支，行为严格对齐 D2/D3/D5/D6/D7。
5. **`rl.on('line')` 里 agent 调用处 catch 增加 `AgentAbortedError` 分支**：D5 四步收尾 + 跳过「完成统计」打印；D4-A 时执行磁盘 best-effort 回写。
6. **`askConfirm`**：确认期间被 Ctrl+C 取消时以 `false` resolve（内部 `pendingCancel` 标志，避免未 settle 的 promise 泄漏）。

### 3.3 D4-B 的封口与落盘（best-effort）

```
catch (e) {
  if (e instanceof AgentAbortedError) {
    const partial = e.partial ?? { messages: [], transcript: [], iterations: n, steps: [] };
    const sealed   = sealPendingToolCalls(partial.messages);      // 补合成 tool 消息
    const sealedTx = sealPendingToolCalls(partial.transcript);    // 完整轨迹同样封口
    // 1) 磁盘：有会话 id 走 updateSession，首轮走 createSession
    //    返回值是 store 归一化后的全量消息（含 system/is_compact 标记）
    // 2) 内存：agent.adoptHistory(normalized) → 下一轮基线与磁盘一致
    // 任一步失败只打灰字 warning，不阻塞回到 prompt
  }
}
```

要点：
- 封口必须**同时作用于 `messages` 与 `transcript`**，否则 transcript 归档时仍会带孤立 `tool_calls`。
- `createSession` 需要 `firstMessage`（本轮原始用户输入），用于会话标题；首轮中断也应有标题。
- `partial.steps` / `iterations` 用于中断摘要里的「N 轮 / M 步」。
- 落盘与回写均 best-effort：`sessionStore` 为空（`session.autoSave` 关闭）时静默跳过，仅回写内存。

### 3.4 边界与错误处理

| 场景 | 行为 |
|---|---|
| 中断发生在 LLM 流式中 | SDK 请求被 abort → `AgentAbortedError` → D5 收尾 |
| 中断发生在工具执行中（含 `commandRun` 前台命令） | `raceAbort` 立即抛；Windows 下子进程树被杀（现有能力） |
| 中断发生在后台任务中 | **不终止**后台任务（沿用既有 D10 语义「会话取消不连带终止后台任务」），仅停止本轮等待 |
| abort 后 agent 仍抛非 abort 错误 | 走现有 `[Error]` 分支，不吞错 |
| 中断后立刻再提问 | `running=false` 已复位、`_chatHistory` 干净 → 正常执行 |
| `sessionStore` 回写失败 | 灰色 warning + 继续，不退出 |
| 非 TTY | 无 `SIGINT` 事件，逻辑不被触发 |

### 3.5 演进项（本任务不做）

- Windows `SIGBREAK`（Ctrl+Break）中断与强退语义。
- ESC 键中断（需 `keypress` + raw mode，会与 readline 行编辑冲突）。
- 中断后「撤销/重放」半截输出的交互式选择（当前由 D4 一次性定策略）。
- WebUI 侧「中断」按钮与 CLI 行为的统一文案。

---

## 四、实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P0** | `interrupt.ts` 纯函数 + `sealPendingToolCalls` 下移 + `start.ts` 状态与 signal 接线 + SIGINT 六分支 + `AgentAbortedError` 收尾（D1/D3/D5/D8） | Ctrl+C 可中断、不退出、能继续提问 |
| **P1** | 空闲双击退出（D2）+ 确认中取消（D6）+ Dreaming 强退（D7）+ D4-B 封口落盘与 `adoptHistory` 内存回写 + 重复按键幂等 | 全部分支闭环、误触安全、磁盘内存一致 |
| **P2** | 单测（`decideSigint` 全分支 + 窗口判定 + `sealPendingToolCalls`）+ `tsc --noEmit` + 全量 `vitest run` + README 双语与帮助说明 + 人工真机验证 | 文档、测试、验收记录 |

---

## 五、文件清单

| 文件 | 改动 | 阶段 |
|---|---|---|
| `src/cli/interrupt.ts` | **新增**：`decideSigint` / `resolveExitArm` 纯函数与类型 | P0 |
| `src/cli/start.ts` | 新增 run 级 `AbortController`、`aborting/exitArmed` 状态、SIGINT 六分支、abort 收尾与 D4-B 落盘回写 | P0/P1 |
| `src/agent/abort-utils.ts` | **新增**：`sealPendingToolCalls` 从 `api/` 下移（CLI/API 共用） | P0 |
| `src/api/abort-utils.ts` | 改为单行 re-export（引用方零改动） | P0 |
| `src/agent/react-agent.ts` | 新增公共 `adoptHistory(messages)`，供中断后回写内存基线 | P1 |
| `tests/cli-interrupt.test.ts` | **新增**：分派矩阵单测（含竞态优先级）+ 退出窗口单测 | P2 |
| `src/ui/renderer.ts` | 使用说明补「Ctrl+C：回答中中断本次回答，空闲时连按两次退出」 | P2 |
| `README.md` / `README.en.md`、`docs/readme/zh/*` / `docs/readme/en/*` | 交互说明同步（中英双语） | P2 |
| `docs/requirements/需求.md` | 已登记（20261029-001），完成后回填「是 + 完成时间」 | P2 |

---

## 六、任务验收清单

### 6.1 P0

- [x] 模型流式回答中按 Ctrl+C：进程**不退出**，输出停止，打印中断提示，回到 `Agent>` 提示符
- [x] 中断后立即输入新问题：正常回答，无 400 `tool must be response to preceding tool_calls`
- [x] 工具执行中（如 `commandRun` 前台命令）按 Ctrl+C：命令终止，本轮中断，进程存活
- [x] 中断时 `spinner` 已停止，无残留动画与粘行输出

### 6.2 P1

- [x] 空闲态按一次 Ctrl+C：打印「再按一次 Ctrl+C 退出」，进程仍在
- [x] 空闲态 3s 内按第二次：正常退出（含 Dreaming 与告别文案）
- [x] 空闲态首次提示后 3s 再按：重新计数，仍不退出
- [x] 回答中连按两次 Ctrl+C：仅中断一次，第二次提示「正在停止…」，**进程不退出**
- [x] y/N 确认中按 Ctrl+C：确认被取消（视为 `n`），run 继续或命令安全中止，进程不退出
- [x] Dreaming 收尾中按 Ctrl+C：立即退出，不等待晋升完成
- [x] 中断后 `--resume`/会话列表查看：**能看到**半截回答，且**无孤立 `tool_calls`**（消息序自洽，D4-B 生效）
- [x] 中断后继续追问：模型能看到前面的半截内容与「已停止」的合成 tool 消息，不报 400

### 6.3 P2

- [x] `tests/cli-interrupt.test.ts` 覆盖 `decideSigint` 全部 6 种动作与优先级顺序（含 `aborting` 覆盖 `running`）
- [x] `tests/cli-interrupt.test.ts` 覆盖 `sealPendingToolCalls`（孤立 tool_call 补合成消息、已响应不重复补）+ `adoptHistory` 过滤 system/is_compact
- [x] `tests/react-abort.test.ts` 6.2.8 流式中断保留半截 assistant（D4-B）、6.2.9 `run()` 的 `signal` 必须透传到 `chatStream`
- [x] `npx tsc --noEmit` 0 错误
- [x] `npx vitest run` 全量通过：128 文件 / 1565 用例（137.09s）
- [x] README 中英双语与 `/help` 已说明 Ctrl+C 两态语义
- [x] 需求台账回填「是否完成=是 + 完成时间」

### 6.4 人工验证（真实终端，必须真按键盘）

- [x] 真实终端验证「回答中中断 → 继续追问」（用 node-pty 伪终端驱动 CLI + 本地假 LLM，脚本 `temp/pty-verify-tool.mjs`，17/17 断言通过）
- [x] 长回答（>30s 流式）中断，确认提示行与后续输出不粘行（同样由伪终端脚本覆盖：流式第 5 段后 Ctrl+C，提示行独立成行）
- [x] 中断后退出 CLI，Dreaming 正常执行，`~/.loop-agent/memory/**` 无异常（脚本使用隔离 HOME，退出链路完整跑完并打印告别文案）
- [x] `--serve` 模式 Ctrl+C 行为与今天一致（本任务未改 `api/bootstrap.ts` 与 `api/abort-utils.ts` 出口，API 侧 7 个 `/stop` 用例全通过）

### 6.5 完成记录

**实施完成：2026-10-29**

| 文件 | 改动 |
|---|---|
| `src/cli/interrupt.ts` | 新增 `decideSigint` / `resolveExitArm` / `EXIT_WINDOW_MS`（六态分派纯函数） |
| `src/cli/start.ts` | run 级 `AbortController` + `aborting/confirming/exitArmed` 状态、SIGINT 六分支、`handleAborted`（封口 → 落盘 → `adoptHistory` → 摘要） |
| `src/agent/abort-utils.ts` | `sealPendingToolCalls` 由 `src/api/` 下移至 agent 层（`src/api/abort-utils.ts` 保留 re-export，API 引用零改动） |
| `src/agent/react-agent.ts` | `streamLLM` 透传 `options.signal`；循环内 `throwIfAborted` 防御；`streamedText` 累积已流出文本，换绑时补一条纯文本 `assistant`（D4-B：半截回答可落盘、不产生孤立 `tool_calls`） |
| `src/ui/renderer.ts` | `/help` 增「Ctrl+C 回答中仅中断本次回答；空闲连按两次退出」 |
| `tests/cli-interrupt.test.ts` | 新增：`decideSigint` 全分支 + 优先级、`resolveExitArm` 窗口边界与时钟回拨、`sealPendingToolCalls`、`adoptHistory`（共 16 用例） |
| `tests/react-abort.test.ts` | 新增 6.2.8（流式中断保留半截 assistant）、6.2.9（`signal` 透传到 `chatStream`） |
| `tests/api-stop-endpoint.test.ts` | `waitFor` 轮询间隔 10ms→50ms（满负载下 GET 风暴与落盘写盘争盘，曾致 6.2.6 误报 15s 超时） |
| `README.md` / `README.en.md` | 功能表新增「⏹️ Ctrl+C 两态中断」 |
| `docs/readme/zh/cli-usage.md` / `docs/readme/en/cli-usage.md` | 内置命令表新增 `Ctrl+C` 两态说明，`exit` 行改为「连按两次同样有效」 |

**真机验证方式（关键补充）**：CLI 的 Ctrl+C 无法用单元测试覆盖，本任务用 `@lydell/node-pty` 起伪终端驱动真实 CLI 进程 + 本地假 OpenAI 服务（`temp/pty-verify-tool.mjs`），断言 17 条：

1. 工具执行中（`commandRun` 跑 `Start-Sleep 45`）按 Ctrl+C → 打印「正在停止」→「已中断」→ 进程存活；
2. 长命令子进程树被清理（`Get-CimInstance` 统计 `Start-Sleep -Seconds 45` 残留数 = 0）；
3. 落盘会话含 `assistant(tool_calls)` 且每个 `tool_call` 都有 `tool` 响应（封口生效）；
4. 中断后再次提问 → 新请求正常发出（无 400）；
5. 流式中断后落盘会话保留半截 `assistant`，且位于 `user` 之后、顺序合法（D4-B）；
6. 空闲态连按两次 Ctrl+C 正常退出（`exitCode=0`）。

**回归**：`npx tsc --noEmit` 0 错误；`npx vitest run` 128 文件 / 1565 用例全通过（137.09s）。首轮全量曾出现 `api-stop-endpoint.test.ts` 6.2.6 超时误报，单独复跑 1s 通过，判定为满负载下轮询风暴所致，已按根因调低轮询频率后复跑三文件 31 用例全通过。

---

## 七、修订历史

| 日期 | 变更 |
|---|---|
| 2026-10-29 | 初始方案（D1–D10），待用户确认 |
| 2026-10-29 | 用户确认 **D4 选 B**（保留部分输出、封口落盘），其余按推荐；D8 随之翻转为「必须下移 `sealPendingToolCalls`」，补 3.3 封口落盘设计、`adoptHistory` 回写与文件清单 |
| 2026-10-29 | 实施完成（P0/P1/P2 全通过）：补 `streamLLM` 的 `signal` 透传（流式真正可中断）、流式中断时把已流出文本补为纯文本 `assistant`（D4-B 落盘可见半截回答）、伪终端真机验证 17 条断言全通过、全量回归 128 文件 / 1565 用例通过 |
