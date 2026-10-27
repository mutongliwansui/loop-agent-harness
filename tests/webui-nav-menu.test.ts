/**
 * 侧边栏底部「设置与管理」菜单重设计回归测试（需求 20261028-002）
 *
 * 固化三组不变量：
 * 1. 数据结构：7 个管理项分三组（运行 / 扩展 / 数据与排查），路径与本项目 hash 路由逐一对应，
 *    MCP 项短标签为「MCP」（2 列网格放不下全称，全称进 title）；图标全部为 16×16 线性 SVG
 *    inner path，且 gear / wrench / puzzle 与 tool-meta.ts 的 TOOL_ICON_PATHS 逐字节一致（防漂移）。
 * 2. 外观三态：auto → 删除 data-theme（跟随系统），light / dark 显式覆盖。
 * 3. 样式契约：入口 36px、面板是向上浮层（absolute + bottom: calc(100% + 4px)）、
 *    窄屏下入口仍可见且面板改 fixed 向右弹出（修 P7：旧实现把 .grp-body 与
 *    .grp.open .grp-body 一并 display:none，窄屏管理菜单完全不可达）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_GROUPS,
  ADMIN_ITEMS,
  APPEAR_MODES,
  CHAT_LABEL,
  MENU_LABEL,
  NAV_ICON_PATHS,
  navIconSvg,
  pageLabel,
  resolveThemeAttr,
  type NavIconKey,
} from '../webui/src/nav-menu.js';
import { TOOL_ICON_PATHS } from '../webui/src/tool-meta.js';

const CSS_FILE = fileURLToPath(new URL('../webui/src/style.css', import.meta.url));
const APP_FILE = fileURLToPath(new URL('../webui/src/App.vue', import.meta.url));

const rawCss = readFileSync(CSS_FILE, 'utf-8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
const app = readFileSync(APP_FILE, 'utf-8');

/** 扁平规则（选择器 + 声明块）；@media 内的规则会被展开为裸选择器 */
function cssRules(text: string): { selectors: string[]; body: string }[] {
  const out: { selectors: string[]; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const selectors = m[1]
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    out.push({ selectors, body: m[2].trim() });
  }
  return out;
}

/** 取某个 @media / 选择器块的平衡花括号内容 */
function blockOf(text: string, header: string): string {
  const i = text.indexOf(header);
  if (i < 0) return '';
  const start = text.indexOf('{', i);
  if (start < 0) return '';
  let depth = 0;
  for (let k = start; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}') {
      depth--;
      if (depth === 0) return text.slice(start + 1, k);
    }
  }
  return '';
}

/** 某选择器的全部声明体（多条同名规则合并） */
function bodyOf(rules: { selectors: string[]; body: string }[], selector: string): string {
  return rules
    .filter((r) => r.selectors.includes(selector))
    .map((r) => r.body)
    .join('; ');
}

const rules = cssRules(css);

describe('nav-menu：分组结构（D3 / D4 / D5）', () => {
  it('三组、7 项，分组名与顺序固定', () => {
    expect(ADMIN_GROUPS.map((g) => g.cap)).toEqual(['运行', '扩展', '数据与排查']);
    expect(ADMIN_GROUPS.map((g) => g.items.length)).toEqual([3, 2, 2]);
    expect(ADMIN_ITEMS).toHaveLength(7);
  });

  it('路径与本项目 hash 路由逐一对应，且与旧 adminItems 顺序一致', () => {
    expect(ADMIN_ITEMS.map((i) => i.path)).toEqual([
      '#/config',
      '#/models',
      '#/tools',
      '#/mcp',
      '#/skills',
      '#/memory',
      '#/doctor',
    ]);
  });

  it('MCP 项：短标签 MCP、全称保留（title），其余项 short = label', () => {
    const mcp = ADMIN_ITEMS.find((i) => i.path === '#/mcp')!;
    expect(mcp.label).toBe('MCP 服务器');
    expect(mcp.short).toBe('MCP');
    for (const it of ADMIN_ITEMS.filter((i) => i.path !== '#/mcp')) {
      expect(it.short).toBe(it.label);
    }
    // 短标签需在 2 列格宽（≈93px）内单行可容
    for (const it of ADMIN_ITEMS) expect(it.short.length).toBeLessThanOrEqual(4);
  });
});

