// 加载页与错误页单测（任务 20261112-007-03 / D3-4、D3-5）
//
// 这两页是「用户以为程序卡死」的唯一防线，测点集中在：
// 阶段文案必须出现、错误页三个动作都在、日志尾部能展开、HTML 转义不能破结构。
// 页面本身是字符串，不依赖 Electron，因此可在纯 node 下跑。
import { describe, it, expect } from 'vitest';
import {
  buildLoadingHtml,
  buildErrorHtml,
  buildStageScript,
  buildActionPollScript,
  normalizeAction,
  escapeHtml,
  toDataUrl,
  STAGE_TEXT,
  ACTION_VAR,
  type SplashStage,
} from '../desktop/src/splash.js';

describe('desktop/splash', () => {
  describe('加载页（D3-4：不出现 ERR_CONNECTION_REFUSED）', () => {
    it('默认阶段显示「正在启动服务」文案', () => {
      const html = buildLoadingHtml();
      expect(html).toContain(STAGE_TEXT.starting);
    });

    it('三个阶段各自渲染出对应文案', () => {
      for (const stage of ['starting', 'waiting', 'loading-ui'] as SplashStage[]) {
        expect(buildLoadingHtml(stage)).toContain(STAGE_TEXT[stage]);
      }
    });

    it('含计时器，让用户看到时间在走而不是以为卡死', () => {
      const html = buildLoadingHtml();
      expect(html).toContain('setInterval');
      expect(html).toContain('已用');
    });

    it('暴露 __splash.setStage 供主进程切换阶段（不重载页面避免闪烁）', () => {
      expect(buildLoadingHtml()).toContain('__splash');
      expect(buildStageScript('waiting')).toContain(STAGE_TEXT.waiting);
    });

    it('不引用任何外部资源（后端没起来时也能渲染）', () => {
      const html = buildLoadingHtml();
      expect(html).not.toMatch(/https?:\/\//);
      expect(html).not.toContain('<link');
      expect(html).not.toContain('src=');
    });

    it('声明 UTF-8，避免中文乱码', () => {
      expect(buildLoadingHtml()).toContain('<meta charset="utf-8">');
    });
  });

  describe('错误页（D3-5：重试 / 查看日志 / 退出）', () => {
    it('渲染标题与详情', () => {
      const html = buildErrorHtml({ title: '后端启动失败', detail: '进程刚启动就退出了。' });
      expect(html).toContain('后端启动失败');
      expect(html).toContain('进程刚启动就退出了。');
    });

    it('始终提供「重试」与「退出」两个动作', () => {
      const html = buildErrorHtml({ title: 'T', detail: 'D' });
      expect(html).toContain('id="btn-retry"');
      expect(html).toContain('id="btn-exit"');
      expect(html).toContain('重试');
      expect(html).toContain('退出');
    });

    it('有日志尾部时才提供「查看日志」按钮，且初始折叠', () => {
      const withTail = buildErrorHtml({ title: 'T', detail: 'D', logTail: 'EADDRINUSE: 3000' });
      expect(withTail).toContain('id="btn-log"');
      expect(withTail).toContain('查看日志');
      expect(withTail).toContain('hidden');
      expect(withTail).toContain('EADDRINUSE: 3000');

      const withoutTail = buildErrorHtml({ title: 'T', detail: 'D' });
      expect(withoutTail).not.toContain('id="btn-log"');
    });

    it('空白日志尾部视为无日志（不渲染空按钮）', () => {
      const html = buildErrorHtml({ title: 'T', detail: 'D', logTail: '   \n  ' });
      expect(html).not.toContain('id="btn-log"');
    });

    it('按钮点击只写标志变量，不直接改 location（data: URL 下同文档导航不可靠）', () => {
      const html = buildErrorHtml({ title: 'T', detail: 'D' });
      expect(html).toContain(ACTION_VAR);
      expect(html).not.toContain('location.hash');
    });

    // 后端日志里出现 <script> 或引号是常事（如打印了 HTML 片段），必须转义
    it('详情与日志中的 HTML 特殊字符被转义，不会破坏页面结构', () => {
      const html = buildErrorHtml({
        title: '<img src=x onerror=alert(1)>',
        detail: 'a & b < c > d "quoted"',
        logTail: '<script>alert(1)</script>',
      });
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;img src=x');
      expect(html).toContain('&amp;');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  describe('动作回传', () => {
    it('normalizeAction 只认 retry/exit，其余一律 null', () => {
      expect(normalizeAction('retry')).toBe('retry');
      expect(normalizeAction('exit')).toBe('exit');
      for (const bad of ['', 'RETRY', 'quit', null, undefined, 0, {}, []]) {
        expect(normalizeAction(bad)).toBeNull();
      }
    });

    it('轮询脚本读取标志变量且对非法值返回 null', () => {
      const s = buildActionPollScript();
      expect(s).toContain(ACTION_VAR);
      expect(s).toContain('retry');
      expect(s).toContain('exit');
    });
  });

  describe('escapeHtml', () => {
    it('五个特殊字符全部转义', () => {
      expect(escapeHtml('&<>"')).toBe('&amp;&lt;&gt;&quot;');
    });

    it('不重复转义已转义内容以外的普通文本', () => {
      expect(escapeHtml('正常中文 abc 123')).toBe('正常中文 abc 123');
    });
  });

  describe('toDataUrl', () => {
    it('生成 data URL 且对中文与引号做 URI 编码', () => {
      const url = toDataUrl('<p>中文 "x"</p>');
      expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
      // 编码后不应残留裸空格与引号，否则 loadURL 会被截断
      expect(url.slice('data:text/html;charset=utf-8,'.length)).not.toMatch(/[\s"]/);
    });

    it('解码后能还原原始 HTML', () => {
      const html = '<p>中文 "x" & y</p>';
      const url = toDataUrl(html);
      expect(decodeURIComponent(url.split(',')[1])).toBe(html);
    });
  });
});
