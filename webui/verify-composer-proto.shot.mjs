#!/usr/bin/env node
/**
 * 对话输入区原型（原型-20261025-001）真实渲染探针
 *
 * 用 headless Chrome + CDP 打开纯静态原型（file://），对每个状态取 DOM 像素探针 +
 * 截图，把「原型里写的规格」变成可验证断言，避免只看截图就宣称达标。
 *
 * 用法：node webui/verify-composer-proto.shot.mjs
 *       可选环境变量：PROTO / VERIFY_OUT / CDP_PORT / CHROME_PATH
 * 产物：$VERIFY_OUT（默认 .tmp-verify-composer-proto）下 png + summary.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PROTO = process.env.PROTO
  || path.resolve('docs/designs/原型-20261025-001+对话输入区重设计.html');
const OUT = path.resolve(process.env.VERIFY_OUT || '.tmp-verify-composer-proto');
const PORT = Number(process.env.CDP_PORT || 9338);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VP = { width: 1080, height: 1200 };

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
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
  if (ex) throw new Error(`页面异常: ${ex.text} ${JSON.stringify(ex.exception?.description ?? '').slice(0, 400)}`);
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

async function shot(name, clip) {
  const params = { format: 'png', captureBeyondViewport: true };
  if (clip) params.clip = { ...clip, scale: 1 };
  const r = await send('Page.captureScreenshot', params);
  const p = path.join(OUT, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return p;
}

async function goto() {
  await send('Page.navigate', { url: pathToFileURL(PROTO).href });
  for (let i = 0; i < 60; i++) {
    const ok = await ev(`!!document.getElementById('live-dock')`);
    if (ok) break;
    await sleep(200);
  }
  await sleep(500);
}

/* ---------------- 断言收集 ---------------- */
const results = [];
function check(group, name, actual, expected, ok) {
  results.push({ group, name, actual, expected, ok });
}

await goto();

/* ===== 1. 结构规格（浅色，默认宽度） ===== */
const spec = await ev(`(() => {
  const cs = (el, p) => getComputedStyle(el)[p];
  const px = (el, p) => parseFloat(cs(el, p)) || 0;
  const dock = document.getElementById('live-dock');
  const comp = document.querySelector('[data-probe="composer"]');
  const ta = document.getElementById('live-ta');
  const tools = document.querySelector('[data-probe="dock-tools"]');
  const send = document.getElementById('live-send');
  const attach = document.getElementById('live-attach');
  const model = document.getElementById('live-model');
  const hint = document.querySelector('[data-probe="hint"]');
  const r = (el) => { const b = el.getBoundingClientRect(); return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  return {
    composerBg: cs(comp, 'backgroundColor'),
    composerBorderTop: px(comp, 'borderTopWidth'),
    dockBorderColor: cs(dock, 'borderTopColor'),
    dockBorderWidth: px(dock, 'borderTopWidth'),
    dockRadius: px(dock, 'borderTopLeftRadius'),
    dockBg: cs(dock, 'backgroundColor'),
    dockShadow: cs(dock, 'boxShadow') !== 'none',
    taBorder: px(ta, 'borderTopWidth'),
    taBg: cs(ta, 'backgroundColor'),
    taMinH: px(ta, 'minHeight'),
    taRect: r(ta),
    toolsRect: r(tools),
    sendRect: r(send),
    sendBg: cs(send, 'backgroundColor'),
    sendDisabled: send.disabled,
    attachRect: r(attach),
    attachHasSvg: !!attach.querySelector('svg'),
    modelRect: r(model),
    modelHasSvg: model.querySelectorAll('svg').length,
    modelName: document.querySelector('[data-probe="model-name"]').textContent.trim(),
    modelPinned: model.classList.contains('pinned'),
    modelExpanded: model.getAttribute('aria-expanded'),
    popHidden: document.getElementById('live-mpop').hidden,
    popItems: document.querySelectorAll('#live-mlist .mp-item').length,
    popGlobBadges: document.querySelectorAll('#live-mlist .mp-badge.glob').length,
    popSelected: document.querySelector('#live-mlist .mp-item[aria-selected="true"]')?.dataset.alias ?? null,
    popMetaHosts: [...document.querySelectorAll('#live-mlist .mp-meta')].map((x) => x.textContent.split('·')[1].trim()),
    resetHidden: document.getElementById('live-reset').hidden,
    legacyControls: !!(document.getElementById('live-flow') || document.getElementById('live-bell')),
    hintVisible: cs(hint, 'display') !== 'none',
    hintFontSize: px(hint, 'fontSize'),
    svgCount: comp.querySelectorAll('svg').length,
    emojiCount: (() => {
      const t = comp.innerText;
      return ['\\u{1F4CE}', '\\u{1F514}', '\\u25A0', '\\u2715', '\\u21B5'].filter((e) => t.includes(e)).length;
    })(),
    placeholder: ta.placeholder,
  };
})()`);

