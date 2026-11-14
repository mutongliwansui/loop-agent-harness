# 任务：editFile 行尾归一化与同文件并发写保护

> 对应需求编号：20261022-002（优化建议台账）
> 方案确认：2026-10-23，D1~D6 按推荐项经用户确认（「按你的建议来，开始吧」）

## 一、任务目标需求

### 1.1 背景（痛点）

Task-20261022-002（commandRun 后台运行）实施过程中 editFile 多次匹配失败，复盘定位三类工具侧问题：

1. **行尾敏感**：`oldText` 按 `\n` 字面匹配，而仓库存在 CRLF/混合行尾文件（实测 `src/runtime/init.ts` CRLF=89/LF=3），多行 oldText 必然失配（单行锚点可绕过）；写回按 LF 写入、不探测原文件主导行尾，导致混合行尾进一步恶化（git 反复出现 CRLF→LF 警告）。
2. **同文件并发写无保护**：同一轮并行对同一文件发多个 editFile（或与 fileWrite 组合）时，出现 oldText 与文件实际内容完全一致仍报「未找到文本」的竞态失败（读-改-写窗口被其他写操作插入）。
3. **失败信息弱**：仅报「未找到文本」，不给出首个不匹配行或最相似候选片段，只能盲猜重试。

另记录流程教训：PowerShell 管道（Add-Content/Get-Content）传输含中文内容会因 GBK 解码产生乱码并破坏引号，中文文件改动一律走 fileWrite/editFile。

### 1.2 现状梳理

| 所需能力 | 框架现状 | 结论 |
| --- | --- | --- |
| 行尾归一化匹配 | `file:///D:/trae_workspace/loop-agent-command/src/tools/editFile.ts` 三种模式（字面量/正则/行范围）均按 `\n` 字面处理，无任何 `\r` 感知 | 需新增归一化匹配与写回适配 |
| 写回保持原行尾 | `writeFile(path, updated, 'utf-8')` 直接写回，未触及区域行尾随全文处理方式被动改变 | 需偏移映射写回，字节级保留未触及区域 |
| 同文件并发保护 | `file:///D:/trae_workspace/loop-agent-command/src/tools/runner.ts` `runParallel` 用 `Promise.all` 并行；20261021-010 后跨会话/跨空间并发已放开，editFile/fileWrite 是模块级单例 Tool，无任何互斥 | 需进程内 perPath 串行队列 |
| 并发冲突诊断 | 无 mtime 记录，失配时不区分「文本真的不存在」与「文件刚被改」 | 需记录本进程写后 mtime，失配时对比 |
| 失败信息增强 | 报错仅一句「未在 xxx 中找到要替换的文本」 | 需首个差异行 + 近似候选 |
| fileRead 输出 | `file:///D:/trae_workspace/loop-agent-command/src/tools/fileRead.ts` 按行展示（`\r` 不显示），模型由此产生「文件是 LF」的预期，是失配的直接诱因 | 只读工具不改 |

### 1.3 任务目标

1. editFile 字面量/行范围模式：oldText 与文件内容统一按行尾归一化匹配，写回字节级保留未触及区域、替换段适配文件主导行尾；
2. editFile 全模式 + fileWrite 全模式：同文件写操作经进程内串行队列互斥；
3. 字面量失配时：区分「文件已被并发修改」（mtime 对比）与「文本不存在」（首个差异行 + 近似候选）；
4. fileWrite：已存在文件 overwrite/append 适配主导行尾，新文件保持 LF；
5. 全量回归绿，双语文档同步。

### 1.4 设计约束

- 零新依赖（`node:` 内置模块即可）；
- 不改变 editFile 参数 schema 与正则模式匹配语义（schema 向后兼容）；
- 只改 `src/tools` 内聚范围；fileRead/grep 只读不涉及；
- 跨进程文件锁（MCP 工具写文件）为演进项不做。

## 二、方案设计

### 2.1 总体思路

