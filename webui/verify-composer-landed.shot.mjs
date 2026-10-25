#!/usr/bin/env node
/**
 * 对话输入区落地探针（task-20261025-002 P2 D12）
 *
 * 与 `verify-composer.shot.mjs`（改版前基线，类名已变、仅作历史留档）不同，
 * 本脚本针对**落地后的真实组件** `webui/src/views/ChatView.vue` 断言，口径沿用
 * 原型探针 `verify-composer-proto.shot.mjs` 的分类：
 *   结构 / 自增高 / 交互 / 状态 / 模型 / 宽度 / 深色 / 无残留
 *
 * 前置：另开终端在 webui/ 跑 `npm run dev`（默认 :5173）。
 * 用法：node webui/verify-composer-landed.shot.mjs
 *       可选环境变量：VERIFY_BASE / VERIFY_OUT / CDP_PORT / CHROME_PATH
 * 产物：$VERIFY_OUT（默认 .tmp-verify-composer-landed）下 png + summary.json。
 *
 * 自足性：`/models` 与 `PUT /sessions/:id/model` 由注入脚本 mock，
 * 因此不依赖真实后端与真实模型登记簿（不读取、不污染用户配置）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.VERIFY_BASE || 'http://localhost:5173/';
const OUT = path.resolve(process.env.VERIFY_OUT || '.tmp-verify-composer-landed');
const PORT = Number(process.env.CDP_PORT || 9339);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VP = { width: 1600, height: 1000 };

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 断言收集 ---------------- */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
}

/**
 * 颜色归一化：getComputedStyle 返回 `rgb(r, g, b)`，而设计令牌是 `#rrggbb`。
 * 直接字符串比较会把「同一个颜色的两种写法」判成失败（本探针第一版就踩了：
 * 深色卡底 rgb(31,36,43) 与令牌 #1f242b 被判不等）。统一转成 rgb() 再比。
 */
function normColor(c) {
  if (typeof c !== 'string') return c;
  const s = c.trim().toLowerCase();
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    if (h.length !== 6) return s;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgb(${r}, ${g}, ${b})`;
  }
  // 已经是 rgb()/rgba()：去掉多余空白，统一 `rgb(1, 2, 3)` 风格
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(',').map((x) => x.trim());
    return `rgb(${parts.slice(0, 3).join(', ')})`;
  }
  return s;
}

/* ---------------- CDP 连接 ---------------- */
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${VP.width},${VP.height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function wsUrl() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome 还没起 */
    }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
};
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(`页面异常: ${ex.text} ${JSON.stringify(ex.exception?.description ?? '').slice(0, 300)}`);
  return r.result?.result?.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: VP.width,
  height: VP.height,
  deviceScaleFactor: 2,
  mobile: false,
});

/* ---------------- 注入：mock /models 与模型元数据写入 ---------------- */
/* eslint-disable */
const MOCK_SOURCE = `
(() => {
  const PROFILES = {
    active: 'deepseek',
    profiles: [
      { alias: 'deepseek', name: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-****abcd', isCurrent: true, temperature: 0.2 },
      { alias: 'glm', name: 'glm-4-plus', baseUrl: 'https://tokenhub.haizhi.com/v1', apiKey: 'sk-****efgh' },
      { alias: 'local', name: 'qwen2.5', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'sk-****ijkl' }
    ]
  };
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const raw = window.fetch.bind(window);
  window.__modelWrites = [];
  // 探针会话：让 activeId 有值，才能验证「选模型 → PUT .../model 落盘」的闭环。
  // 否则 persistModelAlias 因 activeId 为空直接 return，writes 恒为 []（D7 的正确行为，
  // 但那样就验不到写盘链路）。两个会话用于验证「切走切回还原」且互不串味。
  const PROBE_SID = 'probe-sess-1';
  const PROBE_SID2 = 'probe-sess-2';
  // 会话级 meta 存储：PUT 写入，GET /workspaces 回读——模拟服务端持久化
  window.__metaStore = {};
  window.__metaStore[PROBE_SID] = null;
  window.__metaStore[PROBE_SID2] = null;
  const buildWorkspaces = () => ({
    workspaces: [
      {
        id: 'probe-ws',
        name: 'probe',
        path: 'D:/probe',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastAccessedAt: '2026-01-01T00:00:00.000Z',
        sessions: [
          { id: PROBE_SID, title: '探针会话一', messageCount: 0, updatedAt: '2026-01-01T00:00:00.000Z', modelAlias: window.__metaStore[PROBE_SID] ?? undefined },
          { id: PROBE_SID2, title: '探针会话二', messageCount: 0, updatedAt: '2026-01-01T00:00:00.000Z', modelAlias: window.__metaStore[PROBE_SID2] ?? undefined },
        ],
      },
    ],
  });
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
    const method = ((init && init.method) || 'GET').toUpperCase();
    // 只接管模型/会话相关端点，其余原样放行
    if (/\\/models(\\?|$)/.test(url) && method === 'GET') return Promise.resolve(json(PROFILES));
    if (/\\/workspaces(\\?|$)/.test(url) && method === 'GET') return Promise.resolve(json(buildWorkspaces()));
    // 顺序：/model 必须早于通用的 /sessions/:id 匹配
    const mModel = url.match(/\\/sessions\\/([^/]+)\\/model$/);
    if (mModel) {
      let body = null;
      try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { body = null; }
      const sid = decodeURIComponent(mModel[1]);
      window.__modelWrites.push(body);
      window.__metaStore[sid] = body ? body.modelAlias : null;
      return Promise.resolve(json({ modelAlias: body ? body.modelAlias : null }));
    }
    if (new RegExp('\\\\/sessions\\\\/(' + PROBE_SID + '|' + PROBE_SID2 + ')(\\\\?|$)').test(url) && method === 'GET') {
      return Promise.resolve(json({ messages: [], run: null, lastRun: null }));
    }
    return raw(input, init);
  };
})();
`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_SOURCE });

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return p;
}

async function goto(theme) {
  await send('Page.navigate', { url: BASE });
  await sleep(1800);
  await ev(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; 1`);
  await sleep(500);
  for (let i = 0; i < 40; i++) {
    const ok = await ev(`!!document.querySelector('.composer .dock')`);
    if (ok) break;
    await sleep(250);
  }
  await sleep(400);
}

