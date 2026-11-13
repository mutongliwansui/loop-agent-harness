// 关停遮罩单测（任务 20261112-007-02 / D2-7）
//
// 遮罩是注入到页面的 JS 字符串，无法在 node 里直接执行 DOM，因此单测聚焦
// 「生成结果是否满足硬约束」：含预算秒数、含最高 z-index、脚本本身可被解析、
// 文案与结构不被引号/中文拼坏。真实渲染效果由人工验证覆盖。
import { describe, it, expect } from 'vitest';
import {
  OVERLAY_ID,
  overlayText,
  buildOverlayScript,
  buildOverlayCleanupScript,
} from '../desktop/src/quit-overlay';

describe('overlayText：文案含预算秒数', () => {
  it('30000ms → 30 秒', () => {
    const t = overlayText(30_000);
    expect(t.hint).toContain('30 秒');
    expect(t.title).toContain('正在整理记忆');
  });

  it('不足 1 秒也按 1 秒展示（避免出现「最多等待 0 秒」）', () => {
    expect(overlayText(200).hint).toContain('1 秒');
  });

  it('文案提示不要强制结束进程（D2-7 的目的就是防用户强杀）', () => {
    expect(overlayText(30_000).hint).toContain('请勿强制结束进程');
  });
});

describe('buildOverlayScript：注入脚本硬约束', () => {
  it('脚本语法合法（能被 new Function 解析）', () => {
    const src = buildOverlayScript(30_000);
    // 只校验语法，不执行（node 无 DOM）
    expect(() => new Function(`return ${src}`)).not.toThrow();
  });

  it('用最高 z-index，避免被前端弹层盖住', () => {
    expect(buildOverlayScript(30_000)).toContain('2147483647');
  });

  it('遮罩节点 id 与清理脚本一致（否则撤不掉）', () => {
    expect(buildOverlayScript(30_000)).toContain(OVERLAY_ID);
    expect(buildOverlayCleanupScript()).toContain(OVERLAY_ID);
  });

  it('先移除同 id 旧节点，重复调用保持幂等', () => {
    expect(buildOverlayScript(30_000)).toContain('getElementById(id)?.remove()');
  });

  it('预算秒数写进脚本', () => {
    expect(buildOverlayScript(45_000)).toContain('45 秒');
  });

  it('文案转义安全：不产生多余的裸引号破坏字符串', () => {
    const src = buildOverlayScript(30_000);
    // 中文与「…」都应被 JSON.stringify 包成合法字面量
    expect(src).toContain('"正在整理记忆，请稍候…"');
  });
});
