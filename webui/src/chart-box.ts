// chart-box.ts：图表容器共享构建器（mermaid.ts 与 echarts.ts 共用，Task-20261023-001 D3）
//
// buildChartBox(content, opts?) → { el, fit, onResize, remeasure, setSource, toggleSource }
//   el           容器根节点（工具栏 + 可缩放视口 [+ 源码面板]）；调用方插入 DOM 后再调 fit()
//   fit()        适应视口宽度（不放大超过基准 100%）并重置滚动到左上
//   onResize(cb) 注册尺寸变化回调（按钮/滚轮缩放、fit、进出全屏后触发）；echarts 用它重绘 SVG
//   remeasure()  内容就绪后重测基准尺寸（echarts：宿主入 DOM 并 init 后才有实际尺寸）
//   setSource()  运行期补/换源码（传入 source 才有源码面板）
//   toggleSource()「预览 ⇄ 源代码」切换（Task-20261023-002 D6）
//
// 外框重设计（Task-20261023-003，原型 docs/designs/原型-20261023-001+图表容器外框重设计.html）：
//   结构 .chart-block > .chart-bar(.chart-kind + .chart-tools) + .chart-view(> .chart-stage + .chart-hint)
//   [+ .chart-source(.src-head + .src-code)]；样式见 mermaid.css。
//   按钮由字符（＋/－/⛶/</>）改为内联 SVG + aria-label；缩放读数独立成 .zoom-val（点击复位 100%），
//   「适应宽度」与「全屏」拆成两个视觉可区分的图标（fit = 左右边界竖线 + 双向箭头，fs = 四角外扩）。
//
// 交互自 mermaid.ts 原样抽取，行为保持一致：放大/缩小/适应宽度/全屏工具栏、
// 滚轮缩放（0.2x~5x，视口中心锚定）、鼠标拖拽平移（内容溢出才启用，grab 光标）。
// 基准尺寸：内容为 svg 时取 viewBox（mermaid 恒有输出）；否则取元素实测尺寸（echarts 宿主）。
//
// 源码态（D6）：只在容器上加 .src-mode 切 display，**不 dispose** echarts 实例、不重建 svg；
// 切回预览时重算 fit 并触发 resizers，修正隐藏期间 clientWidth=0 造成的错误尺寸。

/** 容器类型：chart = 数据图表（echarts），diagram = 图示（mermaid） */
export type ChartKind = 'chart' | 'diagram';

export interface ChartBoxOptions {
  /** 容器类型，决定类型标识的图标与中文名；默认 chart */
  kind?: ChartKind;
  /** 副标题（如「柱状 · 折线」「流程图」）；空则不渲染该节点 */
  sub?: string;
  /** 原始源码；传入才启用「预览 ⇄ 源代码」面板 */
  source?: string;
  /** 源码语言标签（echarts / mermaid），缺省按 kind 推断 */
  lang?: string;
  /** 源码元信息（option / 源码），缺省按 kind 推断 */
  meta?: string;
}

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

/** 视口左右内边距合计：.chart-view 为 padding: 14px 16px → 32px（原 10px 12px 时为 24px） */
const VIEW_PAD_X = 32;

/** 图标语义（易踩坑）：fit 与 fs 必须视觉可区分，见落地映射表 */
const ICON = {
  zoomOut: '<circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 14 14M5 7h4"/>',
  zoomIn: '<circle cx="7" cy="7" r="4.6"/><path d="M10.5 10.5 14 14M5 7h4M7 5v4"/>',
  fit: '<path d="M2.5 4.2v7.6M13.5 4.2v7.6M4.8 8h6.4M6.6 6.2L4.8 8l1.8 1.8M9.4 6.2L11.2 8l-1.8 1.8"/>',
  full: '<path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10"/>',
  src: '<path d="M5.6 4.4 2.2 8l3.4 3.6M10.4 4.4 13.8 8l-3.4 3.6"/>',
};

