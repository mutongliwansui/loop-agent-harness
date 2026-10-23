// mermaid.ts：```mermaid 代码块 → SVG 图表后处理（ChatView 对话流与 FilesView md 预览共用）
//
// renderMermaidIn(root) 扫两类挂载点（Task-20261023-002 D3）：
//   1) 槽位 .chart-slot[data-lang=mermaid]（主路径）：流式增量渲染的块渲染产物。
//      源码经 data-src 传入，渲染结果 append 到槽位内并打 data-done。
//      **不替换槽位本身**——槽位由 Vue 的 v-for 管理，replaceWith 会令 vnode.el
//      与真实 DOM 失联，下一轮 patch 直接异常（D3）。
//   2) pre > code.language-mermaid（兼容路径，仅 legacy=true 时启用）：整段 v-html
//      渲染的非流式场景，沿用 replaceWith；默认关闭避免动 Vue 管理的 DOM。
// 解析失败：槽位内保留源码并标红（.mermaid-err），并打 data-done 排除反复重试（D4/D7）。
// 调用方需先等渲染完成（nextTick）；内部串行排队，避免并发调用 mermaid.render。

import { buildChartBox } from './chart-box.js';

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | null = null;
let mermaidSeq = 0;
let mermaidQueue: Promise<void> = Promise.resolve(); // 串行排队，避免并发调用 mermaid.render

export interface RenderMermaidOpts {
  /** 同时处理旧 pre>code 形态（整段 v-html 渲染场景）；默认 false */
  legacy?: boolean;
}

export function renderMermaidIn(root: HTMLElement, opts: RenderMermaidOpts = {}): Promise<void> {
  mermaidQueue = mermaidQueue.then(() => renderBlocks(root, opts));
  return mermaidQueue;
}

/** 槽位内失败降级：保留源码并标红（D7），并打 data-done 排除重试 */
function fallbackInSlot(slot: HTMLElement, src: string): void {
  slot.dataset.done = '1';
  slot.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'mermaid-err';
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = src;
  pre.appendChild(code);
  slot.appendChild(pre);
}

async function renderBlocks(root: HTMLElement, opts: RenderMermaidOpts): Promise<void> {
  const slots = [...root.querySelectorAll<HTMLElement>('.chart-slot[data-lang="mermaid"]:not([data-done])')];
  const legacy = opts.legacy ? [...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')] : [];
  if (slots.length === 0 && legacy.length === 0) return;
  try {
    mermaidPromise ??= import('mermaid').then((m) => m.default);
    const mermaid = await mermaidPromise;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // 主题跟随全局：手动 data-theme 优先（App.vue 主题按钮），否则跟随系统
      theme: (() => {
        const t = document.documentElement.dataset.theme;
        return (t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'default';
      })(),
    });
    // 槽位路径（主）：源码在 data-src，渲染后 append，不替换 Vue 管理的元素
    for (const slot of slots) {
      if (!slot.isConnected) continue; // 已被 Vue 移除（消息删除/会话切换）
      const src = slot.getAttribute('data-src') ?? '';
      const id = `mmd-svg-${++mermaidSeq}`;
      try {
        const { svg } = await mermaid.render(id, src); // strict 模式下 mermaid 内部已 sanitize
        if (!slot.isConnected) continue; // 渲染期间槽位已脱离文档：丢弃结果
        const box = buildChartBox(svg, 'mermaid', src); // 第三参数启用「预览 ⇄ 源代码」（D6）
        slot.appendChild(box.el);
        slot.dataset.done = '1';
        box.fit(); // 已插入 DOM 后才能测量视口宽度
      } catch {
        document.getElementById(`d${id}`)?.remove(); // mermaid v11 render 失败时遗留错误占位
        if (slot.isConnected) fallbackInSlot(slot, src);
      }
    }
    // 兼容路径：整段 v-html 渲染下的旧代码块形态（默认不启用）
    for (const code of legacy) {
      const pre = code.parentElement;
      if (!pre || pre.tagName !== 'PRE') continue; // v-html 重渲后已被替换/移除
      const id = `mmd-svg-${++mermaidSeq}`;
      try {
        const { svg } = await mermaid.render(id, code.textContent ?? '');
        const box = buildChartBox(svg, 'mermaid', code.textContent ?? '');
        pre.replaceWith(box.el);
        box.fit();
      } catch {
        document.getElementById(`d${id}`)?.remove();
        pre.classList.add('mermaid-err'); // 解析失败：保留代码块并标红
      }
    }
  } catch {
    // mermaid 动态加载失败：槽位内落源码（避免空白，D7 修订），legacy 形态保持原代码块
    for (const slot of slots) if (slot.isConnected) fallbackInSlot(slot, slot.getAttribute('data-src') ?? '');
  }
}