check('结构', 'composer 背景改为 --bg（无上沿分隔线）', `${spec.composerBg} / border-top ${spec.composerBorderTop}px`, 'rgb(246, 247, 249) / 0px', spec.composerBg === 'rgb(246, 247, 249)' && spec.composerBorderTop === 0);
check('结构', 'dock 描边 --line-soft 1px', `${spec.dockBorderColor} ${spec.dockBorderWidth}px`, 'rgb(238, 240, 243) 1px', spec.dockBorderColor === 'rgb(238, 240, 243)' && spec.dockBorderWidth === 1);
check('结构', 'dock 圆角 12px', spec.dockRadius, 12, Math.abs(spec.dockRadius - 12) < 0.5);
check('结构', 'dock 卡片底 --panel', spec.dockBg, 'rgb(255, 255, 255)', spec.dockBg === 'rgb(255, 255, 255)');
check('结构', 'dock 有阴影（层级成立）', spec.dockShadow, true, spec.dockShadow === true);
check('结构', 'textarea 无边框（消除线中套线）', `${spec.taBorder}px / bg ${spec.taBg}`, '0px / transparent', spec.taBorder === 0);
check('结构', 'textarea min-height 44px', spec.taMinH, 44, Math.abs(spec.taMinH - 44) < 0.5);
check('结构', '主操作 32×32 图标按钮', JSON.stringify(spec.sendRect), '32×32', Math.abs(spec.sendRect.w - 32) < 0.6 && Math.abs(spec.sendRect.h - 32) < 0.6);
check('结构', '空态发送按钮灰底且 disabled', `${spec.sendBg} / disabled=${spec.sendDisabled}`, 'rgba(17, 24, 39, 0.055) / true', spec.sendBg === 'rgba(17, 24, 39, 0.055)' && spec.sendDisabled === true);
check('结构', '附件按钮 28×28 且为 SVG', `${JSON.stringify(spec.attachRect)} svg=${spec.attachHasSvg}`, '28×28 svg=true', Math.abs(spec.attachRect.w - 28) < 0.6 && spec.attachHasSvg);
check('结构', '流式/通知控件已移除', spec.legacyControls, false, spec.legacyControls === false);
check('结构', '模型 pill 高 26px、含 2 个 SVG（chip + chevron）', `${spec.modelRect.h}px svg=${spec.modelHasSvg}`, '26px svg=2', Math.abs(spec.modelRect.h - 26) < 0.8 && spec.modelHasSvg === 2);
check('结构', '模型 pill 默认显示全局激活 alias 且未固定', `${spec.modelName} pinned=${spec.modelPinned}`, 'deepseek-flash pinned=false', spec.modelName === 'deepseek-flash' && spec.modelPinned === false);
check('结构', '模型下拉默认收起', `${spec.popHidden} / aria-expanded=${spec.modelExpanded}`, 'true / false', spec.popHidden === true && spec.modelExpanded === 'false');
check('结构', '下拉列出全部 3 个 profile，仅 1 个「全局」徽标', `items=${spec.popItems} glob=${spec.popGlobBadges}`, 'items=3 glob=1', spec.popItems === 3 && spec.popGlobBadges === 1);
check('结构', '默认选中项与全局激活一致', spec.popSelected, 'deepseek-flash', spec.popSelected === 'deepseek-flash');
check('结构', '列表暴露不同 profile 的主机差异（baseUrl 可见）', spec.popMetaHosts.join(' | '), '含 tokenhub.haizhi.com', spec.popMetaHosts.some((h) => h === 'tokenhub.haizhi.com'));
check('结构', '未固定时不显示「跟随全局」', spec.resetHidden, true, spec.resetHidden === true);
check('结构', '输入区 emoji 全部清零', `emoji=${spec.emojiCount} svg=${spec.svgCount}`, 'emoji=0 svg≥6', spec.emojiCount === 0 && spec.svgCount >= 6);
check('结构', '快捷键提示 11.5px 且默认可见', `${spec.hintFontSize}px visible=${spec.hintVisible}`, '11.5px true', Math.abs(spec.hintFontSize - 11.5) < 0.2 && spec.hintVisible);
check('结构', '占位符缩短', spec.placeholder, '发消息给 Loop Agent…', spec.placeholder === '发消息给 Loop Agent…');

