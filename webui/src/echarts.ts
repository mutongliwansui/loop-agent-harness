// echarts.ts：```echarts 代码块 → ECharts 图表后处理（ChatView 对话流与 FilesView md 预览共用）
//
// renderEChartsIn(root) 扫两类挂载点（Task-20261023-002 D3）：
//   1) 槽位 .chart-slot[data-lang=echarts]（主路径）：流式增量渲染的块渲染产物，源码取自
//      data-src；渲染结果 append 到槽位内并打 data-done，**不替换槽位本身**（槽位由 Vue
//      的 v-for 管理，replaceWith 会让 vnode.el 与真实 DOM 失联）。
//   2) pre > code.language-echarts（兼容路径，仅 legacy=true）：整段 v-html 渲染场景。
// 代码块内容必须为合法 JSON option（D4 声明式无执行面）；JSON 非法 / init 失败 → 槽位内
// 保留源码并标红（.echarts-err）且打 data-done 排除重试；动态加载失败同样落源码（D7）。
// 内部串行排队，避免并发初始化。
//
// 尺寸（D4）：初始按视口可用宽 × 320 渲染（SVG 渲染器）；缩放/fit/全屏后经 chart-box 的
// onResize 调 chart.resize()，矢量重绘保持 5x 缩放下清晰。
// 主题（D7）：渲染时读取当前主题（逻辑同 ../mermaid.ts，dark → echarts 内置 dark 主题）；
// MutationObserver 监听 html[data-theme] + matchMedia 监听系统主题，已渲染图表 dispose 后
// 按新主题重建（echarts 主题在 init 时固化，不支持运行时切换）；宿主移出文档的实例顺带清理。

import type { ECharts, EChartsOption } from 'echarts';
import { buildChartBox } from './chart-box.js';

type EChartsModule = typeof import('echarts');

interface RenderedEntry {
  chart: ECharts;
  option: Record<string, unknown>;
}

let echartsPromise: Promise<EChartsModule> | null = null;
let echartsSeq = 0;
let echartsQueue: Promise<void> = Promise.resolve(); // 串行排队，避免并发初始化
const rendered = new Map<HTMLElement, RenderedEntry>(); // 已渲染图表（主题切换重渲 / 泄漏清理）
let themeWatcherStarted = false;