```
LLM oldText(通常 LF，因 fileRead 按行输出不显示 \r)
      │
editFile.execute ──┐
fileWrite.execute ─┤
      │            ▼
      │   file-lock.ts：perPath 串行队列（模块级 Map<规范路径,Promise 尾链>，
      │                锁内全程「读→匹配→写」，同物理文件全局排队）
      ▼
  readFile 原始内容
      │  detectEol(主导行尾：CRLF 数 > LF 数 → CRLF)
      ▼
  归一化副本(\r\n→\n) ←→ oldText 归一化
      │  匹配成功 → 偏移映射回原内容，仅替换目标段(未触及字节原样保留)
      │  匹配失败 → mtime 对比：变了→「已被并发修改，请 fileRead 后重试」
      │            没变→「未找到」+ 首个差异行 + 近似行片段
      ▼
  adaptEol(newText, 主导行尾) → writeFile → 登记 mtime → 释放锁
```

### 2.2 关键设计决策

- **D1 仅字面量与行范围模式做行尾归一化匹配，正则模式匹配语义保持现状**：本次三类事故全在字面量模式；正则的 `\r`/`m` 标志语义由用户显式控制，归一化会改变语义。补充细节：正则模式替换文本 `newText` 的行尾仍做 adaptEol 适配（只统一输出风格，不影响匹配）。被否决项：正则也归一化匹配（风险大收益小）。
- **D2 写回用偏移映射，字节级保留未触及区域**：归一化副本上 indexOf 定位 → 映射回原内容切片 → 仅目标段替换为 `adaptEol(newText, 主导行尾)` 后的内容；replaceAll 从左到右收集全部匹配区间后一次拼装。备选「全文重建+统一主导行尾」实现更简单，但正是 Claude Code #62713 被重度投诉的行为（悄悄改掉混合行尾文件的未触及区域），否决。
- **D3 fileWrite 行尾适配：新文件写 LF（与仓库主体一致），已存在文件 overwrite/append 把 content 换行统一到该文件主导行尾，不做配置项**。被否决项：Aider 式 platform/lf/crlf 配置（当前无多场景诉求）；完全透传（append LF 到 CRLF 文件产生混合行尾，正是本次恶化根源）。
- **D4 同文件写串行化**：新增 `src/tools/file-lock.ts`，模块级 `Map<规范路径, Promise 尾链>`，editFile 全模式 + fileWrite overwrite/append 进锁，`try/finally` 释放；按物理绝对路径（Windows 小写化）作 key，天然覆盖跨工作空间/跨会话并发。被否决项：不串行化只靠重试（静默竞态即事故根因）；跨进程锁列为演进项。
- **D5 mtime 仅作失配诊断，不无条件硬失败**：归一化匹配成功直接替换（锁内读-改-写，内容唯一匹配时操作本身安全，不因 mtime 变化误报）；匹配失败时对比 `stat.mtimeMs` 与本进程上次写记录（模块级 `Map<path, mtimeMs>`，容差 1ms）——变了→报「文件已被并发修改，请 fileRead 后重试」，没变→报「未找到」+ 定位信息。被否决项：mtime 一变就硬失败（会撞上 Claude Code #13456 把行尾问题误判为外部修改的坑）。
- **D6 失配信息增强**：①最长公共前缀定位首个差异行（行号 + 期望/实际行内容，trim 掉 `\r`）；②近似候选：oldText 首行（trim 后 ≥8 字符）在文件中的命中行 ±2 行上下文，最多 3 处；正则失配不做增强（「接近」无自然定义）。被否决项：Levenshtein 全文相似度（过度设计）。

### 2.3 联网检索结论（2026-10-23）

| 来源 | 结论/借鉴 |
| --- | --- |
| Claude Code #164、#27718 | 与本项目完全同病：CRLF 文件多行 oldText 字面匹配必失败；修复方向即「归一化匹配 + 保留原行尾写回」 |
| Claude Code #13456 | 教训：只归一化匹配、写回不保留，会误报「File has been unexpectedly modified」——两者必须成对做 |
| Claude Code #62713、#100983 | 教训：全文统一行尾会悄悄改掉混合行尾文件未触及区域——应字节级保留未触及内容 |
| Claude Code #60894 | 「内容一致仍失配、重试成功」= stale 竞态，与本次现象一致；「已被并发修改，请重读」是成熟报错先例 |
| OpenCode fix-line-endings 插件 | 行尾检测矩阵：主导行尾判定、含 NUL 视为二进制不碰 |
| Aider #1102 / PR #2856 | platform/lf/crlf 配置项——本项目暂不需要（零配置优先） |

## 三、任务详细设计

### 3.1 `src/tools/line-endings.ts`（新增）