/* ===== 2. 自增高（D3） ===== */
const grow = await ev(`(() => {
  const ta = document.getElementById('live-ta');
  const h = () => +ta.getBoundingClientRect().height.toFixed(1);
  ta.value = ''; ta.dispatchEvent(new Event('input', {bubbles:true}));
  const h0 = h();
  ta.value = Array.from({length:6},(_,i)=>'第'+(i+1)+'行需求描述内容').join('\\n');
  ta.dispatchEvent(new Event('input', {bubbles:true}));
  const h6 = h();
  const ov6 = getComputedStyle(ta).overflowY;
  ta.value = Array.from({length:30},(_,i)=>'第'+(i+1)+'行').join('\\n');
  ta.dispatchEvent(new Event('input', {bubbles:true}));
  const h30 = h();
  const ov30 = getComputedStyle(ta).overflowY;
  const maxH = parseFloat(getComputedStyle(ta).maxHeight);
  ta.value = ''; ta.dispatchEvent(new Event('input', {bubbles:true}));
  return { h0, h6, ov6, h30, ov30, maxH };
})()`);
check('自增高', '空态 44px', grow.h0, 44, Math.abs(grow.h0 - 44) < 1);
check('自增高', '6 行时高于 44px（原实现恒为 44）', grow.h6, '>46 且 <200', grow.h6 > 46 && grow.h6 < 200);
check('自增高', '未超限时不出现内部滚动', grow.ov6, 'hidden', grow.ov6 === 'hidden');
check('自增高', '30 行时封顶 200px', grow.h30, 200, Math.abs(grow.h30 - 200) < 1);
check('自增高', '超限后内部滚动', grow.ov30, 'auto', grow.ov30 === 'auto');

/* ===== 3. 交互：ready 态 / 聚焦光晕 / 状态切换 ===== */
await ev(`(() => {
  const ta = document.getElementById('live-ta');
  ta.value = '写点东西'; ta.dispatchEvent(new Event('input', {bubbles:true}));
  ta.focus();
})()`);
await sleep(320);
const interact = await ev(`(() => {
  const cs = (el,p) => getComputedStyle(el)[p];
  const dock = document.getElementById('live-dock');
  const send = document.getElementById('live-send');
  return {
    sendBg: cs(send,'backgroundColor'), sendDisabled: send.disabled,
    sendCls: send.className,
    dockBorder: cs(dock,'borderTopColor'),
    dockShadow: cs(dock,'boxShadow'),
    activeIsTa: document.activeElement && document.activeElement.id,
  };
})()`);
check('交互', '有内容时发送转品牌绿并可点', `${interact.sendBg} ready=${interact.sendCls.includes('ready')}`, 'rgb(14, 159, 110) / ready', interact.sendBg === 'rgb(14, 159, 110)' && interact.sendCls.includes('ready'));
check('交互', 'focus-within 转品牌描边', interact.dockBorder, 'rgb(14, 159, 110)', interact.dockBorder === 'rgb(14, 159, 110)');
check('交互', 'focus-within 叠加 3px 光晕', interact.dockShadow, '含 0px 0px 0px 3px + brand-weak 色', interact.dockShadow.includes('0px 0px 0px 3px') && interact.dockShadow.includes('230, 246, 239'));

