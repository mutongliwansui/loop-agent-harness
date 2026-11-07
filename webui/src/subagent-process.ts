// 子 Agent 过程区渲染的纯逻辑（需求 20261107-003）
//
// 约束：无 DOM 依赖，root vitest 可直接单测；仅做数据整形与文案，
// 复用 tool-meta 的中文名/图标/语义摘要，避免与主对话视觉漂移。

import { TOOL_ICON_PATHS, toolDisplay, toolSummary, type ToolIconKey } from './tool-meta.js';

/** 过程区可见状态（结果卡片可能把 running 覆盖为 interrupted） */
export type ProcessStatus = 'running' | 'done' | 'failed' | 'aborted' | 'interrupted';

/** 与后端 SubAgentTrace / chat-stream SubAgentTraceVM 对齐的最小形状 */
export interface ProcessTrace {
  status: ProcessStatus;
  iterations: number;
  think: { iteration: number; text: string }[];
  tools: {
    name: string;
    args?: Record<string, unknown>;
    elapsedMs?: number;
    ok?: boolean;
    iteration?: number;
    result?: string;
  }[];
  final?: string;
  startedAt: number;
}

/** 工具行展示态：ok=成功、fail=失败、run=进行中 */
export type ProcessToolState = 'ok' | 'fail' | 'run';

export interface ProcessThinkRow {
  key: string;
  text: string;
  /** 文本预计超过 3 行：显示「展开」入口 */
  long: boolean;
}

export interface ProcessToolRow {
  key: string;
  name: string;
  zh: string;
  iconSvg: string;
  brief: string;
  elapsedMs?: number;
  state: ProcessToolState;
  result?: string;
}

export interface ProcessIteration {
  n: number;
  think: ProcessThinkRow[];
  tools: ProcessToolRow[];
}

/** 秒数格式化（与 ToolCard 既有 `fmtSecs` 口径一致） */
export function fmtSecs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** 思考文本是否超过 3 行（用于「展开」按钮显隐；CSS 仍用 line-clamp 兜底） */
function isLongThink(text: string): boolean {
  const lines = text.split('\n').length;
  return lines > 3 || text.length > 140;
}

/** 工具行状态：失败优先，其次「未拿到结果且仍在运行」 */
export function processToolState(step: ProcessTrace['tools'][number], live: boolean): ProcessToolState {
  if (step.ok === false) return 'fail';
  if (live && step.result === undefined) return 'run';
  return 'ok';
}

/** 过程区标题元信息：N 轮 · N 步 · 耗时 */
export function processMeta(trace: ProcessTrace, elapsedMs?: number): string {
  const iterations = Math.max(
    1,
    trace.iterations,
    ...trace.think.map((x) => x.iteration),
    ...trace.tools.map((x) => x.iteration ?? 0),
  );
  const ms =
    typeof elapsedMs === 'number' && elapsedMs > 0
      ? elapsedMs
      : Math.max(0, Date.now() - trace.startedAt);
  return `${iterations} 轮 · ${trace.tools.length} 步 · ${fmtSecs(ms)}`;
}

/** 按迭代分组：思考与工具都归入所属轮次；缺少 iteration 的工具归到当前轮 */
export function groupProcessIterations(trace: ProcessTrace, status?: ProcessStatus): ProcessIteration[] {
  const live = (status ?? trace.status) === 'running';
  const max = Math.max(
    1,
    trace.iterations,
    ...trace.think.map((x) => x.iteration),
    ...trace.tools.map((x) => x.iteration ?? 0),
  );
  const out: ProcessIteration[] = [];
  for (let n = 1; n <= max; n++) {
    const think = trace.think
      .filter((x) => x.iteration === n)
      .map((x, i): ProcessThinkRow => ({ key: `${n}-th-${i}`, text: x.text, long: isLongThink(x.text) }));
    const tools = trace.tools
      .filter((x) => (x.iteration ?? n) === n)
      .map((x, i): ProcessToolRow => {
        const d = toolDisplay(x.name);
        return {
          key: `${n}-tl-${i}`,
          name: x.name,
          zh: d.name,
          iconSvg: iconSvgFor(d.icon),
          brief: toolSummary(x.name, safeJson(x.args)),
          elapsedMs: x.elapsedMs,
          state: processToolState(x, live),
          result: x.result,
        };
      });
    out.push({ n, think, tools });
  }
  return out;
}

/** 过程区结论文本：trace.final 优先，其次外部传入的 answer */
export function processFinal(trace: ProcessTrace, answer?: string): string {
  return (trace.final || answer || '').trim();
}

/** 安全 stringify：循环引用/异常回退空串，避免整块渲染崩掉 */
function safeJson(args?: Record<string, unknown>): string {
  if (!args) return '';
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

/** 图标 SVG：复用 tool-meta 的路径常量，避免在组件里重复拼字符串 */
function iconSvgFor(key: ToolIconKey): string {
  return (
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"' +
    ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICON_PATHS[key]}</svg>`
  );
}