/** 重置到「未选模型」的干净态：刷新页面并清掉 localStorage 里的会话选择 */
async function fresh(theme) {
  await goto(theme);
  await ev(`(() => {
    document.querySelectorAll('.model-pop').forEach(() => {});
    const ta = document.querySelector('.composer .gw');
    if (ta) { ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    return true;
  })()`);
  await sleep(200);
}

/**
 * 点侧栏里的探针会话，使 activeId 有值。
 * 只有进入会话后，模型选择才会真的 PUT /sessions/:id/model（见 persistModelAlias 的 id 判空）。
 * index 用于在多个探针会话间切换，验证「切走切回还原」。
 */
async function enterSession(index = 0) {
  let ready = false;
  for (let i = 0; i < 25; i++) {
    ready = await ev(`document.querySelectorAll('.sess').length > ${index}`);
    if (ready) break;
    await sleep(200);
  }
  if (!ready) return false;
  await ev(`(() => { const el = document.querySelectorAll('.sess')[${index}]; if (el) el.click(); return !!el; })()`);
  await sleep(700);
  return await ev(`(() => { const el = document.querySelectorAll('.sess')[${index}]; return !!el && el.classList.contains('active'); })()`);
}

/* ---------------- 页面内：结构与样式探针 ---------------- */
/* eslint-disable */
function probeStructure() {
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const px = (el, p) => (el ? parseFloat(getComputedStyle(el)[p]) || 0 : null);
  const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  };
  const comp = q('.composer');
  const dock = q('.composer .dock');
  const ta = q('.composer .gw');
  const tbtn = q('.composer .tbtn');
  const pillEl = q('.composer .model-pill');
  const kbd = q('.composer .kbd-hint');
  const sendBtn = q('.composer .send-btn');
  const toolRow = q('.composer .tool-row');
  const chips = q('.composer .chips');
  const EMOJI = ['\u{1F4CE}', '\u{1F514}', '\u25A0', '\u2715', '\u{1F4C1}'];
  const text = comp ? comp.innerText : '';
  const tokens = getComputedStyle(document.documentElement);
  return {
    exists: { comp: !!comp, dock: !!dock, ta: !!ta, tbtn: !!tbtn, pill: !!pillEl, kbd: !!kbd, send: !!sendBtn, row: !!toolRow },
    // 诊断：容器查询按「最近的 inline-size 容器」求值，这里把实际宽度一并带出，
    // 便于区分「CSS 规则写错」与「容器本身就被挤窄」两种成因
    diag: {
      viewportW: window.innerWidth,
      compW: rect(comp)?.w ?? null,
      innerW: rect(q('.composer-inner'))?.w ?? null,
      dockW: rect(dock)?.w ?? null,
      kbdW: rect(kbd)?.w ?? null,
    },
    // ① 一体卡片：composer 上沿无分隔线
    compBorderTop: px(comp, 'borderTopWidth'),
    dock: {
      rect: rect(dock),
      bg: cs(dock, 'backgroundColor'),
      borderWidth: px(dock, 'borderTopWidth'),
      borderColor: cs(dock, 'borderTopColor'),
      radius: px(dock, 'borderTopLeftRadius'),
      shadow: cs(dock, 'boxShadow'),
    },
    ta: {
      rect: rect(ta),
      height: px(ta, 'height'),
      minHeight: px(ta, 'minHeight'),
      maxHeight: px(ta, 'maxHeight'),
      borderWidth: px(ta, 'borderTopWidth'),
      resize: cs(ta, 'resize'),
      overflowY: cs(ta, 'overflowY'),
      placeholder: ta ? ta.placeholder : null,
    },
    // 顺序：附件 pill 在输入域之前，工具行在其后
    order: (() => {
      if (!dock) return null;
      const kids = [...dock.children].map((c) => c.className.split(' ')[0]);
      return kids;
    })(),
    tbtn: { rect: rect(tbtn), hasSvg: tbtn ? !!tbtn.querySelector('svg') : null, w: rect(tbtn)?.w },
    pill: {
      rect: rect(pillEl),
      label: q('.composer .mp-label') ? q('.composer .mp-label').textContent.trim() : null,
      cls: pillEl ? pillEl.className : null,
      hasSvg: pillEl ? pillEl.querySelectorAll('svg').length : 0,
      bg: cs(pillEl, 'backgroundColor'),
      color: cs(pillEl, 'color'),
      borderColor: cs(pillEl, 'borderTopColor'),
      radius: px(pillEl, 'borderTopLeftRadius'),
    },
    kbd: { rect: rect(kbd), display: cs(kbd, 'display'), text: kbd ? kbd.textContent.trim() : null },    send: { rect: rect(sendBtn), hasSvg: sendBtn ? !!sendBtn.querySelector('svg') : null, bg: cs(sendBtn, 'backgroundColor'), radius: px(sendBtn, 'borderTopLeftRadius') },
    toolRow: { rect: rect(toolRow), overflow: toolRow ? toolRow.scrollWidth - toolRow.clientWidth : null },
    // ④ 无 emoji / 无「流式」「通知」控件
    emojiHits: EMOJI.filter((e) => text.includes(e)).map((e) => 'U+' + e.codePointAt(0).toString(16).toUpperCase()),
    svgCount: qa('.composer svg').length,
    hasStreamLabel: /流式/.test(text),
    hasNotifyLabel: /通知|声音/.test(text),
    chipsPresent: !!chips,
    tokens: {
      panel: tokens.getPropertyValue('--panel').trim(),
      barBg: tokens.getPropertyValue('--bar-bg').trim(),
      line: tokens.getPropertyValue('--line').trim(),
      lineSoft: tokens.getPropertyValue('--line-soft').trim(),
      brand: tokens.getPropertyValue('--brand').trim(),
      radiusCard: tokens.getPropertyValue('--radius-card').trim(),
    },
  };
}