```ts
export type Eol = '\n' | '\r\n';
export function detectEol(content: string): Eol;            // 主导行尾：CRLF 数 > LF 数 → CRLF
export function adaptEol(text: string, eol: Eol): string;   // 换行统一为指定行尾
export function normalizeEol(text: string): string;         // \r\n → \n（匹配用）
export interface FirstDiff { line: number; expected: string; actual: string; }
export function firstDiffLine(contentNorm: string, oldNorm: string): FirstDiff | null;
export function similarCandidates(
  contentNorm: string, oldNorm: string, contextLines?: number, maxHits?: number,
): string[];  // oldText 首行（trim ≥8 字符）命中行 ±2 行，最多 3 处
export function replaceNormalized(
  content: string, oldText: string, newText: string, replaceAll: boolean,
): { updated: string; count: number; eol: Eol } | null;  // null = 未匹配
//   实现：归一化定位 → 偏移映射回原内容（前置 \r 计数）→ 仅目标段替换 adaptEol(newText, eol)
export function recordWriteMtime(absPath: string, mtimeMs: number): void; // 写成功后登记
export function getRecordedMtime(absPath: string): number | undefined;    // 失配诊断用
```

边界与错误处理：无换行文件 detectEol 返回 `'\n'`、adaptEol 原样返回（安全 no-op）；偏移映射基于「归一化仅删除 CRLF 中的 `\r`」这一单调前提，O(n) 累计计数；replaceAll 收集区间后一次前向拼装，避免循环内索引漂移。

### 3.2 `src/tools/file-lock.ts`（新增）

```ts
export async function withFileLock<T>(absPath: string, fn: () => Promise<T>): Promise<T>;
```

- 模块级 `Map<key, Promise 尾链>`；key = `path.resolve()` 后 Windows 小写化；
- 尾链永不 reject（fn 错误在调用方 try/catch，gate 由 release resolve），防御性 `catch(() => {})`；
- 释放时若尾链仍指向本次 gate 则删除 entry（Map 不无限增长）。

### 3.3 `src/tools/editFile.ts`（改造）

- `execute` 整体包 `withFileLock(path, ...)`；
- 字面量模式：改用 `replaceNormalized()`；失配时按 D5/D6 组装错误信息；
- 行范围模式：oldText 校验用归一化比较；`newText` 先 `adaptEol(dominantEol)` 再 `split('\n')`，未触及行 `\r` 保留在行尾，`join('\n')` 后字节级正确；
- 正则模式：匹配不动；`content.replace(re, adaptEol(newText, dominantEol))` 统一输出行尾；
- 三种模式写成功后 `recordWriteMtime()`。

边界与错误处理表：

| 场景 | 行为 |
| --- | --- |
| CRLF 文件 + LF 多行 oldText | 归一化匹配成功，替换段写回 CRLF |
| 混合行尾文件 | 未触及区域字节级不变，替换段用主导行尾 |
| 归一化仍失配 + mtime 变了 | 报「文件已被并发修改（mtime 变化），请 fileRead 后重试」 |
| 归一化仍失配 + mtime 未变 | 报「未找到」+ 首个差异行 + 近似候选 |
| 归一化后多处匹配 | 保持现有多处报错语义（计数基于归一化内容） |

演进项（本任务不做）：跨进程文件锁；oldText 首行 <8 字符时的近似候选降级策略；Aider 式行尾配置项。

### 3.4 `src/tools/fileWrite.ts`（改造）

- `execute` 包 `withFileLock`；锁内 stat 判定文件是否存在；
- 不存在 → mkdir + 原样写入（LF）；已存在 → 读原内容 detectEol → content adaptEol 后 overwrite/append；
- 写成功后 `recordWriteMtime()`；返回信息注明行尾适配情况。

## 四、实施计划

| 阶段 | 内容 | 交付物 |
| --- | --- | --- |
| P0 核心链路 | line-endings.ts + file-lock.ts；editFile 字面量模式归一化匹配与偏移写回；editFile/fileWrite 进锁 | 两个新模块 + 两个工具改造，核心场景可跑 |
| P1 生命周期与边界 | mtime 并发诊断；失配信息增强；行范围/正则模式行尾适配；fileWrite 行尾适配 | 全模式覆盖 |
| P2 收口 | description 更新；`docs/readme/zh+en/built-in-tools.md` 同步；`npx tsc --noEmit` + `npx vitest run` 全量回归；台账回填 | 文档 + 测试报告 + 台账置完成 |

