/**
 * 启动加载页与错误页（任务 20261112-007-03 / D3-4、D3-5）。
 *
 * 为什么必须有加载页（D3-4）：后端 SEA 从 spawn 到 /health 就绪约 0.4~2.5s，
 * 这期间若直接 loadURL 后端地址，Electron 会显示 ERR_CONNECTION_REFUSED 错误页，
 * 观感极差且看不出在干什么。因此先渲染一个本地生成的页面（不走网络），
 * 就绪后再 loadURL 到后端。
 *
 * 为什么不放在 webui 里：跨任务共通约束要求 WebUI 一行不动；且加载页必须在
 * 后端尚未启动时就能显示，不能依赖后端提供的静态资源。
 *
 * 本模块刻意不 import electron：只产出 HTML/脚本字符串，单测在纯 node 下跑，
 * BrowserWindow 的创建留在 main.ts（与 quit-overlay.ts 同一模式，见 D3-8）。
 */

/** 加载页所处阶段：决定顶部文案与进度提示 */
export type SplashStage = 'starting' | 'waiting' | 'loading-ui';

/** 阶段文案（3.1：让用户知道后端在干什么，而不是以为卡死） */
export const STAGE_TEXT: Record<SplashStage, string> = {
  starting: '正在启动服务…',
  waiting: '正在等待服务就绪…',
  'loading-ui': '正在加载界面…',
};

/** 错误页动作：由页面内按钮触发，main.ts 轮询读取后处理 */
export type SplashAction = 'retry' | 'exit';

/**
 * 页面侧记录所选动作的全局变量名。
 *
 * 为什么不用 location.hash + did-navigate-in-page：加载页是 data: URL，
 * 同文档导航在该 scheme 下是否派发事件依赖 Chromium 实现细节，不可靠。
 * 改成「页面写标志 + 主进程 executeJavaScript 轮询」，语义完全确定，
 * 也无需为此引入 preload/IPC 通道（preload 会对后端页面长期生效，不划算）。
 */
export const ACTION_VAR = '__splashAction';

export interface ErrorPayload {
  /** 一句话说明发生了什么（来自 errors.ts 的 UserFacingError.title） */
  title: string;
  /** 详情：原因与已尝试的动作 */
  detail: string;
  /** 后端日志尾部（可选，折叠展示） */
  logTail?: string;
}

