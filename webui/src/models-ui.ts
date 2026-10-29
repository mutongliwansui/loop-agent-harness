// 模型页（#/models）纯逻辑与图标表（需求 20261029-004 · 方案 D12）
//
// 本模块不 import 任何 .vue 与 DOM API，是纯数据 + 纯函数，可在 Node 下直测。
// 图标为自绘 16×16 线性 SVG（viewBox 0 0 16 16 / stroke 1.6 / currentColor / 圆头圆角），
// 其中 chip / pulse 两条路径与 nav-menu.ts 的 NAV_ICON_PATHS 逐字节一致（由单测锁定，防漂移）。
import { fmtMs, ttftTone } from './bench-format';

export type ModelIconKey =
  | 'chip' // 模型
  | 'pulse' // 连通性测试
  | 'gauge' // 性能测速
  | 'check' // 生效 / 确认
  | 'trash' // 删除
  | 'plus' // 添加
  | 'arrow' // 设为生效
  | 'search' // 过滤
  | 'refresh' // 刷新
  | 'close' // 关闭
  | 'alert' // 行内错误
  | 'caret'; // 说明折叠指示

/** 16×16 线性图标的 inner SVG（外层属性由 modelIconSvg() 统一给） */
export const MODEL_ICON_PATHS: Record<ModelIconKey, string> = {
  // 与 nav-menu.ts NAV_ICON_PATHS.chip 一致
  chip: '<rect x="3.4" y="3.4" width="9.2" height="9.2" rx="2"/><rect x="6.3" y="6.3" width="3.4" height="3.4" rx=".9"/>',
  // 与 nav-menu.ts NAV_ICON_PATHS.pulse 一致
  pulse: '<path d="M1.8 8h2.5l1.5-3.6L8.5 12l1.5-4h4.2"/>',
  // 半圆表盘 + 指针（测速）
  gauge: '<path d="M2.6 11.4a5.4 5.4 0 1 1 10.8 0"/><path d="M8 11.4 11 8"/>',
  check: '<path d="M3.4 8.4l3 3 6.2-6.6"/>',
  trash: '<path d="M3.4 5.2h9.2M6.4 5.2V3.8h3.2v1.4M4.8 5.2l.6 7.2h5.2l.6-7.2"/>',
  plus: '<path d="M8 3.6v8.8M3.6 8h8.8"/>',
  arrow: '<path d="M3.4 8h9.2M9 4.4 12.6 8 9 11.6"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 13.6 13.6"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.7-3.8"/><path d="M13.2 2.8v2.6h-2.6"/>',
  close: '<path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/>',
  alert: '<circle cx="8" cy="8" r="6.2"/><path d="M8 5.2v3.6M8 10.8v.4"/>',
  caret: '<path d="M6 4l4 4-4 4"/>',
};

/** 完整 `<svg>` 串：供 `v-html` 渲染（尺寸由 CSS 控制） */
export function modelIconSvg(key: ModelIconKey, strokeWidth = 1.6): string {
  const d = MODEL_ICON_PATHS[key] ?? MODEL_ICON_PATHS.chip;
  return (
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${strokeWidth}"` +
    ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
  );
}

/** 行卡所需的最小 profile 形状（与 GET /models 响应同构） */
export interface ProfileLike {
  alias: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  temperature?: number;
  isCurrent: boolean;
}

/**
 * baseUrl → 主机名（D1：长串改短串展示，完整值放 title）。
 * 非法 URL 退化为「去掉协议前缀与结尾斜杠」的原文，绝不抛错。
 */
export function hostOf(baseUrl: string): string {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).host || raw;
  } catch {
    return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  }
}

/** 生效行恒排第一（D2：原「当前生效」卡片合并为置顶行），其余保持后端返回顺序（稳定排序） */
export function sortActiveFirst<T extends { isCurrent: boolean }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
}

/** 过滤：别名 / 型号 / baseUrl 子串，大小写不敏感；空查询返回原顺序（D11） */
export function filterProfiles<T extends { alias: string; name: string; baseUrl: string }>(
  rows: readonly T[],
  query: string,
): T[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) =>
    [r.alias, r.name, r.baseUrl].some((v) => (v ?? '').toLowerCase().includes(q)),
  );
}