/* 状态切换：带附件 */
await ev(`document.querySelector('#seg-state button[data-v="files"]').click()`);
await sleep(220);
const stFiles = await ev(`(() => {
  const f = document.getElementById('live-files');
  const chip = f.querySelector('.chip');
  const cs = (el,p) => getComputedStyle(el)[p];
  return {
    hidden: f.hidden,
    chipH: +chip.getBoundingClientRect().height.toFixed(1),
    chipRadius: parseFloat(cs(chip,'borderTopLeftRadius')),
    chipHasSvg: !!chip.querySelector('svg'),
    cxSize: (() => { const b = chip.querySelector('.cx').getBoundingClientRect(); return [+b.width.toFixed(1), +b.height.toFixed(1)]; })(),
    sendCls: document.getElementById('live-send').className,
  };
})()`);
check('状态', '带附件时 chip 区出现', stFiles.hidden, false, stFiles.hidden === false);
check('状态', 'chip 高 24px 且为胶囊', `${stFiles.chipH}px / r=${stFiles.chipRadius}`, '24px / 999', Math.abs(stFiles.chipH - 24) < 0.8 && stFiles.chipRadius > 100);
check('状态', 'chip 内是 SVG 删除按钮 16×16', `${stFiles.chipHasSvg} ${stFiles.cxSize.join('×')}`, 'true 16×16', stFiles.chipHasSvg && stFiles.cxSize[0] === 16);
check('状态', '仅带附件也能发送', stFiles.sendCls.includes('ready'), true, stFiles.sendCls.includes('ready'));

/* 状态切换：生成中 */
await ev(`document.querySelector('#seg-state button[data-v="running"]').click()`);
await sleep(220);
const stRun = await ev(`(() => {
  const s = document.getElementById('live-send');
  const cs = (el,p) => getComputedStyle(el)[p];
  return { cls: s.className, bg: cs(s,'backgroundColor'), color: cs(s,'color'), icon: s.querySelector('use')?.getAttribute('href'), toolsOpacity: cs(document.querySelector('[data-probe="dock-tools"] .tbtn'),'opacity') };
})()`);
check('状态', '生成中主操作变停止（同位置）', `${stRun.cls} icon=${stRun.icon}`, 'stop / #i-stop', stRun.cls.includes('stop') && stRun.icon === '#i-stop');
check('状态', '停止按钮用 --danger-weak 底', `${stRun.bg} / ${stRun.color}`, 'rgb(253, 236, 236) / rgb(220, 38, 38)', stRun.bg === 'rgb(253, 236, 236)' && stRun.color === 'rgb(220, 38, 38)');

/* ===== 3b. 模型选择（会话级覆盖，D11/D12） ===== */
await ev(`document.getElementById('live-model').click()`);
await sleep(260);
const mpOpen = await ev(`(() => {
  const cs = (el,p) => getComputedStyle(el)[p];
  const pop = document.getElementById('live-mpop');
  const b = pop.getBoundingClientRect();
  const dock = document.getElementById('live-dock').getBoundingClientRect();
  return {
    hidden: pop.hidden,
    expanded: document.getElementById('live-model').getAttribute('aria-expanded'),
    popW: +b.width.toFixed(1), dockW: +dock.width.toFixed(1),
    above: b.bottom <= dock.top + 1,               // 向上展开（不盖输入框）
    popBg: cs(pop,'backgroundColor'),
    headText: pop.querySelector('.mp-head b').textContent.trim(),
    scopeHint: pop.querySelector('.mp-sub').textContent.trim(),
    footText: pop.querySelector('.mp-foot').textContent.trim(),
    overflowX: pop.scrollWidth - pop.clientWidth,
  };
})()`);
check('模型', '点击 pill 展开下拉', `${mpOpen.hidden} / aria=${mpOpen.expanded}`, 'false / true', mpOpen.hidden === false && mpOpen.expanded === 'true');
check('模型', '面板与卡片内边缘齐平且向上展开', `${mpOpen.popW} vs dock ${mpOpen.dockW} / above=${mpOpen.above}`, '差值=2×border(2px) / above=true', Math.abs(mpOpen.dockW - mpOpen.popW - 2) < 0.6 && mpOpen.above === true);
check('模型', '面板不横向溢出', mpOpen.overflowX, 0, mpOpen.overflowX <= 0);
check('模型', '标题明确作用域为「本次对话」', mpOpen.headText, '本次对话使用', mpOpen.headText === '本次对话使用');
check('模型', '副标题声明不改全局激活', mpOpen.scopeHint.includes('不改全局激活'), true, mpOpen.scopeHint.includes('不改全局激活'));
check('模型', '脚注提示切换只影响后续消息 + 管理入口', `${mpOpen.footText.includes('只影响后续消息')} / ${mpOpen.footText.includes('管理模型')}`, 'true / true', mpOpen.footText.includes('只影响后续消息') && mpOpen.footText.includes('管理模型'));

