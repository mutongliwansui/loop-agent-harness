/**
 * 模型页纯逻辑测试（需求 20261029-004 · 方案 D12）
 *
 * 覆盖 webui/src/models-ui.ts：
 * - hostOf：baseUrl → 主机名（长串短路展示的纯函数基础）
 * - sortActiveFirst / filterProfiles：生效置顶与关键字过滤
 * - modelPills：状态胶囊色调（UI 不变量——未测试/未测速走中性 dim，绿色只给成功，红色只给真失败）
 * - validateModelForm：登记表单行内校验
 * - modelIconSvg：内联 SVG 生成 + 跨模块图标路径防漂移
 *
 * 行卡 DOM 渲染与抽屉交互无 jsdom，改由 CDP 真实渲染断言（见设计方案第八节）。
 */
import { describe, it, expect } from 'vitest';
import {
  MODEL_ICON_PATHS,
  filterProfiles,
  hasErrors,
  hostOf,
  modelIconSvg,
  modelPills,
  sortActiveFirst,
  validateModelForm,
} from '../webui/src/models-ui.js';
import { NAV_ICON_PATHS } from '../webui/src/nav-menu.js';

describe('hostOf', () => {
  it('完整 URL 取主机名（去掉协议与路径）', () => {
    expect(hostOf('https://api.deepseek.com/v1')).toBe('api.deepseek.com');
    expect(hostOf('https://tokenhub.haizhi.com')).toBe('tokenhub.haizhi.com');
  });

  it('带端口时保留端口', () => {
    expect(hostOf('http://127.0.0.1:11434/v1')).toBe('127.0.0.1:11434');
  });

  it('非法 URL 退化为去协议前缀与结尾斜杠的原文', () => {
    expect(hostOf('api.deepseek.com/')).toBe('api.deepseek.com');
  });

  it('空值与空白返回空串（不抛错）', () => {
    expect(hostOf('')).toBe('');
    expect(hostOf('   ')).toBe('');
  });
});

describe('sortActiveFirst', () => {
  const rows = [
    { alias: 'a', isCurrent: false },
    { alias: 'b', isCurrent: true },
    { alias: 'c', isCurrent: false },
  ];

  it('生效行恒排第一', () => {
    expect(sortActiveFirst(rows).map((r) => r.alias)).toEqual(['b', 'a', 'c']);
  });

  it('非生效行保持原有相对顺序（稳定排序）', () => {
    const out = sortActiveFirst(rows).filter((r) => !r.isCurrent).map((r) => r.alias);
    expect(out).toEqual(['a', 'c']);
  });

  it('不修改入参', () => {
    const before = rows.map((r) => r.alias);
    sortActiveFirst(rows);
    expect(rows.map((r) => r.alias)).toEqual(before);
  });

  it('无生效行时原样返回', () => {
    const none = [{ alias: 'x', isCurrent: false }, { alias: 'y', isCurrent: false }];
    expect(sortActiveFirst(none).map((r) => r.alias)).toEqual(['x', 'y']);
  });
});

