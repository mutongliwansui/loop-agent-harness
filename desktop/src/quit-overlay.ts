/**
 * 关停遮罩（任务 20261112-007-02 / D2-7）。
 *
 * 为什么必须有：Dreaming 可能耗数秒到数十秒，期间窗口若没有任何变化，
 * 用户会以为卡死并去任务管理器强杀 —— 那等于把正在整理的记忆一起丢掉。
 * 遮罩文案直接给出预算秒数，让用户知道「还要等多久」。
 *
 * 为什么用 executeJavaScript 注入而不是改前端：跨任务共通约束要求 WebUI 一行不动。
 * 注入的节点挂在 documentElement 上并用最高 z-index，避免被前端样式覆盖。
 */

/** 遮罩节点 id（重复调用时先移除旧的，保证幂等） */
export const OVERLAY_ID = '__loop_agent_quit_overlay__';
/** 旋转动画名，注入时连同 @keyframes 一起塞进文档 */
const SPIN_ANIM = '__loop_agent_spin__';

export interface OverlayText {
  title: string;
  hint: string;
}

/** 生成遮罩文案：含预算秒数（D2-7 要求文案里能看到最多等多久） */
export function overlayText(budgetMs: number): OverlayText {
  const seconds = Math.max(1, Math.round(budgetMs / 1000));
  return {
    title: '正在整理记忆，请稍候…',
    hint: `最多等待 ${seconds} 秒。此时请勿强制结束进程，否则这段记忆会丢失。`,
  };
}

/**
 * 拼出注入用的 JS（一次性建 style + 遮罩）。
 *
 * 文案一律走 JSON.stringify 转义，避免引号或中文把脚本拼坏。
 */
export function buildOverlayScript(budgetMs: number): string {
  const text = overlayText(budgetMs);
  return `(() => {
  const id = ${JSON.stringify(OVERLAY_ID)};
  document.getElementById(id)?.remove();
  if (!document.getElementById(id + '-style')) {
    const style = document.createElement('style');
    style.id = id + '-style';
    style.textContent = '@keyframes ${SPIN_ANIM}{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
  }
  const box = document.createElement('div');
  box.id = id;
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-busy', 'true');
  box.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center', 'gap:14px',
    'background:rgba(17,20,24,0.86)', 'color:#f2f4f7',
    'font:15px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif',
    'text-align:center', 'padding:24px', 'user-select:none'
  ].join(';');
  const spin = document.createElement('div');
  spin.style.cssText = [
    'width:28px', 'height:28px', 'border-radius:50%',
    'border:3px solid rgba(242,244,247,0.25)', 'border-top-color:#4c9aff',
    'animation:${SPIN_ANIM} 0.9s linear infinite'
  ].join(';');
  const title = document.createElement('div');
  title.textContent = ${JSON.stringify(text.title)};
  title.style.cssText = 'font-size:17px;font-weight:600';
  const hint = document.createElement('div');
  hint.textContent = ${JSON.stringify(text.hint)};
  hint.style.cssText = 'max-width:440px;opacity:0.78;font-size:13px';
  box.append(spin, title, hint);
  document.documentElement.appendChild(box);
  return true;
})();`;
}

/** 移除遮罩（后端退出失败、需回到正常界面时用） */
export function buildOverlayCleanupScript(): string {
  return `(() => {
  document.getElementById(${JSON.stringify(OVERLAY_ID)})?.remove();
  return true;
})();`;
}