/* 选中非全局 profile：会话级覆盖生效 */
await ev(`document.querySelector('#live-mlist .mp-item[data-alias="glm-5.3-flash"]').click()`);
await sleep(240);
const mpPick = await ev(`(() => {
  const pill = document.getElementById('live-model');
  return {
    name: document.querySelector('[data-probe="model-name"]').textContent.trim(),
    pinned: pill.classList.contains('pinned'),
    pinColor: getComputedStyle(pill.querySelector('.mi')).color,
    selected: document.querySelector('#live-mlist .mp-item[aria-selected="true"]')?.dataset.alias ?? null,
    selectedBg: getComputedStyle(document.querySelector('#live-mlist .mp-item[aria-selected="true"]')).backgroundColor,
    popHidden: document.getElementById('live-mpop').hidden,
    resetHidden: document.getElementById('live-reset').hidden,
    globalBadgeOnSelected: !!document.querySelector('#live-mlist .mp-item[data-alias="glm-5.3-flash"] .mp-badge'),
  };
})()`);
check('模型', '选中后 pill 文字切到所选 alias', mpPick.name, 'glm-5.3-flash', mpPick.name === 'glm-5.3-flash');
check('模型', '选中后 pill 加 pinned 且图标转品牌色', `${mpPick.pinned} / ${mpPick.pinColor}`, 'true / rgb(14, 159, 110)', mpPick.pinned === true && mpPick.pinColor === 'rgb(14, 159, 110)');
check('模型', '单项选中态用 --brand-weak 底', mpPick.selectedBg, 'rgb(230, 246, 239)', mpPick.selectedBg === 'rgb(230, 246, 239)');
check('模型', '非全局 profile 不带「全局」徽标（语义未混淆）', mpPick.globalBadgeOnSelected, false, mpPick.globalBadgeOnSelected === false);
check('模型', '选完自动收起并出现「跟随全局」', `popHidden=${mpPick.popHidden} resetHidden=${mpPick.resetHidden}`, 'true / false', mpPick.popHidden === true && mpPick.resetHidden === false);

/* 跟随全局：复位 */
await ev(`document.getElementById('live-reset').click()`);
await sleep(220);
const mpReset = await ev(`(() => {
  const pill = document.getElementById('live-model');
  return {
    name: document.querySelector('[data-probe="model-name"]').textContent.trim(),
    pinned: pill.classList.contains('pinned'),
    selected: document.querySelector('#live-mlist .mp-item[aria-selected="true"]')?.dataset.alias ?? null,
    resetHidden: document.getElementById('live-reset').hidden,
  };
})()`);
check('模型', '「跟随全局」复位到激活 profile', `${mpReset.name} pinned=${mpReset.pinned} selected=${mpReset.selected} resetHidden=${mpReset.resetHidden}`, 'deepseek-flash / false / deepseek-flash / true', mpReset.name === 'deepseek-flash' && mpReset.pinned === false && mpReset.selected === 'deepseek-flash' && mpReset.resetHidden === true);

/* 与上传浮层互斥 */
const exclusive = await ev(`(() => {
  document.getElementById('live-attach').click();
  const a = document.getElementById('live-pop').hidden;
  document.getElementById('live-model').click();
  return { afterAttach: a, afterModel: document.getElementById('live-pop').hidden, model: document.getElementById('live-mpop').hidden };
})()`);
check('模型', '与上传浮层互斥（开一个关另一个）', JSON.stringify(exclusive), '{"afterAttach":false,"afterModel":true,"model":false}', exclusive.afterAttach === false && exclusive.afterModel === true && exclusive.model === false);

