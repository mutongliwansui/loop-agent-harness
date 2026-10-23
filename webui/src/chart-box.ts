// chart-box.ts：图表容器共享构建器（mermaid.ts 与 echarts.ts 共用，Task-20261023-001 D3）
//
// buildChartBox(content, caption, source?) → { el, fit, onResize, remeasure, setSource, toggleSource }
//   el           容器根节点（工具栏 + 可缩放视口 [+ 源码面板]）；调用方插入 DOM 后再调 fit()
//   fit()        适应视口宽度（不放大超过基准 100%）并重置滚动到左上
//   onResize(cb) 注册尺寸变化回调（按钮/滚轮缩放、fit、进出全屏后触发）；echarts 用它重绘 SVG
//   remeasure()  内容就绪后重测基准尺寸（echarts：宿主入 DOM 并 init 后才有实际尺寸）
//   setSource()  运行期补/换源码（传入 source 才有源码面板）
//   toggleSource()「预览 ⇄ 源代码」切换（Task-20261023-002 D6）
//
// 交互自 mermaid.ts 原样抽取，行为保持一致：放大/缩小/适应宽度/全屏工具栏、
// 滚轮缩放（0.2x~5x，视口中心锚定）、鼠标拖拽平移（内容溢出才启用，grab 光标）。
// 基准尺寸：内容为 svg 时取 viewBox（mermaid 恒有输出）；否则取元素实测尺寸（echarts 宿主）。
// 样式见 mermaid.css 的 .mermaid-block / .mmd-* 规则（mermaid 与 echarts 共用类名）。
//
// 源码态（D6）：只在容器上加 .src-mode 切 display，**不 dispose** echarts 实例、不重建 svg；
// 切回预览时重算 fit 并触发 resizers，修正隐藏期间 clientWidth=0 造成的错误尺寸。

export interface ChartBox {
  el: HTMLDivElement;
  fit: () => void;
  onResize: (cb: () => void) => void;
  remeasure: () => void;
  /** 运行期补/替换源码（无源码面板时为空操作） */
  setSource: (src: string) => void;
  /** 预览 ⇄ 源代码 切换（无源码面板时为空操作） */
  toggleSource: () => void;
}

export function buildChartBox(
  content: HTMLElement | string,
  caption: string,
  source?: string,
): ChartBox {
  const el = document.createElement('div');
  el.className = 'mermaid-block';
  el.innerHTML =
    '<div class="mmd-bar">' +
    `<span class="mmd-cap">${caption}</span>` +
    '<span class="mmd-spring"></span>' +
    '<button type="button" data-act="in" title="放大">＋</button>' +
    '<button type="button" data-act="out" title="缩小">－</button>' +
    '<button type="button" data-act="fit" title="适应宽度">100%</button>' +
    '<button type="button" data-act="fs" title="全屏">⛶</button>' +
    (source === undefined ? '' : '<button type="button" data-act="src" title="查看源代码">&lt;/&gt;</button>') +
    '</div>' +
    '<div class="mmd-view"><div class="mmd-stage"></div></div>' +
    (source === undefined ? '' : '<pre class="mmd-source"></pre>');
  const stage = el.querySelector<HTMLElement>('.mmd-stage')!;
  if (typeof content === 'string') stage.innerHTML = content;
  else stage.appendChild(content);

  const view = el.querySelector<HTMLElement>('.mmd-view')!;
  const fitBtn = el.querySelector<HTMLButtonElement>('[data-act=fit]')!;
  const fsBtn = el.querySelector<HTMLButtonElement>('[data-act=fs]')!;
  const srcBtn = el.querySelector<HTMLButtonElement>('[data-act=src]');
  const sourceEl = el.querySelector<HTMLElement>('.mmd-source');
  if (sourceEl && source !== undefined) sourceEl.textContent = source; // textContent 防注入
  const zoomBtns = [
    ...el.querySelectorAll<HTMLButtonElement>('[data-act=in],[data-act=out],[data-act=fit]'),
  ];
  const target = stage.firstElementChild as HTMLElement | null; // svg（mermaid）或图表宿主 div（echarts）
  let baseW = 0;
  let baseH = 0;
  let zoomable = false;
  let scale = 1;
  let srcMode = false; // 源码态：缩放类按钮全禁用（D6），切回预览不重建图表实例
  const resizers = new Set<() => void>();

  const syncBtnState = (): void => {
    for (const b of zoomBtns) b.disabled = srcMode || !zoomable;
    fsBtn.disabled = srcMode;
  };

  const measureBase = (): void => {
    baseW = 0;
    baseH = 0;
    if (target instanceof SVGSVGElement) {
      // 基准尺寸取 viewBox（mermaid 根 svg 恒有输出；attr width 常为 100% 不可用）
      const vb = target.viewBox.baseVal;
      baseW = vb.width || parseFloat(target.getAttribute('width') || '') || 0;
      baseH = vb.height || parseFloat(target.getAttribute('height') || '') || 0;
    } else if (target) {
      baseW = target.offsetWidth || 0; // echarts 宿主：入 DOM 且 init 后有实测尺寸
      baseH = target.offsetHeight || 0;
    }
    zoomable = baseW > 0 && baseH > 0;
    syncBtnState();
  };
  measureBase();

  const apply = (s: number): void => {
    scale = Math.min(5, Math.max(0.2, s));
    if (target) {
      target.style.maxWidth = 'none';
      target.style.width = `${baseW * scale}px`;
      target.style.height = `${baseH * scale}px`;
    }
    fitBtn.textContent = `${Math.round(scale * 100)}%`;
    // 内容超出视口才可拖拽平移（grab 光标）
    view.classList.toggle(
      'pan-able',
      view.scrollWidth > view.clientWidth || view.scrollHeight > view.clientHeight,
    );
    for (const cb of resizers) cb(); // echarts：按新尺寸重绘（SVG 矢量保持清晰）
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
  // 预览 ⇄ 源代码（D6）：只切 display，不 dispose 实例；切回预览重算尺寸并通知宿主重绘
  const toggleSource = (): void => {
    if (!sourceEl || !srcBtn) return;
    srcMode = !srcMode;
    el.classList.toggle('src-mode', srcMode);
    srcBtn.textContent = srcMode ? '预览' : '</>';
    srcBtn.title = srcMode ? '返回图表预览' : '查看源代码';
    syncBtnState();
    if (!srcMode) {
      fit(); // 隐藏期间 clientWidth=0，可见后重算
      for (const cb of resizers) cb();
    }
  };
  srcBtn?.addEventListener('click', toggleSource);
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

  return {
    el,
    fit,
    onResize: (cb) => void resizers.add(cb),
    remeasure: () => {
      measureBase();
      scale = 1;
      fitBtn.textContent = '100%';
    },
    setSource: (src) => {
      if (sourceEl) sourceEl.textContent = src;
    },
    toggleSource,
  };
}
