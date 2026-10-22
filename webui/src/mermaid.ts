// mermaid.ts：```mermaid 代码块 → SVG 图表后处理（ChatView 对话流与 FilesView md 预览共用）
//
// renderMermaidIn(root) → 把 root 下 marked 输出的 <pre><code class="language-mermaid">
// 替换为图表容器（容器与交互见 ../chart-box.ts 共享构建器，样式见 mermaid.css）。
// 解析失败保留代码块并标红（.mermaid-err）；mermaid 动态加载失败静默保留代码块形态。
// 调用方需先等 v-html 渲染完成（nextTick）；内部串行排队，避免并发调用 mermaid.render。

import { buildChartBox } from './chart-box.js';

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | null = null;
let mermaidSeq = 0;
let mermaidQueue: Promise<void> = Promise.resolve(); // 串行排队，避免并发调用 mermaid.render

export function renderMermaidIn(root: HTMLElement): Promise<void> {
  mermaidQueue = mermaidQueue.then(() => renderBlocks(root));
  return mermaidQueue;
}

async function renderBlocks(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')];
  if (blocks.length === 0) return;
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
    for (const code of blocks) {
      const pre = code.parentElement;
      if (!pre || pre.tagName !== 'PRE') continue; // v-html 重渲后已被替换/移除
      const id = `mmd-svg-${++mermaidSeq}`;
      try {
        const { svg } = await mermaid.render(id, code.textContent ?? ''); // strict 模式下 mermaid 内部已 sanitize
        const box = buildChartBox(svg, 'mermaid'); // 容器与交互见 ../chart-box.ts（D3 抽取，行为不变）
        pre.replaceWith(box.el);
        box.fit(); // 已插入 DOM 后才能测量视口宽度
      } catch {
        // mermaid v11 render 失败时会遗留错误占位元素，需手动清理
        document.getElementById(`d${id}`)?.remove();
        pre.classList.add('mermaid-err'); // 解析失败：保留代码块并标红
      }
    }
  } catch {
    // mermaid 动态加载失败：静默保留代码块形态
  }
}