/* 生成中不可切换 */
const mpRunning = await ev(`(() => {
  document.querySelector('#seg-state button[data-v="running"]').click();
  const pill = document.getElementById('live-model');
  const cs = getComputedStyle(pill);
  return { opacity: cs.opacity, pe: cs.pointerEvents, popHidden: document.getElementById('live-mpop').hidden };
})()`);
check('模型', '生成中禁用模型切换', `${mpRunning.opacity} / ${mpRunning.pe}`, '0.5 / none', mpRunning.opacity === '0.5' && mpRunning.pe === 'none');
await ev(`document.querySelector('#seg-state button[data-v="empty"]').click()`);
await sleep(200);

/* ===== 4. 宽度审计（容器查询） ===== */
async function atWidth(w) {
  await ev(`(() => {
    const m = document.getElementById('live-mock');
    m.style.width = ${w} + 'px';
    document.querySelectorAll('textarea').forEach(el => {
      if (el.dataset.fixedH) { el.style.height = el.dataset.fixedH + 'px'; return; }
      el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,200)+'px';
    });
  })()`);
  await sleep(240);
  return ev(`(() => {
    const cs = (el,p) => getComputedStyle(el)[p];
    const comp = document.querySelector('[data-probe="composer"]');
    const tools = document.querySelector('[data-probe="dock-tools"]');
    const hint = document.querySelector('[data-probe="hint"]');
    const pill = document.getElementById('live-model');
    const dock = document.getElementById('live-dock');
    const r = (el) => { const b = el.getBoundingClientRect(); return { w:+b.width.toFixed(1), h:+b.height.toFixed(1) }; };
    return {
      compW: r(comp).w,
      toolRowH: r(tools).h,
      toolsOverflow: tools.scrollWidth - tools.clientWidth,
      hintVisible: cs(hint,'display') !== 'none',
      pillW: r(pill).w,
      pillNameVisible: cs(pill.querySelector('.mn'),'display') !== 'none',
      pillNameTruncated: pill.querySelector('.mn').scrollWidth > pill.querySelector('.mn').clientWidth,
      compPaddingL: parseFloat(cs(document.querySelector('[data-probe="composer"] .inner'),'paddingLeft')),
      sendVisible: r(document.getElementById('live-send')).w > 0,
      dockW: r(dock).w,
    };
  })()`);
}
const w800 = await atWidth(800);
const w462 = await atWidth(462);
const w320 = await atWidth(320);
check('宽度', '800px：提示可见、单行工具行', `hint=${w800.hintVisible} rowH=${w800.toolRowH}`, 'true / 35', w800.hintVisible);
check('宽度', '462px：提示仍可见（>440 阈值内）', `hint=${w462.hintVisible}`, 'true', w462.hintVisible);
check('宽度', '320px：隐快捷键提示', `hint=${w320.hintVisible}`, 'false', w320.hintVisible === false);
check('宽度', '320px：模型名仍可见（只省略不隐藏）', `visible=${w320.pillNameVisible} w=${w320.pillW}`, 'visible=true w≤112', w320.pillNameVisible === true && w320.pillW <= 112.5);
check('宽度', '320px：工具行不溢出', `overflow=${w320.toolsOverflow} dock=${w320.dockW}`, '0 / ≤320', w320.toolsOverflow <= 0 && w320.dockW <= 320.5);
check('宽度', '320px：内边距收窄到 12px', w320.compPaddingL, 12, Math.abs(w320.compPaddingL - 12) < 0.5);
check('宽度', '462px：模型名不省略（默认宽度够用）', `${w462.pillW}px truncated=${w462.pillNameTruncated}`, '≤190 / false', w462.pillW <= 190.5 && w462.pillNameTruncated === false);