describe('nav-menu：16×16 线性 SVG 图标（D2，零新依赖）', () => {
  it('每个管理项与入口/箭头都有对应路径，无空值', () => {
    const keys = new Set<NavIconKey>(ADMIN_ITEMS.map((i) => i.icon));
    keys.add('sliders');
    keys.add('caret');
    for (const k of keys) {
      expect(NAV_ICON_PATHS[k], `缺少图标 ${k}`).toBeTruthy();
      expect(NAV_ICON_PATHS[k].length).toBeGreaterThan(10);
    }
  });

  it('navIconSvg 输出：viewBox 16×16 / stroke 1.6 / currentColor / fill:none', () => {
    const svg = navIconSvg('gear');
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke-width="1.6"');
    expect(svg).toContain(NAV_ICON_PATHS.gear);
    // 箭头略粗，保证 12px 下仍可辨
    expect(navIconSvg('caret', 1.8)).toContain('stroke-width="1.8"');
  });

  it('gear / wrench / puzzle 与 tool-meta.ts 的 TOOL_ICON_PATHS 逐字节一致（防两处漂移）', () => {
    expect(NAV_ICON_PATHS.gear).toBe(TOOL_ICON_PATHS.gear);
    expect(NAV_ICON_PATHS.wrench).toBe(TOOL_ICON_PATHS.wrench);
    expect(NAV_ICON_PATHS.puzzle).toBe(TOOL_ICON_PATHS.puzzle);
  });

  it('不含 emoji（P2：跨平台渲染不可控、视觉重量不一）', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const [k, d] of Object.entries(NAV_ICON_PATHS)) {
      expect(emoji.test(d), `图标 ${k} 含 emoji`).toBe(false);
    }
    for (const it of ADMIN_ITEMS) {
      expect(emoji.test(it.label + it.short + it.icon), `项 ${it.path} 含 emoji`).toBe(false);
    }
    // App.vue 底部菜单区不再出现 emoji 字符
    const bottomStart = app.indexOf('class="nav-bottom"');
    expect(bottomStart).toBeGreaterThan(-1);
    const navTpl = app.slice(bottomStart, app.indexOf('</aside>'));
    expect(emoji.test(navTpl)).toBe(false);
  });
});

describe('nav-menu：入口页名（D7）与外观三态（D6）', () => {
  it('pageLabel：管理项回短标签，聊天页/未知路径回「对话」', () => {
    expect(pageLabel('#/config')).toBe('配置');
    expect(pageLabel('#/mcp')).toBe('MCP');
    expect(pageLabel('#/doctor')).toBe('诊断');
    expect(pageLabel('#/chat')).toBe(CHAT_LABEL);
    expect(pageLabel('#/nope')).toBe(CHAT_LABEL);
    expect(pageLabel('')).toBe(CHAT_LABEL);
    expect(MENU_LABEL).toBe('设置与管理');
  });

  it('resolveThemeAttr：auto 不写 data-theme，light/dark 原样返回', () => {
    expect(resolveThemeAttr('auto')).toBeNull();
    expect(resolveThemeAttr('light')).toBe('light');
    expect(resolveThemeAttr('dark')).toBe('dark');
  });

  it('APPEAR_MODES 三段：跟随 / 浅色 / 深色', () => {
    expect(APPEAR_MODES.map((m) => m.v)).toEqual(['auto', 'light', 'dark']);
    expect(APPEAR_MODES.map((m) => m.label)).toEqual(['跟随', '浅色', '深色']);
  });
});