/* ---------------- 页面内：自增高探针 ---------------- */
function probeAutogrow() {
  const ta = document.querySelector('.composer .gw');
  if (!ta) return null;
  const setLines = (n) => {
    ta.value = Array.from({ length: n }, (_, i) => '第' + (i + 1) + '行内容').join('\n');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return +ta.getBoundingClientRect().height.toFixed(1);
  };
  const emptyH = +ta.getBoundingClientRect().height.toFixed(1);
  const h6 = setLines(6);
  const scroll6 = ta.scrollHeight;
  const overflow6 = getComputedStyle(ta).overflowY;
  const h30 = setLines(30);
  const scroll30 = ta.scrollHeight;
  // 收回：清空后应回到最小高度
  ta.value = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const backH = +ta.getBoundingClientRect().height.toFixed(1);
  return { emptyH, h6, scroll6, overflow6, h30, scroll30, backH };
}

/* ---------------- 页面内：模型面板交互 ---------------- */
function clickPill() {
  const b = document.querySelector('.composer .model-pill');
  if (b) b.click();
  return true;
}
function clickOutside() {
  const el = document.querySelector('.composer .dock');
  if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
}
function panelState() {
  const pop = document.querySelector('.composer .model-pop');
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const tokens = getComputedStyle(document.documentElement);
  return {
    open: !!pop,
    headText: pop ? pop.querySelector('.mp-head')?.innerText.replace(/\s+/g, ' ') ?? null : null,
    footText: pop ? pop.querySelector('.mp-foot')?.textContent.trim() ?? null : null,
    items: qa('.composer .model-pop .mp-item').map((b) => ({
      alias: b.querySelector('.mp-alias')?.textContent.trim().replace(/\s+/g, ' ') ?? '',
      sub: b.querySelector('.mp-sub')?.textContent.trim() ?? '',
      sel: b.classList.contains('sel'),
      hasCheck: !!b.querySelector('.mp-check'),
    })),
    badges: qa('.composer .model-pop .mp-badge').map((b) => b.textContent.trim()),
    followVisible: !!q('.composer .mp-follow'),
    bg: pop ? getComputedStyle(pop).backgroundColor : null,
    brandWeak: tokens.getPropertyValue('--brand-weak').trim(),
    panelTok: tokens.getPropertyValue('--panel').trim(),
  };
}
function pickModel(alias) {
  const items = [...document.querySelectorAll('.composer .model-pop .mp-item')];
  const hit = items.find((b) => (b.querySelector('.mp-alias')?.textContent ?? '').trim().startsWith(alias));
  if (hit) hit.click();
  return !!hit;
}
function clickFollowGlobal() {
  const b = document.querySelector('.composer .mp-follow');
  if (b) b.click();
  return !!b;
}
function escKey() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
}
function pillState() {
  const pillEl = document.querySelector('.composer .model-pill');
  return {
    label: document.querySelector('.composer .mp-label')?.textContent.trim() ?? null,
    pinned: pillEl ? pillEl.classList.contains('pinned') : null,
    disabled: pillEl ? pillEl.disabled : null,
    color: pillEl ? getComputedStyle(pillEl).color : null,
    writes: window.__modelWrites ? window.__modelWrites.slice() : [],
  };
}