/* ===== 5. 深色主题 ===== */
await ev(`(() => {
  document.activeElement?.blur();
  document.querySelector('#seg-theme button[data-v="dark"]').click();
  const m = document.getElementById('live-mock'); m.style.width='462px';
  document.querySelector('#seg-state button[data-v="empty"]').click();
})()`);
await sleep(420);
const dark = await ev(`(() => {
  const cs = (el,p) => getComputedStyle(el)[p];
  const dock = document.getElementById('live-dock');
  const comp = document.querySelector('[data-probe="composer"]');
  return {
    theme: document.documentElement.dataset.theme,
    dockBg: cs(dock,'backgroundColor'),
    dockBorder: cs(dock,'borderTopColor'),
    compBg: cs(comp,'backgroundColor'),
    text: cs(document.getElementById('live-ta'),'color'),
    popBg: cs(document.getElementById('live-mpop'),'backgroundColor'),
  };
})()`);
check('深色', 'theme=dark 生效', dark.theme, 'dark', dark.theme === 'dark');
check('深色', 'dock 卡片底提亮为 --panel-2', dark.dockBg, 'rgb(31, 36, 43)', dark.dockBg === 'rgb(31, 36, 43)');
check('深色', 'composer 底 --bg 暗色', dark.compBg, 'rgb(20, 23, 28)', dark.compBg === 'rgb(20, 23, 28)');
check('深色', '描边提亮为 --line（深色 --line-soft 近乎不可见）', dark.dockBorder, 'rgb(43, 49, 58)', dark.dockBorder === 'rgb(43, 49, 58)');
check('深色', '模型面板不透明（深色下不穿透消息流）', dark.popBg, 'rgb(27, 31, 38)', dark.popBg === 'rgb(27, 31, 38)');

/* ===== 6. 状态矩阵完整性 & 无横向溢出 ===== */
/* 回归断言：控制条切换「模型」档时面板必须真实可见（曾因外部点击监听同帧关闭而空白） */
await ev(`document.querySelector('#seg-state button[data-v="model"]').click()`);
await sleep(320);
const viaSeg = await ev(`(() => {
  const pop = document.getElementById('live-mpop');
  const b = pop.getBoundingClientRect();
  const mock = document.getElementById('live-mock').getBoundingClientRect();
  return {
    hidden: pop.hidden,
    h: +b.height.toFixed(1),
    insideMock: b.top >= mock.top - 1 && b.bottom <= mock.bottom + 1,
    itemsVisible: [...document.querySelectorAll('#live-mlist .mp-item')].filter((x) => x.getBoundingClientRect().height > 20).length,
  };
})()`);
check('模型', '控制条切「模型」档后面板真实渲染（非空白）', `${viaSeg.h}px items=${viaSeg.itemsVisible} inside=${viaSeg.insideMock}`, 'h>150 / items=3 / inside=true', viaSeg.hidden === false && viaSeg.h > 150 && viaSeg.itemsVisible === 3 && viaSeg.insideMock === true);
await ev(`document.querySelector('#seg-state button[data-v="empty"]').click()`);
await sleep(180);

/* 矩阵内第 7 态的静态渲染（无 JS 交互，纯 CSS 定位） */
const matrixModel = await ev(`(() => {
  const cell = [...document.querySelectorAll('.cell')].find((c) => c.querySelector('.model-pop'));
  if (!cell) return { found: false };
  const pop = cell.querySelector('.model-pop');
  const pb = pop.getBoundingClientRect();
  const cb = cell.getBoundingClientRect();
  const db = cell.querySelector('.dock').getBoundingClientRect();
  return {
    found: true,
    hidden: pop.hidden,
    popH: +pb.height.toFixed(1), popTop: +pb.top.toFixed(1), popBottom: +pb.bottom.toFixed(1),
    cellH: +cb.height.toFixed(1), cellTop: +cb.top.toFixed(1), cellBottom: +cb.bottom.toFixed(1),
    dockTop: +db.top.toFixed(1),
    fullyInside: pb.top >= cb.top - 1 && pb.bottom <= cb.bottom + 1,
    itemsVisible: [...pop.querySelectorAll('.mp-item')].filter((x) => x.getBoundingClientRect().height > 20).length,
  };
})()`);
check('矩阵', '第 7 态模型面板完整落在卡片内（不被裁切）', JSON.stringify(matrixModel), 'found / fullyInside / items=3 / popH>150', matrixModel.found === true && matrixModel.fullyInside === true && matrixModel.itemsVisible === 3 && matrixModel.popH > 150);

