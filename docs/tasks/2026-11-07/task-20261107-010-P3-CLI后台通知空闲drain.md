# task-20261107-010 · P3 CLI 后台通知空闲 drain

> 对应需求编号：**20261107-010**（总方案见 [task-20261107-006](./task-20261107-006-后台子任务可感知性与消息重复治理.md) §3.4）
> 来源：实测反馈 —— CLI 模式下后台子任务完成通知仅在下一次输入前打印，用户不输入就永远看不到
> 状态：**已完成（2026-11-07）**（C1 + C1b；C2 不实施，见 §4）
> 优先级：**P3（可选增强）**
> 涉及：`src/cli/start.ts`、`src/agent/react-agent.ts`

## 一、问题与根因

20261107-002 D13 的设计决策：CLI 是行式 REPL、无常驻事件循环，后台完成通知只在「提交时」与「下一次输入前 drain」两个时点打印——**避免与正在输入的行抢光标**。该决策本身正确，但副作用：用户提交后台任务后若不输入，完成通知永远不出现，感知与 WebUI 一样差。

原 drain 点：`src/cli/start.ts` 主循环 `rl.on('line')` 开头，每次读取用户输入前执行。

## 二、目标

在**不破坏输入体验**的前提下，让 CLI 用户在后台任务完成后的有限时间内看到通知。

## 三、实施方案

### 3.1 C1 verbose 门控的空闲轮询 drain

- 门控条件：`cfg.agent.verbose === true` **且** `process.stdout.isTTY === true`（管道/重定向/CI 下不重绘）。
- 1s 间隔定时器：`rlClosed || running || confirming` 时跳过（那些阶段终端由 spinner / y-N 确认掌管，不能抢输出）。
- 队列非空时：`process.stdout.write('\r\x1b[K')` 回到行首并清到行尾，逐条 `console.log`，随后 `rl.prompt(true)` 重绘提示符**并保留已输入草稿**。
  - 相比方案原写的 `pause()/resume()`，`rl.prompt(true)` 更简洁：它正是 readline 官方的「保留光标位置重绘」入口，无需暂停输入流（暂停反而可能吞掉用户按键）。
- `timer.unref()`：定时器不阻止进程退出（增强功能不应成为退出阻塞项）。
- `rl.on('close')` 首行 `stopNoticeDrain()` 清理定时器，退出/Pipe 结束不留悬挂定时器。

### 3.2 C1b 提交提示带引导文案

`react-agent.ts` 后台提交返回值按运行环境给不同引导，解决「用户不知道要回车才能看到结果」：

| 环境 | 追加文案 |
| --- | --- |
| CLI（`consoleMode`） | `（完成通知会在下次回车时打印；/verbose 可实时接收）` |
| WebUI/API | `（完成后结果会自动写回会话，无需等待）` |

### 3.3 C2 提示符内联状态 —— 不实施

`[⚙2] >` 前缀需在每次轮询时重绘提示符，与正在输入的草稿/光标位置交互细节多，且 008 已在 WebUI 侧提供常驻指示器、C1 已在 CLI 提供实时通知；收益边际，保持默认关（等同不实施）。

## 四、决策点汇总

| 编号 | 决策 | 被否决项 |
| --- | --- | --- |
| C1 | verbose 门控空闲 drain + `\r\x1b[K` + `rl.prompt(true)` 重绘 | 默认开启：与输入行冲突风险大，违背 D13 初衷；pause/resume：可能吞按键，prompt(true) 已足够 |
| C1b | 非 verbose 加引导文案（区分 CLI / WebUI） | 不加：用户不知道要回车才能看到结果 |
| C2 | 不实施提示符内联状态 | 默认开启：光标重绘细节多，收益边际 |

## 五、实施清单

| 层 | 文件 | 内容 |
| --- | --- | --- |
| **C1** | `src/cli/start.ts` | `noticeTimer`（1s，verbose+TTY 门控）、`stopNoticeDrain`、清行重绘、`unref`、`rl.on('close')` 清理 |
| **C1b** | `src/agent/react-agent.ts` | 后台提交提示按 `consoleMode` 追加引导文案 |

## 六、测试计划与结果

| 编号 | 用例 | 结果 |
| --- | --- | --- |
| T1 | verbose 下后台完成 → ≤1s 通知打印，输入行不破坏（清行 + `prompt(true)` 重绘） | ✅（真机行为；非 TTY 环境自动禁用，故无自动化断言） |
| T2 | 非 verbose 行为与现状一致（下次输入前打印）+ 提交含引导文案 | ✅（既有 `tests/delegate.test.ts` 后台提交用例不回归） |
| T3 | 空闲 drain 与主循环无竞态：`running`/`confirming` 期间跳过，drain 为 splice 原子取出，不丢不乱序 | ✅ |
| T4 | 回归：`/subagent list/show`、`drainCliNotices` 既有用例通过 | ✅ |

回归：`tsc --noEmit` 0 错误；`vitest run` 全通过。

## 七、验收清单

- [x] verbose 模式下完成通知 ≤1s 可见且不破坏输入（T1）
- [x] 默认模式行为不回归且有引导文案（T2）
- [x] `tsc --noEmit` 0 错误、`vitest` 全通过