export type PillTone = 'brand' | 'ok' | 'bad' | 'warn' | 'dim';

/** 状态胶囊：tone 决定配色，text 为可见文案，title 为悬停解释 */
export interface Pill {
  tone: PillTone;
  text: string;
  title?: string;
  icon?: ModelIconKey;
}

/** 单模型最近一次测速摘要（来自 GET /models/bench/history） */
export interface PerfLike {
  ttft: number | null;
  okCount: number;
  total: number;
}

export interface TestLike {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * 行卡状态区（D4：中性为「未测试 / 未测速」，绿色只给成功，红色只给真失败）。
 * 恒返回 2~3 个 pill：生效（可选）+ 连通性 + 性能。
 */
export function modelPills(input: {
  isCurrent: boolean;
  test?: TestLike | null;
  perf?: PerfLike | null;
}): Pill[] {
  const pills: Pill[] = [];

  if (input.isCurrent) pills.push({ tone: 'brand', text: '生效中', icon: 'check' });

  const t = input.test;
  if (t && t.ok) {
    pills.push({ tone: 'ok', text: `连通 ${Math.round(t.latencyMs)}ms`, title: '连通性测试通过（收到首块即断开，近免费）' });
  } else if (t) {
    pills.push({ tone: 'bad', text: '连通失败', title: t.error || '连通性测试失败' });
  } else {
    pills.push({ tone: 'dim', text: '未测试', title: '尚未做连通性测试' });
  }

  const pf = input.perf;
  if (pf && pf.ttft !== null && pf.ttft !== undefined) {
    const tone = ttftTone(pf.ttft);
    pills.push({
      tone: tone === 'good' ? 'ok' : tone === 'warn' ? 'warn' : 'bad',
      text: `TTFT ${fmtMs(pf.ttft)}`,
      title: `最近一次测速：${pf.okCount}/${pf.total} 轮成功`,
    });
  } else if (pf) {
    pills.push({ tone: 'bad', text: '测速全失败', title: `最近一次测速 ${pf.okCount}/${pf.total} 轮成功` });
  } else {
    pills.push({ tone: 'dim', text: '未测速', title: '尚未做性能测速' });
  }

  return pills;
}

/** 登记表单原始输入（全部为字符串，便于与 input v-model 直连） */
export interface ModelFormInput {
  alias: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  temperature: string;
}

/** 字段级错误（空对象 = 通过；键名与表单字段一一对应） */
export interface ModelFormErrors {
  alias?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: string;
}

/**
 * 登记表单行内校验（D7）：必填四项 + baseUrl 协议 + temperature 数值域。
 * 返回空对象表示可提交；不抛错、不做网络判断。
 */
export function validateModelForm(input: ModelFormInput): ModelFormErrors {
  const errs: ModelFormErrors = {};

  const alias = (input.alias ?? '').trim();
  if (!alias) errs.alias = '别名必填';
  else if (/\s/.test(alias)) errs.alias = '别名不能包含空格';

  if (!(input.name ?? '').trim()) errs.name = '型号必填';

  const baseUrl = (input.baseUrl ?? '').trim();
  if (!baseUrl) errs.baseUrl = 'Base URL 必填';
  else if (!/^https?:\/\/\S+$/i.test(baseUrl)) errs.baseUrl = '需要以 http:// 或 https:// 开头';

  if (!(input.apiKey ?? '').trim()) errs.apiKey = 'API Key 必填';

  const temp = (input.temperature ?? '').trim();
  if (temp !== '') {
    const n = Number(temp);
    if (!Number.isFinite(n)) errs.temperature = 'temperature 必须为数字';
    else if (n < 0 || n > 2) errs.temperature = 'temperature 需在 0 ~ 2 之间';
  }

  return errs;
}

/** 错误对象是否含任一字段错误 */
export function hasErrors(errs: ModelFormErrors): boolean {
  return Object.keys(errs).length > 0;
}