const matrix = await ev(`(() => {
  const cells = [...document.querySelectorAll('.cell')];
  const docks = [...document.querySelectorAll('.cell .dock')];
  return {
    cells: cells.length,
    docks: docks.length,
    states: docks.map(d => d.dataset.state || '(none)'),
    pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    docH: document.documentElement.scrollHeight,
  };
})()`);
check('矩阵', '七态齐备（含模型下拉）', `${matrix.cells} cell / ${matrix.docks} dock → ${matrix.states.join(',')}`, '7 / 7', matrix.cells === 7 && matrix.docks === 7);
check('矩阵', '整页无横向溢出', matrix.pageOverflowX, '0', matrix.pageOverflowX <= 0);

/* ===== 7. 截图 ===== */
const shots = [];
await ev(`document.querySelector('#seg-theme button[data-v="light"]').click(); document.querySelector('#seg-state button[data-v="text"]').click(); 1`);
await sleep(400);
shots.push(await shot('proto-light-full', { x: 0, y: 0, width: VP.width, height: VP.height }));

// 单块：主实例（浅色）
const liveBox = await ev(`(() => { const b = document.getElementById('live-mock').getBoundingClientRect(); return { x: Math.max(0,b.x-6), y: b.y-6, width: b.width+12, height: b.height+12 }; })()`);
shots.push(await shot('proto-live-light', liveBox));

// 单块：主实例（深色）
await ev(`document.querySelector('#seg-theme button[data-v="dark"]').click(); 1`);
await sleep(320);
shots.push(await shot('proto-live-dark', liveBox));

// 单块：模型下拉展开（深色，会话级已覆盖）
await ev(`document.querySelector('#seg-state button[data-v="model"]').click(); 1`);
await sleep(340);
const modelBox = await ev(`(() => { const b = document.getElementById('live-mock').getBoundingClientRect(); return { x: Math.max(0,b.x-6), y: b.y-6, width: b.width+12, height: b.height+12 }; })()`);
shots.push(await shot('proto-model-dark', modelBox));
await ev(`document.querySelector('#seg-state button[data-v="empty"]').click(); 1`);
await sleep(200);

// 单块：状态矩阵（clip 用页面绝对坐标，配合 captureBeyondViewport）
await ev(`(() => {
  document.querySelector('#seg-theme button[data-v="light"]').click();
  window.scrollTo(0,0);
  return 1;
})()`);
await sleep(320);
const gridBox = await ev(`(() => { const g = document.querySelector('.grid').getBoundingClientRect(); return { x: Math.max(0, g.x + scrollX - 8), y: Math.max(0, g.y + scrollY - 8), width: g.width + 16, height: g.height + 16 }; })()`);
shots.push(await shot('proto-states', gridBox));

// 单块：矩阵第 7 态（模型下拉），确认静态渲染不被裁切
const cellBox = await ev(`(() => {
  const cell = [...document.querySelectorAll('.cell')].find((c) => c.querySelector('.model-pop'));
  const b = cell.getBoundingClientRect();
  return { x: Math.max(0, b.x + scrollX - 6), y: Math.max(0, b.y + scrollY - 6), width: b.width + 12, height: b.height + 12 };
})()`);
shots.push(await shot('proto-state-model-cell', cellBox));

// 单块：宽度审计
const auditBox = await ev(`(() => { const g = document.querySelector('.audit').getBoundingClientRect(); return { x: Math.max(0, g.x + scrollX - 8), y: Math.max(0, g.y + scrollY - 8), width: g.width + 16, height: g.height + 16 }; })()`);
shots.push(await shot('proto-audit', auditBox));

/* ===== 输出 ===== */
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ results, spec, grow, interact, stFiles, stRun, mpOpen, mpPick, mpReset, exclusive, mpRunning, w800, w462, w320, dark, matrix, shots }, null, 2));

const byGroup = {};
for (const r of results) (byGroup[r.group] ||= []).push(r);
for (const [g, list] of Object.entries(byGroup)) {
  console.log(`\n— ${g} —`);
  for (const r of list) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    if (!r.ok) console.log(`      actual=${JSON.stringify(r.actual)}  expected=${JSON.stringify(r.expected)}`);
  }
}
console.log(`\n合计 ${results.length} 条断言：PASS ${pass} / FAIL ${fail}`);
console.log(`产物：${OUT}\n`);

ws.close();
chrome.kill();
process.exit(fail === 0 ? 0 : 1);