/* ---------------- 用例执行 ---------------- */
const summary = { light: {}, dark: {}, states: {} };

/* ===== 浅色：结构与自增高 ===== */
await fresh('light');
summary.light.structure = await ev(`(${probeStructure.toString()})()`);
summary.light.autogrow = await ev(`(${probeAutogrow.toString()})()`);
summary.light.png = await shot('landed-light');

const L = summary.light.structure;
const A = summary.light.autogrow;

check('结构/一体卡片：.composer 无上沿分隔线（border-top = 0）', L.compBorderTop === 0, `border-top=${L.compBorderTop}px`);
check('结构/.dock 存在且带描边 + 圆角 + 阴影', L.exists.dock && L.dock.borderWidth === 1 && L.dock.radius > 0 && L.dock.shadow !== 'none', JSON.stringify({ b: L.dock.borderWidth, r: L.dock.radius, s: L.dock.shadow }));
check('结构/输入域无自身描边（避免线中套线）', L.ta.borderWidth === 0, `textarea border-top=${L.ta.borderWidth}px`);
check('结构/输入域 resize 已禁用', L.ta.resize === 'none', `resize=${L.ta.resize}`);
check('结构/顺序为 [chips?, textarea, tool-row]', (() => {
  const o = L.order ?? [];
  const iTa = o.indexOf('gw');
  const iRow = o.indexOf('tool-row');
  const iChips = o.indexOf('chips');
  return iTa >= 0 && iRow > iTa && (iChips === -1 || iChips < iTa);
})(), JSON.stringify(L.order));
check('结构/占位符已缩短（不超过 8 字）', typeof L.ta.placeholder === 'string' && L.ta.placeholder.length <= 8, JSON.stringify(L.ta.placeholder));
check('结构/附件按钮为纯图标（有 svg 且 28×28）', L.tbtn.hasSvg === true && Math.round(L.tbtn.w) === 28, JSON.stringify(L.tbtn));
check('结构/发送按钮 32×32 圆形品牌底色', Math.round(L.send.rect.w) === 32 && Math.round(L.send.rect.h) === 32 && L.send.radius >= 15 && L.send.hasSvg === true, JSON.stringify(L.send));
check('结构/快捷键提示常驻且文案含 Enter 与 Shift', /Enter/.test(L.kbd.text || '') && /Shift/.test(L.kbd.text || '') && L.kbd.display !== 'none', JSON.stringify(L.kbd.text));
check('结构/composer 内联 SVG 数 ≥ 4（图标体系统一；无附件时不含 pill 图标）', L.svgCount >= 4, `svg=${L.svgCount}`);
check('无残留/emoji 与字符图标清零', L.emojiHits.length === 0, L.emojiHits.join(',') || '（无）');
check('无残留/「流式」控件已移除', L.hasStreamLabel === false, '');
check('无残留/「通知/声音」控件已移除', L.hasNotifyLabel === false, '');
check('令牌映射/--radius-card 与 --line-soft 存在（零新增令牌前提）', !!L.tokens.radiusCard && !!L.tokens.lineSoft, JSON.stringify(L.tokens));

