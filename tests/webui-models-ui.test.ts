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
  MODEL_PROVIDERS,
  advancedCount,
  buildAdvanced,
  filterProfiles,
  hasAdvancedErrors,
  hasErrors,
  hostOf,
  isFailedModel,
  modelIconSvg,
  modelPills,
  providerMetaOf,
  providerOf,
  sortActiveFirst,
  sortProfiles,
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

  it('编辑模式：别名跳过校验、API Key 可留空', () => {
    const errs = validateModelForm({ ...ok, alias: '', apiKey: '' }, { editing: true });
    expect(errs).toEqual({});
    // 型号 / Base URL / temperature 仍照常校验
    expect(validateModelForm({ ...ok, name: '', apiKey: '' }, { editing: true }).name).toBe('型号必填');
    expect(validateModelForm({ ...ok, baseUrl: 'x', apiKey: '' }, { editing: true }).baseUrl).toBeTruthy();
  });
});

describe('advanced 表单（需求 20261111-001）', () => {
  const base = { alias: 'x', name: 'n', baseUrl: 'https://a.example.com', apiKey: 'sk', temperature: '' };

  it('全部留空不产生错误，且不下发 advanced', () => {
    const input = { ...base, headers: [] };
    expect(validateModelForm(input)).toEqual({});
    expect(buildAdvanced(input)).toBeUndefined();
    expect(advancedCount(input)).toBe(0);
  });

  it('数值越界 / 非整数逐项报错', () => {
    expect(validateModelForm({ ...base, maxTokens: '0' }).maxTokens).toBeTruthy();
    expect(validateModelForm({ ...base, maxTokens: '1.5' }).maxTokens).toBeTruthy();
    expect(validateModelForm({ ...base, topP: '1.1' }).topP).toBeTruthy();
    expect(validateModelForm({ ...base, topK: '-1' }).topK).toBeTruthy();
    expect(validateModelForm({ ...base, topK: '2.5' }).topK).toBeTruthy();
    expect(validateModelForm({ ...base, frequencyPenalty: '-2.1' }).frequencyPenalty).toBeTruthy();
    expect(validateModelForm({ ...base, timeoutMs: '999' }).timeoutMs).toBeTruthy();
    // 边界值通过
    expect(validateModelForm({ ...base, maxTokens: '1' }).maxTokens).toBeUndefined();
    expect(validateModelForm({ ...base, topP: '0' }).topP).toBeUndefined();
    expect(validateModelForm({ ...base, topP: '1' }).topP).toBeUndefined();
    expect(validateModelForm({ ...base, topK: '0' }).topK).toBeUndefined();
    expect(validateModelForm({ ...base, frequencyPenalty: '-2' }).frequencyPenalty).toBeUndefined();
    expect(validateModelForm({ ...base, frequencyPenalty: '2' }).frequencyPenalty).toBeUndefined();
    expect(validateModelForm({ ...base, timeoutMs: '1000' }).timeoutMs).toBeUndefined();
  });

  it('请求头校验：空名 / 非法字符 / 系统头 / 缺值', () => {
    expect(validateModelForm({ ...base, headers: [{ key: '', value: 'x' }] }).headers).toBeTruthy();
    expect(validateModelForm({ ...base, headers: [{ key: 'bad name', value: 'x' }] }).headers).toBeTruthy();
    expect(validateModelForm({ ...base, headers: [{ key: 'Authorization', value: 'x' }] }).headers).toBeTruthy();
    expect(validateModelForm({ ...base, headers: [{ key: 'X-Test', value: '' }] }).headers).toBeTruthy();
    // 整行空白忽略；合法头部通过
    expect(validateModelForm({ ...base, headers: [{ key: '', value: '' }] }).headers).toBeUndefined();
    expect(validateModelForm({ ...base, headers: [{ key: 'api-version', value: '2024-10-21' }] }).headers).toBeUndefined();
  });

  it('buildAdvanced：有效项转为数字，空项与空白请求头丢弃', () => {
    const input = {
      ...base,
      maxTokens: ' 2048 ',
      topP: '0.7',
      topK: '',
      frequencyPenalty: '',
      timeoutMs: '120000',
      headers: [
        { key: ' api-version ', value: ' 2024-10-21 ' },
        { key: '', value: '' },
        { key: 'X-Empty', value: '' },
      ],
    };
    expect(buildAdvanced(input)).toEqual({
      maxTokens: 2048,
      topP: 0.7,
      timeoutMs: 120000,
      headers: { 'api-version': '2024-10-21' },
    });
    expect(advancedCount(input)).toBe(4);
  });

  it('hasAdvancedErrors 只认高级字段', () => {
    expect(hasAdvancedErrors({ name: 'x' })).toBe(false);
    expect(hasAdvancedErrors({ headers: 'x' })).toBe(true);
    expect(hasAdvancedErrors({ timeoutMs: 'x' })).toBe(true);
  });
});