const KIND: Record<ChartKind, { label: string; icon: string }> = {
  chart: { label: '图表', icon: '<path d="M3 13V8M8 13V3.5M13 13V6"/>' },
  diagram: {
    label: '图示',
    icon:
      '<rect x="2.5" y="2.6" width="4.6" height="4.2" rx="1"/>' +
      '<rect x="8.9" y="9.2" width="4.6" height="4.2" rx="1"/>' +
      '<path d="M7.1 4.7h1.8a1.6 1.6 0 0 1 1.6 1.6v2.9"/>',
  },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/** 复制到剪贴板：优先 Clipboard API，非安全上下文（局域网 http）回退 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下方回退 */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function buildChartBox(content: HTMLElement | string, opts: ChartBoxOptions = {}): ChartBox {
  const { kind = 'chart', sub = '', source, lang, meta } = opts;
  const k = KIND[kind];
  const hasSrc = source !== undefined;
  const el = document.createElement('div');
  el.className = 'chart-block';
  el.innerHTML = [
    '<div class="chart-bar">',
    '<span class="chart-kind">',
    `<span class="kind-ico"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${k.icon}</svg></span>`,
    escapeHtml(k.label),
    sub ? `<span class="kind-sub">${escapeHtml(sub)}</span>` : '',
    '</span>',
    '<span class="chart-tools">',
    `<button class="tbtn" type="button" data-act="out" title="缩小" aria-label="缩小"><svg viewBox="0 0 16 16">${ICON.zoomOut}</svg></button>`,
    '<button class="zoom-val" type="button" data-act="reset" title="复位为 100%" aria-label="复位缩放">100%</button>',
    `<button class="tbtn" type="button" data-act="in" title="放大" aria-label="放大"><svg viewBox="0 0 16 16">${ICON.zoomIn}</svg></button>`,
    '<span class="tdiv"></span>',
    `<button class="tbtn" type="button" data-act="fit" title="适应宽度" aria-label="适应宽度"><svg viewBox="0 0 16 16">${ICON.fit}</svg></button>`,
    `<button class="tbtn" type="button" data-act="fs" title="全屏" aria-label="全屏"><svg viewBox="0 0 16 16">${ICON.full}</svg></button>`,
    hasSrc ? '<span class="tdiv"></span>' : '',
    hasSrc
      ? `<button class="tbtn" type="button" data-act="src" title="查看源代码" aria-label="查看源代码" aria-pressed="false"><svg viewBox="0 0 16 16">${ICON.src}</svg></button>`
      : '',
    '</span>',
    '</div>',
    '<div class="chart-view"><div class="chart-stage"></div><span class="chart-hint">拖拽平移 · 滚轮缩放</span></div>',
    hasSrc
      ? '<div class="chart-source">' +
        '<div class="src-head">' +
        `<span class="src-lang">${escapeHtml(lang || (kind === 'chart' ? 'echarts' : 'mermaid'))}</span>` +
        `<span class="src-meta">${escapeHtml(meta || (kind === 'chart' ? 'option' : '源码'))}</span>` +
        '<button class="src-copy" type="button" data-copy aria-label="复制源代码">复制</button>' +
        '</div>' +
        '<pre class="src-code"><code></code></pre>' +
        '</div>'
      : '',
  ].join('');

  const stage = el.querySelector<HTMLElement>('.chart-stage')!;
  if (typeof content === 'string') stage.innerHTML = content;
  else stage.appendChild(content);

  const view = el.querySelector<HTMLElement>('.chart-view')!;
  const zoomVal = el.querySelector<HTMLButtonElement>('.zoom-val')!;
  const fsBtn = el.querySelector<HTMLButtonElement>('[data-act=fs]')!;
  const srcBtn = el.querySelector<HTMLButtonElement>('[data-act=src]');
  const sourceEl = el.querySelector<HTMLElement>('.chart-source .src-code code');
  const copyBtn = el.querySelector<HTMLButtonElement>('[data-copy]');
  if (sourceEl && source !== undefined) sourceEl.textContent = source; // textContent 防注入
  const zoomBtns = [
    ...el.querySelectorAll<HTMLButtonElement>(
      '[data-act=in],[data-act=out],[data-act=fit],[data-act=reset]',
    ),
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
    zoomVal.textContent = `${Math.round(scale * 100)}%`;
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
    apply(Math.min(1, (view.clientWidth - VIEW_PAD_X) / baseW)); // 32 = .chart-view 左右 padding
    view.scrollLeft = 0;
    view.scrollTop = 0;
  };

  el.querySelector('[data-act=in]')!.addEventListener('click', () => zoomTo(scale * 1.25));
  el.querySelector('[data-act=out]')!.addEventListener('click', () => zoomTo(scale / 1.25));
  el.querySelector('[data-act=fit]')!.addEventListener('click', fit);
  zoomVal.addEventListener('click', () => zoomTo(1)); // 读数即复位按钮
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  });
  el.addEventListener('fullscreenchange', fit); // 进出全屏视口宽度变化，重算适应宽度
  // 预览 ⇄ 源代码（D6）：只切 display，不 dispose 实例；切回预览重算尺寸并通知宿主重绘
  const toggleSource = (): void => {
    if (!sourceEl || !srcBtn) return;
    srcMode = !srcMode;
    el.classList.toggle('src-mode', srcMode);
    srcBtn.classList.toggle('on', srcMode); // 开启态用品牌弱底色锁定
    srcBtn.setAttribute('aria-pressed', String(srcMode));
    srcBtn.title = srcMode ? '返回图表预览' : '查看源代码';
    syncBtnState();
    if (!srcMode) {
      fit(); // 隐藏期间 clientWidth=0，可见后重算
      for (const cb of resizers) cb();
    }
  };
  srcBtn?.addEventListener('click', toggleSource);
  copyBtn?.addEventListener('click', () => {
    const text = sourceEl?.textContent ?? '';
    void copyText(text).then((ok) => {
      copyBtn.textContent = ok ? '已复制' : '复制失败';
      copyBtn.classList.toggle('done', ok);
      window.setTimeout(() => {
        copyBtn.textContent = '复制';
        copyBtn.classList.remove('done');
      }, 1200);
    });
  });
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
      zoomVal.textContent = '100%';
    },
    setSource: (src) => {
      if (sourceEl) sourceEl.textContent = src;
    },
    toggleSource,
  };
}