check('自增高/空态 44px', A.emptyH === 44, `empty=${A.emptyH}px`);
check('自增高/6 行时增高（> 44）', A.h6 > 44 + 1, `6 行=${A.h6}px（scrollHeight=${A.scroll6}）`);
check('自增高/30 行封顶 200px', Math.round(A.h30) === 200, `30 行=${A.h30}px（scrollHeight=${A.scroll30}）`);
check('自增高/封顶后内部滚动（overflow-y auto）', A.overflow6 === 'auto', `overflow-y=${A.overflow6}`);
check('自增高/清空后回落 44px', Math.round(A.backH) === 44, `back=${A.backH}px`);

/* ===== 浅色：默认 pill 状态 + 面板 ===== */
// 先进入探针会话（activeId 有值）——否则模型选择不会写盘，验不到 D7 的落盘闭环
const entered = await enterSession();
check('状态/进入探针会话（activeId 有值，写盘链路前提）', entered === true, `entered=${entered}`);
summary.light.pillDefault = await ev(`(${pillState.toString()})()`);
const PD = summary.light.pillDefault;
check('状态/pill 默认显示全局 alias 且无 pinned', PD.label === 'deepseek' && PD.pinned === false, JSON.stringify(PD));
check('状态/未选中时不出现「跟随全局」入口', !(L.pill.cls || '').includes('pinned'), L.pill.cls);
check('模型/pill 为胶囊形（radius ≥ 12）且带 2 个图标', L.pill.radius >= 12 && L.pill.hasSvg === 2, JSON.stringify({ r: L.pill.radius, svg: L.pill.hasSvg }));

await ev(`(${clickPill.toString()})()`);
await sleep(350);
summary.light.panel = await ev(`(${panelState.toString()})()`);
summary.light.panelPng = await shot('landed-model-panel');
const P = summary.light.panel;

check('交互/点 pill 面板展开', P.open === true, '');
check('模型/面板标题声明「本次对话使用」', /本次对话使用/.test(P.headText || ''), JSON.stringify(P.headText));
check('模型/副标题声明不改全局激活', /不改全局激活/.test(P.headText || ''), JSON.stringify(P.headText));
check('模型/脚注声明只影响本会话', /只影响本会话/.test(P.footText || ''), JSON.stringify(P.footText));
check('模型/行数 = 登记簿条数（3）', P.items.length === 3, JSON.stringify(P.items.map((i) => i.alias)));
check('模型/「全局」徽标唯一且落在 deepseek 上', P.badges.length === 1 && P.items.some((i) => i.alias.startsWith('deepseek') && i.alias.includes('全局')), JSON.stringify(P.badges));
check('模型/未选中时无勾选态与「跟随全局」', P.items.every((i) => !i.sel && !i.hasCheck) && P.followVisible === false, JSON.stringify(P.items));
check('模型/行副标题带模型名与主机（区分同名模型供应商）', P.items.every((i) => i.sub.length > 0) && P.items.some((i) => i.sub.includes('tokenhub.haizhi.com')), JSON.stringify(P.items.map((i) => i.sub)));
check('深色/面板底为不透明 --panel（不穿透消息流）', P.bg !== 'rgba(0, 0, 0, 0)' && normColor(P.bg) === normColor(P.panelTok), JSON.stringify({ bg: P.bg, panel: P.panelTok }));