/** 统一的页面外壳：深色、居中、无外链资源（离线可用） */
function wrap(bodyClass: string, inner: string, script = ''): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>LoopAgent</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #14171c; color: #e7eaee;
    font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  .box { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 32px; max-width: 720px; }
  .brand { font-size: 20px; font-weight: 600; letter-spacing: .3px; color: #34d399; }
  .spin {
    width: 30px; height: 30px; border-radius: 50%;
    border: 3px solid rgba(231,234,238,.18); border-top-color: #34d399;
    animation: spin .9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .stage { font-size: 15px; }
  .meta { font-size: 12px; color: #98a2b3; }
  .${bodyClass} { }
  h1 { font-size: 18px; margin: 0; font-weight: 600; }
  p.detail { margin: 0; color: #b6bec9; white-space: pre-wrap; max-width: 620px; }
  .actions { display: flex; gap: 10px; margin-top: 6px; }
  button {
    font: inherit; padding: 7px 16px; border-radius: 8px; cursor: pointer;
    border: 1px solid #3a4250; background: #1e232b; color: #e7eaee;
  }
  button:hover { border-color: #34d399; color: #34d399; }
  button.primary { background: #34d399; border-color: #34d399; color: #0b221a; font-weight: 600; }
  button.primary:hover { filter: brightness(1.06); color: #0b221a; }
  pre {
    width: 620px; max-width: 100%; max-height: 260px; overflow: auto;
    margin: 0; padding: 10px 12px; border-radius: 8px;
    background: #0f1216; border: 1px solid #262c36; color: #a7b0bd;
    font: 12px/1.5 ui-monospace, Consolas, "Courier New", monospace;
    white-space: pre-wrap; word-break: break-all; -webkit-user-select: text; user-select: text;
  }
  pre[hidden] { display: none; }
</style></head>
<body><div class="box ${bodyClass}">${inner}</div>
${script}</body></html>`;
}

/**
 * 加载页 HTML。
 *
 * 只含一个会自增的「已耗时」计时器：超时前用户能看到时间在走，
 * 就知道没卡死；配合 STAGE_TEXT 的阶段切换，能判断卡在哪一步。
 */
export function buildLoadingHtml(stage: SplashStage = 'starting'): string {
  const inner = `<div class="brand">LoopAgent</div>
  <div class="spin"></div>
  <div class="stage" id="stage">${escapeHtml(STAGE_TEXT[stage])}</div>
  <div class="meta" id="meta">已用 0.0 秒</div>`;
  // 计时从页面渲染起算：spawn 之前的时间虽有误差，但用户关心的是「还在动」
  const script = `<script>
(function () {
  var t0 = Date.now();
  var meta = document.getElementById('meta');
  setInterval(function () {
    var s = (Date.now() - t0) / 1000;
    meta.textContent = '已用 ' + s.toFixed(1) + ' 秒';
  }, 100);
  // 供主进程 executeJavaScript 切换阶段文案（不重新加载页面，避免闪烁）
  window.__splash = {
    setStage: function (text) {
      document.getElementById('stage').textContent = text;
      return true;
    }
  };
})();
</script>`;
  return wrap('loading', inner, script);
}

/** 切换阶段文案的脚本（main.ts 在阶段推进时注入） */
export function buildStageScript(stage: SplashStage): string {
  return `(() => {
  if (!window.__splash) return false;
  return window.__splash.setStage(${JSON.stringify(STAGE_TEXT[stage])});
})();`;
}

/** HTML 转义：detail/日志里可能含 < > & 与引号，直接拼会破坏结构 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 错误页 HTML（D3-5：三个动作都要有）。
 *
 * 「查看日志」做成页内展开而不是开新窗口：日志尾部本来就在手上，
 * 多开一个窗口既慢又多一个要关的窗口，展开/收起一步到位。
 * 「重试」「退出」两个动作需要主进程参与，写入 window.__splashAction
 * 由 main.ts 轮询取出（见 ACTION_VAR 的说明）。
 */
export function buildErrorHtml(payload: ErrorPayload): string {
  const tail = (payload.logTail ?? '').trim();
  const hasTail = tail.length > 0;
  const inner = `<div class="brand">LoopAgent</div>
  <h1>${escapeHtml(payload.title)}</h1>
  <p class="detail">${escapeHtml(payload.detail)}</p>
  ${hasTail ? '<pre id="log" hidden>' + escapeHtml(tail) + '</pre>' : ''}
  <div class="actions">
    <button class="primary" id="btn-retry">重试</button>
    ${hasTail ? '<button id="btn-log">查看日志</button>' : ''}
    <button id="btn-exit">退出</button>
  </div>
  <div class="meta">若反复失败，请把上面的日志发给维护者。</div>`;
  const script = `<script>
(function () {
  function act(name) { window[${JSON.stringify(ACTION_VAR)}] = name; }
  document.getElementById('btn-retry').onclick = function () { act('retry'); };
  document.getElementById('btn-exit').onclick = function () { act('exit'); };
  var logBtn = document.getElementById('btn-log');
  if (logBtn) {
    logBtn.onclick = function () {
      var pre = document.getElementById('log');
      var show = pre.hidden;
      pre.hidden = !show;
      logBtn.textContent = show ? '收起日志' : '查看日志';
    };
  }
})();
</script>`;
  return wrap('error', inner, script);
}

/** 读取页面侧所选动作的脚本（未选时为 null） */
export function buildActionPollScript(): string {
  return `(() => {
  const v = window[${JSON.stringify(ACTION_VAR)}];
  return v === 'retry' || v === 'exit' ? v : null;
})();`;
}

/** 把任意值安全收敛成动作枚举（执行 executeJavaScript 回来的值不可信） */
export function normalizeAction(value: unknown): SplashAction | null {
  return value === 'retry' || value === 'exit' ? value : null;
}

/** 把 HTML 转成可直接 loadURL 的 data URL（编码后中文与引号都不会破坏 URL） */
export function toDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