describe('App.vue：旧折叠组已移除，浮层接线到位（D1 / D11）', () => {
  it('不再渲染 .grp / .grp-head / .grp-body，也不再引用 mgrpOpen / toggleTheme', () => {
    for (const token of ['grp-head', 'grp-body', 'mgrpOpen', 'toggleTheme', 'theme-item']) {
      expect(app.includes(token), `App.vue 仍含旧实现 ${token}`).toBe(false);
    }
  });

  it('面板接 role=menu、项接 role=menuitem + aria-current；入口接 aria-haspopup / aria-expanded / aria-controls', () => {
    expect(app).toContain('role="menu"');
    expect(app).toContain('role="menuitem"');
    expect(app).toContain('aria-haspopup="menu"');
    expect(app).toContain(':aria-expanded="panelOpen"');
    expect(app).toContain('aria-controls="nav-mgr-panel"');
    // aria-current 只在当前页项出现
    expect(app).toContain(`:aria-current="currentPath === item.path ? 'page' : undefined"`);
  });

  it('键盘与外部点击：方向键 / Home / End / Esc / pointerdown 关闭', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape']) {
      expect(app).toContain(key);
    }
    expect(app).toContain(`document.addEventListener('pointerdown', onDocPointerDown)`);
    expect(app).toContain(`document.removeEventListener('pointerdown', onDocPointerDown)`);
  });
});

describe('style.css：入口 + 浮层样式契约（D1 / D8 / D9）', () => {
  it('入口 36px 高，容器仅 1px 分隔线 + 8px 间距（常驻 45px）', () => {
    const entry = bodyOf(rules, '.nav .entry');
    expect(entry).toMatch(/height:\s*36px/);
    const nb = bodyOf(rules, '.nav .nav-bottom');
    expect(nb).toMatch(/padding-top:\s*8px/);
    expect(nb).toMatch(/position:\s*relative/);
  });

  it('面板是向上浮层：absolute + bottom calc(100% + 4px) + 令牌阴影，收起态 visibility:hidden', () => {
    const panel = bodyOf(rules, '.nav .panel');
    expect(panel).toMatch(/position:\s*absolute/);
    expect(panel).toMatch(/bottom:\s*calc\(100% \+ 4px\)/);
    expect(panel).toMatch(/box-shadow:\s*var\(--shadow-pop\)/);
    expect(panel).toMatch(/visibility:\s*hidden/);
    const open = bodyOf(rules, '.nav .panel.open');
    expect(open).toMatch(/visibility:\s*visible/);
  });

  it('2 列网格 + 当前项用 --brand-weak 高亮（与原型像素一致）', () => {
    expect(bodyOf(rules, '.nav .p-grid')).toMatch(/grid-template-columns:\s*1fr 1fr/);
    expect(bodyOf(rules, '.nav .panel .p-item[aria-current="page"]')).toMatch(/background:\s*var\(--brand-weak\)/);
  });

  it('P7 回归：窄屏入口仍可见、面板向右弹出，且不再隐藏 .grp-body', () => {
    const narrow = blockOf(css, '@media (max-width: 900px)');
    expect(narrow).not.toBe('');
    expect(narrow).not.toContain('grp-body');
    // 入口自己不能被 display:none 掉（只隐藏 .lbl / .cur / .caret 子元素）
    expect(narrow).toMatch(/\.nav \.entry \{[^}]*width:\s*40px/);
    expect(narrow).toMatch(/\.nav \.entry \.lbl, \.nav \.entry \.cur, \.nav \.entry \.caret \{ display: none; \}/);
    // 面板改 fixed 向右弹出（脱离 60px 侧栏裁切）
    expect(narrow).toMatch(/\.nav \.panel \{ position: fixed; left: 68px/);
  });

  it('展开方向可见性立即生效（否则 nextTick 时元素不可聚焦 → 键盘焦点丢失）', () => {
    const open = bodyOf(rules, '.nav .panel.open');
    expect(open).toMatch(/transition:[^;]*visibility 0s/);
    // 收起方向保留 120ms 延迟，淡出不被瞬间截断
    expect(bodyOf(rules, '.nav .panel')).toMatch(/transition:[^;]*visibility 0s linear \.12s/);
  });

  it('降级动画：prefers-reduced-motion 下关闭过渡', () => {
    const reduce = blockOf(css, '@media (prefers-reduced-motion: reduce)');
    expect(reduce).toContain('.nav .panel');
  });
});