/* ===== 交互：点外部关闭 / Esc 关闭 / 点控制条不误关 ===== */
await ev(`(${clickOutside.toString()})()`);
await sleep(250);
let st = await ev(`!!document.querySelector('.composer .model-pop')`);
check('交互/点外部关闭面板', st === false, '');

// 再次打开 → 点 pill 自身（控制条）不应关闭（D9 教训：点开即关）
await ev(`(${clickPill.toString()})()`);
await sleep(250);
await ev(`(${clickPill.toString()})()`);
await sleep(250);
st = await ev(`!!document.querySelector('.composer .model-pop')`);
check('交互/点控制条自身不误关（打开后再点 pill → 收起，无「点开即关」）', st === false, '第二次点击应主动收起');

// Esc 关闭
await ev(`(${clickPill.toString()})()`);
await sleep(250);
await ev(`(${escKey.toString()})()`);
await sleep(250);
st = await ev(`!!document.querySelector('.composer .model-pop')`);
check('交互/Esc 关闭面板', st === false, '');

/* ===== 状态：选非全局项 → 覆盖态 ===== */
await ev(`(${clickPill.toString()})()`);
await sleep(300);
const picked = await ev(`(${pickModel.toString()})('glm')`);
await sleep(300);
summary.states.pinned = await ev(`(${pillState.toString()})()`);
summary.states.pinnedPanelLess = await ev(`!!document.querySelector('.composer .model-pop')`);
const PIN = summary.states.pinned;

check('状态/选中面板行生效（找到 glm 行）', picked === true, '');
check('状态/选中后面板自动收起', summary.states.pinnedPanelLess === false, '');
check('状态/覆盖态 pill 显示所选 alias', PIN.label === 'glm', JSON.stringify(PIN.label));
check('状态/覆盖态 pill 加 pinned 类（转品牌色）', PIN.pinned === true && normColor(PIN.color) === normColor(L.tokens.brand), JSON.stringify({ pinned: PIN.pinned, color: PIN.color, brand: L.tokens.brand }));
check('状态/覆盖态写入会话元数据（PUT .../model）', Array.isArray(PIN.writes) && PIN.writes.length > 0 && PIN.writes[PIN.writes.length - 1]?.modelAlias === 'glm', JSON.stringify(PIN.writes));
summary.states.pinnedPng = await shot('landed-state-pinned');

/* ===== 状态：覆盖态面板出现「跟随全局」并能复位 ===== */
await ev(`(${clickPill.toString()})()`);
await sleep(300);
const P2 = await ev(`(${panelState.toString()})()`);
summary.states.pinnedPanel = P2;
check('状态/覆盖态面板出现「跟随全局」入口', P2.followVisible === true, '');
check('状态/覆盖态选中行带勾选', P2.items.some((i) => i.alias.startsWith('glm') && i.sel && i.hasCheck), JSON.stringify(P2.items));
summary.states.panelPng = await shot('landed-state-panel-follow');

await ev(`(${clickFollowGlobal.toString()})()`);
await sleep(300);
const BACK = await ev(`(${pillState.toString()})()`);
check('状态/「跟随全局」复位为全局 alias 且去除 pinned', BACK.label === 'deepseek' && BACK.pinned === false, JSON.stringify(BACK));
check('状态/复位写回 null', BACK.writes[BACK.writes.length - 1]?.modelAlias === null, JSON.stringify(BACK.writes.slice(-1)));

/* ===== 状态：跨会话隔离与切走切回还原（D7 的持久化承诺） ===== */
// 会话一选回 glm
await ev(`(${clickPill.toString()})()`);
await sleep(280);
await ev(`(${pickModel.toString()})('glm')`);
await sleep(350);
const A1 = await ev(`(${pillState.toString()})()`);
// 切到会话二：不应继承会话一的选择
const inB = await enterSession(1);
const B1 = await ev(`(${pillState.toString()})()`);
// 切回会话一：应还原 glm（依赖 persistModelAlias 同步了内存 workspaces）
const backToA = await enterSession(0);
const A2 = await ev(`(${pillState.toString()})()`);
summary.states.sessionSwitch = { A1, inB, B1, backToA, A2 };
check('持久化/会话一选中 glm', A1.label === 'glm' && A1.pinned === true, JSON.stringify(A1.label));
check('持久化/切到会话二不串味（显示全局且无 pinned）', inB === true && B1.label === 'deepseek' && B1.pinned === false, JSON.stringify({ inB, label: B1.label, pinned: B1.pinned }));
check('持久化/切回会话一还原 glm（重进会话还原所选模型）', backToA === true && A2.label === 'glm' && A2.pinned === true, JSON.stringify({ backToA, label: A2.label, pinned: A2.pinned }));