## 五、文件清单

| 文件 | 改动 | 阶段 |
| --- | --- | --- |
| `src/tools/line-endings.ts` | 新增：行尾检测/适配/归一化替换/差异定位/mtime 登记 | P0 |
| `src/tools/file-lock.ts` | 新增：perPath 串行队列 | P0 |
| `src/tools/editFile.ts` | 改造：进锁 + 字面量归一化匹配写回 + 失配诊断 + 行范围/正则行尾适配 | P0/P1 |
| `src/tools/fileWrite.ts` | 改造：进锁 + 行尾适配 | P0/P1 |
| `tests/edit-file-lineendings.test.ts` | 新增约 13 用例 | P0/P1 |
| `tests/file-write-lock.test.ts` | 新增约 8 用例 | P0/P1 |
| `docs/readme/zh/built-in-tools.md` | editFile/fileWrite 条目更新 | P2 |
| `docs/readme/en/built-in-tools.md` | 同上（英文） | P2 |
| `docs/optimization_suggestions/优化建议.md` | 20261022-002 置完成 | P2 |

## 六、任务验收清单

### 6.1 P0

- [x] detectEol/adaptEol/normalizeEol 单元行为正确（CRLF/LF/混合/无换行）
- [x] 字面量模式：LF oldText 匹配 CRLF 文件成功
- [x] 替换段写回为文件主导行尾
- [x] withFileLock 同文件串行、不同文件并行
- [x] 锁内异常不阻塞后续调用

### 6.2 P1

- [x] 混合行尾文件未触及区域字节级保留
- [x] replaceAll 多处替换索引偏移正确
- [x] 行范围模式：CRLF 文件整段替换行尾风格保持、oldText 校验归一化通过
- [x] 正则模式 newText 行尾适配、匹配语义不变
- [x] fileWrite：overwrite/append 适配主导行尾、新文件 LF
- [x] 归一化仍失配 + mtime 变化 → 并发修改报错
- [x] 归一化仍失配 + mtime 未变 → 未找到 + 首个差异行 + 近似候选
- [x] 20 路并发同文件 editFile 全部成功且内容正确

### 6.3 P2

- [x] `npx tsc --noEmit` 通过
- [x] `npx vitest run` 全量回归通过（含新增 21 用例）
- [x] 双语文档同步
- [x] 优化建议台账 20261022-002 置完成

### 人工验证（真实环境）

- [ ] 真实开发任务中对 CRLF 文件（如 `src/runtime/init.ts`）做多次 editFile 不再失配、git diff 无行尾噪音
- [ ] 同一轮多 tool_calls 并行编辑同一文件场景复现验证
- [ ] Windows 真机 git 不再出现 CRLF→LF 警告

### 完成记录

- 2026-10-23：P0+P1 实施——新增 `src/tools/line-endings.ts`（detectEol/adaptEol/normalizeEol/firstDiffLine/similarCandidates/replaceNormalized/mtime 登记）与 `src/tools/file-lock.ts`（perPath Promise 尾链，Windows 大小写归一 key，空闲自清理）；editFile 三模式进锁，字面量模式归一化匹配+偏移映射写回（修复了「匹配边界后紧跟 \r 被吞」的边界 bug），行范围模式 newText 行尾适配并保留被替换末行行尾，正则模式 newText 行尾适配，失配区分「mtime 变化的并发修改提示」与「未找到+首个差异行+近似候选」；fileWrite 进锁并按存在文件主导行尾适配（新文件保持 LF）。新增 21 用例（13+8）。
- 2026-10-23：P2 收口——`npx tsc --noEmit` 通过；全量回归 93 文件 974 用例，973 过，唯一失败 `api-stop-endpoint.test.ts`「6.2.6 停止后落盘」（waitFor 5s 超时，全量负载下时序 flaky，单独复跑 7/7 通过，与本次改动无关——该用例不涉及文件写工具）；新增测试 21/21 绿；双语文档（zh/en built-in-tools.md）同步；优化建议台账 20261022-002 置完成；中文提交并推送。

## 修订历史

- 2026-10-23：创建任务文档，D1~D6 经用户确认（按推荐项）。
- 2026-10-23：P0+P1 实施完成（21 新用例全绿），P2 收口完成。