/** 解析 echarts 代码块内容为 option 对象（纯函数，供单测）；空/非法 JSON/非对象返回 null */
export function extractEChartsOption(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 当前主题名（逻辑同 ../mermaid.ts）：手动 data-theme 优先，否则跟随系统；亮色用 echarts 默认主题 */
function currentThemeName(): 'dark' | undefined {
  const t = document.documentElement.dataset.theme;
  return (t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : undefined;
}

/** 主题变化监听（一次性）：data-theme 手动切换 + 系统明暗切换，均对已渲染图表按新主题重建 */
function ensureThemeWatcher(echarts: EChartsModule): void {
  if (themeWatcherStarted) return;
  themeWatcherStarted = true;
  const rerenderAll = (): void => {
    for (const [host, entry] of rendered) {
      if (!host.isConnected) {
        rendered.delete(host); // 视图重渲后旧宿主已移除：顺带清理防泄漏
        continue;
      }
      entry.chart.dispose(); // echarts 主题 init 时固化：换主题必须重建实例
      entry.chart = echarts.init(host, currentThemeName(), { renderer: 'svg' });
      entry.chart.setOption(entry.option as EChartsOption);
    }
  };
  new MutationObserver(rerenderAll).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerenderAll);
}

export interface RenderEChartsOpts {
  /** 同时处理旧 pre>code 形态（整段 v-html 渲染场景）；默认 false */
  legacy?: boolean;
}

export function renderEChartsIn(root: HTMLElement, opts: RenderEChartsOpts = {}): Promise<void> {
  echartsQueue = echartsQueue.then(() => renderBlocks(root, opts));
  return echartsQueue;
}

/** 槽位内失败降级：保留源码并标红（D7），并打 data-done 排除重试 */
function fallbackInSlot(slot: HTMLElement, src: string): void {
  slot.dataset.done = '1';
  slot.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'echarts-err';
  const code = document.createElement('code');
  code.className = 'language-echarts';
  code.textContent = src;
  pre.appendChild(code);
  slot.appendChild(pre);
}

/** 在 slot 内构建图表容器并初始化实例（成功/失败都以槽位为界，不触碰外层 Vue DOM） */
function mountInSlot(
  echarts: EChartsModule,
  slot: HTMLElement,
  src: string,
  option: Record<string, unknown>,
): void {
  const host = document.createElement('div');
  host.className = 'echarts-host';
  try {
    const box = buildChartBox(host, 'echarts', src); // 第三参数启用「预览 ⇄ 源代码」（D6）
    slot.appendChild(box.el);
    const view = box.el.querySelector<HTMLElement>('.mmd-view')!;
    host.style.width = `${Math.max(200, view.clientWidth - 24)}px`; // 24 = .mmd-view 左右 padding
    host.style.height = '320px';
    const chart = echarts.init(host, currentThemeName(), { renderer: 'svg' });
    chart.setOption(option as EChartsOption);
    box.remeasure(); // host 现在有实际尺寸：重测基准并恢复缩放按钮
    box.onResize(() => chart.resize()); // 缩放/fit/全屏后矢量重绘
    slot.dataset.done = '1';
    rendered.set(host, { chart, option });
    ensureThemeWatcher(echarts);
  } catch {
    fallbackInSlot(slot, src); // init/setOption 失败：槽位内标红保留源码
  }
}

async function renderBlocks(root: HTMLElement, opts: RenderEChartsOpts): Promise<void> {
  const slots = [...root.querySelectorAll<HTMLElement>('.chart-slot[data-lang="echarts"]:not([data-done])')];
  const legacy = opts.legacy ? [...root.querySelectorAll<HTMLElement>('pre > code.language-echarts')] : [];
  if (slots.length === 0 && legacy.length === 0) return;
  echartsPromise ??= import('echarts');
  let echarts: EChartsModule;
  try {
    echarts = await echartsPromise;
  } catch {
    // echarts 动态加载失败：槽位内落源码（避免空白），legacy 形态保持原代码块
    for (const slot of slots) if (slot.isConnected) fallbackInSlot(slot, slot.getAttribute('data-src') ?? '');
    return;
  }
  // 清理已移出文档的旧实例（对话流重渲 / 文件切换后的孤儿图表）
  for (const [host, entry] of rendered) {
    if (!host.isConnected) {
      entry.chart.dispose();
      rendered.delete(host);
    }
  }
  // 槽位路径（主）
  for (const slot of slots) {
    if (!slot.isConnected) continue;
    const src = slot.getAttribute('data-src') ?? '';
    const option = extractEChartsOption(src);
    if (!option) {
      fallbackInSlot(slot, src); // 非法 JSON：标红保留源码且不重试
      continue;
    }
    mountInSlot(echarts, slot, src, option);
  }
  // 兼容路径（整段 v-html 渲染下的旧代码块形态，默认不启用）
  for (const code of legacy) {
    const pre = code.parentElement;
    if (!pre || pre.tagName !== 'PRE') continue; // v-html 重渲后已被替换/移除
    const src = code.textContent ?? '';
    const option = extractEChartsOption(src);
    if (!option) {
      pre.classList.add('echarts-err'); // 非法 JSON：标红保留源码
      continue;
    }
    const host = document.createElement('div');
    host.className = 'echarts-host';
    try {
      const box = buildChartBox(host, 'echarts', src);
      pre.replaceWith(box.el); // 先入 DOM 才能测视口宽
      const view = box.el.querySelector<HTMLElement>('.mmd-view')!;
      host.style.width = `${Math.max(200, view.clientWidth - 24)}px`;
      host.style.height = '320px';
      const chart = echarts.init(host, currentThemeName(), { renderer: 'svg' });
      chart.setOption(option as EChartsOption);
      box.remeasure();
      box.onResize(() => chart.resize());
      rendered.set(host, { chart, option });
      ensureThemeWatcher(echarts);
    } catch {
      host.remove();
      pre.classList.add('echarts-err'); // init/setOption 失败：标红保留源码
    }
  }
}