describe('filterProfiles', () => {
  const rows = [
    { alias: 'deepseek-flash', name: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' },
    { alias: 'glm-5.3-flash', name: 'glm/glm-5.3-flash', baseUrl: 'https://tokenhub.haizhi.com' },
  ];

  it('空查询返回全部', () => {
    expect(filterProfiles(rows, '')).toHaveLength(2);
    expect(filterProfiles(rows, '   ')).toHaveLength(2);
  });

  it('按别名子串命中', () => {
    expect(filterProfiles(rows, 'glm').map((r) => r.alias)).toEqual(['glm-5.3-flash']);
  });

  it('按主机名子串命中（主机名来自 baseUrl）', () => {
    expect(filterProfiles(rows, 'tokenhub').map((r) => r.alias)).toEqual(['glm-5.3-flash']);
  });

  it('大小写不敏感', () => {
    expect(filterProfiles(rows, 'DEEPSEEK')).toHaveLength(1);
  });

  it('无命中返回空数组', () => {
    expect(filterProfiles(rows, 'zzz')).toEqual([]);
  });
});

describe('modelPills', () => {
  it('生效 + 连通成功 + TTFT 良好 → brand/ok/ok', () => {
    const pills = modelPills({ isCurrent: true, test: { ok: true, latencyMs: 328 }, perf: { ttft: 542, okCount: 3, total: 3 } });
    expect(pills.map((p) => p.tone)).toEqual(['brand', 'ok', 'ok']);
    expect(pills[0].text).toBe('生效中');
    expect(pills[1].text).toBe('连通 328ms');
    expect(pills[2].text).toBe('TTFT 542ms');
  });

  it('未测试 + 未测速 → 两个中性 dim（不出现黄色告警）', () => {
    const pills = modelPills({ isCurrent: false });
    expect(pills.map((p) => p.tone)).toEqual(['dim', 'dim']);
    expect(pills.map((p) => p.text)).toEqual(['未测试', '未测速']);
  });

  it('连通失败带错误原因进 title', () => {
    const pills = modelPills({ isCurrent: false, test: { ok: false, latencyMs: 0, error: 'HTTP 401' } });
    expect(pills[0].tone).toBe('bad');
    expect(pills[0].title).toBe('HTTP 401');
  });

  it('测速全失败 → bad，未测速不出现在结果里', () => {
    const pills = modelPills({ isCurrent: false, perf: { ttft: null, okCount: 0, total: 1 } });
    expect(pills.map((p) => p.text)).toEqual(['未测试', '测速全失败']);
    expect(pills[1].tone).toBe('bad');
  });

  it('TTFT 偏慢（>800ms 且 <=2000ms）用 warn 而非 bad', () => {
    const pills = modelPills({ isCurrent: false, perf: { ttft: 1200, okCount: 1, total: 1 } });
    expect(pills[1].tone).toBe('warn');
  });

  it('TTFT 超过 2000ms 用 bad', () => {
    const pills = modelPills({ isCurrent: false, perf: { ttft: 2600, okCount: 1, total: 1 } });
    expect(pills[1].tone).toBe('bad');
  });

  it('性能 pill 的 title 带轮次成功率', () => {
    const pills = modelPills({ isCurrent: false, perf: { ttft: 500, okCount: 2, total: 3 } });
    expect(pills[1].title).toContain('2/3');
  });
});

describe('validateModelForm', () => {
  const ok = { alias: 'deepseek-flash', name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-xxx', temperature: '' };

  it('合法输入返回空对象', () => {
    expect(validateModelForm(ok)).toEqual({});
    expect(hasErrors(validateModelForm(ok))).toBe(false);
  });

  it('四项必填缺失各报一条', () => {
    const errs = validateModelForm({ alias: '', name: '', baseUrl: '', apiKey: '', temperature: '' });
    expect(Object.keys(errs).sort()).toEqual(['alias', 'apiKey', 'baseUrl', 'name']);
    expect(hasErrors(errs)).toBe(true);
  });

  it('baseUrl 缺协议前缀报错', () => {
    expect(validateModelForm({ ...ok, baseUrl: 'api.deepseek.com' }).baseUrl).toBe('需要以 http:// 或 https:// 开头');
  });

  it('baseUrl 支持 http', () => {
    expect(validateModelForm({ ...ok, baseUrl: 'http://127.0.0.1:11434/v1' }).baseUrl).toBeUndefined();
  });

  it('别名含空格报错', () => {
    expect(validateModelForm({ ...ok, alias: 'deep seek' }).alias).toBe('别名不能包含空格');
  });

  it('temperature 非数字报错', () => {
    expect(validateModelForm({ ...ok, temperature: 'abc' }).temperature).toBe('temperature 必须为数字');
  });

  it('temperature 越界报错（0 ~ 2）', () => {
    expect(validateModelForm({ ...ok, temperature: '3' }).temperature).toBe('temperature 需在 0 ~ 2 之间');
    expect(validateModelForm({ ...ok, temperature: '-1' }).temperature).toBe('temperature 需在 0 ~ 2 之间');
  });

  it('temperature 合法值（含边界与小数）通过', () => {
    for (const v of ['0', '0.7', '2']) {
      expect(validateModelForm({ ...ok, temperature: v }).temperature).toBeUndefined();
    }
  });
});

describe('modelIconSvg', () => {
  it('生成 16×16 线性 SVG 骨架', () => {
    const s = modelIconSvg('chip');
    expect(s).toContain('viewBox="0 0 16 16"');
    expect(s).toContain('stroke="currentColor"');
    expect(s).toContain('stroke-width="1.6"');
    expect(s).toContain('stroke-linecap="round"');
    expect(s).toContain('aria-hidden="true"');
  });

  it('可覆盖描边宽度', () => {
    expect(modelIconSvg('check', 2)).toContain('stroke-width="2"');
  });

  it('未知 key 回落 chip 而不抛错', () => {
    const s = modelIconSvg('nope' as never);
    expect(s).toContain(MODEL_ICON_PATHS.chip);
  });

  it('每个图标都是非空路径（无遗漏项）', () => {
    for (const [key, d] of Object.entries(MODEL_ICON_PATHS)) {
      expect(d.length, key).toBeGreaterThan(10);
      expect(d, key).toMatch(/^<(path|circle|rect)/);
    }
  });
});

describe('跨模块图标防漂移', () => {
  it('chip 与 nav-menu 的 chip 逐字节一致', () => {
    expect(MODEL_ICON_PATHS.chip).toBe(NAV_ICON_PATHS.chip);
  });

  it('pulse 与 nav-menu 的 pulse 逐字节一致', () => {
    expect(MODEL_ICON_PATHS.pulse).toBe(NAV_ICON_PATHS.pulse);
  });
});
