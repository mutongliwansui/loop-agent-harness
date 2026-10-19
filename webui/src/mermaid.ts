// mermaid.ts：```mermaid 代码块 → SVG 图表后处理（ChatView 对话流与 FilesView md 预览共用）
//
// renderMermaidIn(root) → 把 root 下 marked 输出的 <pre><code class="language-mermaid">
// 替换为图表容器（工具栏：放大/缩小/适应宽度/全屏 + 滚轮缩放 + 拖拽平移，样式见 mermaid.css）。
// 解析失败保留代码块并标红（.mermaid-err）；mermaid 动态加载失败静默保留代码块形态。
// 调用方需先等 v-html 渲染完成（nextTick）；内部串行排队，避免并发调用 mermaid.render。

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | null = null;
let mermaidSeq = 0;
let mermaidQueue: Promise<void> = Promise.resolve(); // 串行排队，避免并发调用 mermaid.render

export function renderMermaidIn(root: HTMLElement): Promise<void> {
  mermaidQueue = mermaidQueue.then(() => renderBlocks(root));
  return mermaidQueue;
}

/** 构建 mermaid 图表容器：工具栏（放大/缩小/适应宽度/全屏）+ 滚轮缩放 + 视口滚动 */
function buildMermaidBox(svgMarkup: string): { el: HTMLDivElement; fit: () => void } {
  const el = document.createElement('div');
  el.className = 'mermaid-block';
  el.innerHTML =
    '<div class="mmd-bar">' +
    '<span class="mmd-cap">mermaid</span>' +
    '<span class="mmd-spring"></span>' +
    '<button type="button" data-act="in" title="放大">＋</button>' +
    '<button type="button" data-act="out" title="缩小">－</button>' +
    '<button type="button" data-act="fit" title="适应宽度">100%</button>' +
    '<button type="button" data-act="fs" title="全屏">⛶</button>' +
    '</div>' +
    '<div class="mmd-view"><div class="mmd-stage">' +
    svgMarkup +
    '</div></div>';
  const view = el.querySelector<HTMLElement>('.mmd-view')!;
  const svgEl = el.querySelector<SVGSVGElement>('svg')!;
  const fitBtn = el.querySelector<HTMLButtonElement>('[data-act=fit]')!;

  // 基准尺寸取 viewBox（mermaid 恒有输出；attr width 常为 100% 不可用）
  const vb = svgEl.viewBox.baseVal;
  const baseW = vb.width || parseFloat(svgEl.getAttribute('width') || '') || 0;
  const baseH = vb.height || parseFloat(svgEl.getAttribute('height') || '') || 0;
  const zoomable = baseW > 0 && baseH > 0;
  let scale = 1;

  const apply = (s: number): void => {
    scale = Math.min(5, Math.max(0.2, s));
    svgEl.style.maxWidth = 'none';
    svgEl.style.width = `${baseW * scale}px`;
    svgEl.style.height = `${baseH * scale}px`;
    fitBtn.textContent = `${Math.round(scale * 100)}%`;
    // 内容超出视口才可拖拽平移（grab 光标）
    view.classList.toggle(
      'pan-able',
      view.scrollWidth > view.clientWidth || view.scrollHeight > view.clientHeight,
    );
  };

  /** 以视口中心为锚缩放，避免缩放后视点漂移 */
  const zoomTo = (next: number): void => {
    if (!zoomable) return;
    const prev = scale;
    const r = view.getBoundingClientRect();
    const cx = view.scrollLeft + r.width / 2;
    const cy = view.scrollTop + r.height / 2;
    apply(next);
    view.scrollLeft = (cx * scale) / prev - r.width / 2;
    view.scrollTop = (cy * scale) / prev - r.height / 2;
  };

  /** 适应容器宽度（不放大超过 100%） */
  const fit = (): void => {
    if (!zoomable) return;
    apply(Math.min(1, (view.clientWidth - 24) / baseW)); // 24 = .mmd-view 左右 padding
    view.scrollLeft = 0;
    view.scrollTop = 0;
  };

  el.querySelector('[data-act=in]')!.addEventListener('click', () => zoomTo(scale * 1.25));
  el.querySelector('[data-act=out]')!.addEventListener('click', () => zoomTo(scale / 1.25));
  fitBtn.addEventListener('click', fit);
  el.querySelector('[data-act=fs]')!.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  });
  el.addEventListener('fullscreenchange', fit); // 进出全屏视口宽度变化，重算适应宽度
  view.addEventListener(
    'wheel',
    (e) => {
      if (!zoomable) return;
      e.preventDefault(); // 劫持滚轮用于缩放
      zoomTo(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    },
    { passive: false },
  );
  // 拖拽平移：按住左键拖动同步视口滚动（grab & pan）；触摸设备走原生滚动
  view.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (view.scrollWidth <= view.clientWidth && view.scrollHeight <= view.clientHeight) return;
    e.preventDefault(); // 阻止拖拽选中文本
    const startX = e.clientX;
    const startY = e.clientY;
    const sl = view.scrollLeft;
    const st = view.scrollTop;
    view.classList.add('panning');
    view.setPointerCapture(e.pointerId); // 移出视口仍持续跟踪
    const onMove = (ev: PointerEvent): void => {
      view.scrollLeft = sl - (ev.clientX - startX);
      view.scrollTop = st - (ev.clientY - startY);
    };
    const onUp = (): void => {
      view.classList.remove('panning');
      view.removeEventListener('pointermove', onMove);
      view.removeEventListener('pointerup', onUp);
      view.removeEventListener('pointercancel', onUp);
    };
    view.addEventListener('pointermove', onMove);
    view.addEventListener('pointerup', onUp);
    view.addEventListener('pointercancel', onUp);
  });
  if (!zoomable) {
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-act=in],[data-act=out],[data-act=fit]')) {
      b.disabled = true;
    }
  }
  return { el, fit };
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
        const box = buildMermaidBox(svg);
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