describe('providerOf / providerMetaOf', () => {
  it('按域名特征识别服务商', () => {
    expect(providerOf('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(providerOf('https://open.bigmodel.cn/api/paas/v4')).toBe('zhipu');
    expect(providerOf('https://api.openai.com/v1')).toBe('openai');
    expect(providerOf('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('qwen');
    expect(providerOf('https://openrouter.ai/api/v1')).toBe('gateway');
    expect(providerOf('http://127.0.0.1:11434/v1')).toBe('other');
    expect(providerOf('')).toBe('other');
  });

  it('返回 tile 缩写与中文标签；每个服务商都有元数据', () => {
    expect(providerMetaOf('https://api.deepseek.com').text).toBe('DS');
    expect(providerMetaOf('https://open.bigmodel.cn').label).toBe('智谱');
    for (const meta of Object.values(MODEL_PROVIDERS)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.text.length).toBe(2);
    }
  });
});

describe('sortProfiles', () => {
  const rows = [
    { alias: 'zeta', isCurrent: false },
    { alias: 'alpha', isCurrent: true },
    { alias: 'beta', isCurrent: false },
  ];

  it('active：生效优先，同档按别名 A→Z', () => {
    expect(sortProfiles(rows, 'active').map((r) => r.alias)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('alias：纯别名升序', () => {
    expect(sortProfiles(rows, 'alias').map((r) => r.alias)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('ttft：升序，无数据沉底', () => {
    const ttft: Record<string, number | null> = { zeta: 900, alpha: 300, beta: null };
    expect(sortProfiles(rows, 'ttft', (r) => ttft[r.alias]).map((r) => r.alias)).toEqual(['alpha', 'zeta', 'beta']);
  });

  it('不修改入参', () => {
    const copy = [...rows];
    sortProfiles(rows, 'alias');
    expect(rows).toEqual(copy);
  });
});

describe('isFailedModel', () => {
  it('连通失败 → true；测速全失败 → true', () => {
    expect(isFailedModel({ test: { ok: false, latencyMs: 0 } })).toBe(true);
    expect(isFailedModel({ perf: { ttft: null, okCount: 0, total: 3 } })).toBe(true);
  });

  it('未测试 / 未测速 / 成功 → false（中性态不计入需关注）', () => {
    expect(isFailedModel({})).toBe(false);
    expect(isFailedModel({ test: { ok: true, latencyMs: 300 } })).toBe(false);
    expect(isFailedModel({ perf: { ttft: 500, okCount: 3, total: 3 } })).toBe(false);
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

  // 回归：20261029-004 线上样式事故 —— SVG 只有 viewBox 而无声明的 width/height 时，
  // 一旦宿主 CSS 选择器失配（v-html 的 <span> 中间层使 `.mv-filter > svg` 落空），
  // 浏览器按默认 300×150 渲染，过滤图标把整行撑爆。必须内联默认尺寸兜住。
  it('恒带内联 width/height 默认值（CSS 失配时不退化成 300×150）', () => {
    for (const key of Object.keys(MODEL_ICON_PATHS) as (keyof typeof MODEL_ICON_PATHS)[]) {
      const s = modelIconSvg(key);
      expect(s, key).toContain('width="16"');
      expect(s, key).toContain('height="16"');
    }
  });

  it('内联尺寸可按第三参数覆盖（供需要大图标的场合）', () => {
    const s = modelIconSvg('chip', 1.6, 26);
    expect(s).toContain('width="26"');
    expect(s).toContain('height="26"');
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