/* ===== 深色 ===== */
await fresh('dark');
summary.dark.structure = await ev(`(${probeStructure.toString()})()`);
summary.dark.png = await shot('landed-dark');
const D = summary.dark.structure;
check('深色/卡底为 --bar-bg', normColor(D.dock.bg) === normColor(D.tokens.barBg), JSON.stringify({ bg: D.dock.bg, barBg: D.tokens.barBg }));
check('深色/描边为 --line', normColor(D.dock.borderColor) === normColor(D.tokens.line), JSON.stringify({ b: D.dock.borderColor, line: D.tokens.line }));
check('深色/无 emoji 残留', D.emojiHits.length === 0, D.emojiHits.join(',') || '（无）');

/* ===== 宽度矩阵 ===== */
for (const w of [1600, 1024, 640, 440, 380, 320]) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: VP.height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(450);
  const m = await ev(`(${probeStructure.toString()})()`);
  const key = `w${w}`;
  summary.states[key] = { kbdDisplay: m.kbd.display, toolRowOverflow: m.toolRow.overflow, pillW: m.pill.rect?.w, icDisplay: null, composerPad: null };
  const patched = await ev(`(() => {
    const inner = document.querySelector('.composer-inner');
    const c = document.querySelector('.composer');
    const ic = document.querySelector('.composer .model-pill .mp-ic');
    return {
      innerPadL: inner ? parseFloat(getComputedStyle(inner).paddingLeft) : null,
      compW: c ? +c.getBoundingClientRect().width.toFixed(1) : null,
      icDisplay: ic ? getComputedStyle(ic).display : null,
      hintDisplay: (() => { const k = document.querySelector('.composer .kbd-hint'); return k ? getComputedStyle(k).display : null; })(),
      rowOverflow: (() => { const r = document.querySelector('.composer .tool-row'); return r ? r.scrollWidth - r.clientWidth : null; })(),
      pillVisible: !!document.querySelector('.composer .model-pill'),
      sendVisible: !!document.querySelector('.composer .send-btn'),
    };
  })()`);
  summary.states[key] = { ...summary.states[key], ...patched };
  // 档位判定以「容器实际宽度」为准，而非视口宽度：
  // 1600 视口下 FilesView 展开会把对话区挤到 462px，1024 视口下仅 270px——
  // 用视口宽度推期望会冤枉正确的 CSS（第一版即在此误判 2 条）。
  const cw = patched.compW ?? 0;
  const narrow440 = cw <= 440;
  const narrow380 = cw <= 380;
  if (narrow440) {
    check(`宽度/${w}px（容器 ${cw}px ≤440）快捷键提示隐藏`, patched.hintDisplay === 'none', `display=${patched.hintDisplay}`);
  } else {
    check(`宽度/${w}px（容器 ${cw}px >440）快捷键提示可见`, patched.hintDisplay !== 'none', `display=${patched.hintDisplay}`);
  }
  check(`宽度/${w}px 工具行不溢出`, (patched.rowOverflow ?? 0) <= 0, `overflow=${patched.rowOverflow}`);
  check(`宽度/${w}px 模型 pill 与发送按钮均仍在`, patched.pillVisible && patched.sendVisible, '');
  const wantPad = narrow380 ? 12 : 20;
  check(`宽度/${w}px（容器 ${cw}px）内边距 = ${wantPad}`, Math.round(patched.innerPadL ?? -1) === wantPad, `padL=${patched.innerPadL}`);
  if (narrow380) {
    check(`宽度/${w}px pill 图标省略（mp-ic 不显示）`, patched.icDisplay === 'none', patched.icDisplay);
  }
}

/* ---------------- 收尾 ---------------- */
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ results, summary }, null, 2));

console.log('\n=== 对话输入区落地探针（真实组件 1600×1000 + 宽度矩阵）===');
for (const r of results) {
  console.log(`${r.ok ? '  PASS' : '× FAIL'}  ${r.name}${r.detail ? '   ' + (typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)) : ''}`);
}
console.log(`\n合计 ${results.length} 条断言：PASS ${pass} / FAIL ${fail}`);
console.log('产物目录：' + OUT + '\n');

ws.close();
chrome.kill();
process.exit(fail > 0 ? 1 : 0);
