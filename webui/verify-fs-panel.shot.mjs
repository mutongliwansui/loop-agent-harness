#!/usr/bin/env node
/**
 * FilesView 右栏真实渲染探针（Task-20261026-001 / D3·D6·D7）
 *
 * 用 headless Chrome + CDP 打开 `webui/verify-fs-panel.html`（真实组件 + 真实样式 +
 * 固定 /fs/* 夹具），对每个场景取 DOM 像素探针并截图，避免「看截图猜结论」。
 *
 * 前置：另开终端跑 webui 的 vite dev（默认 3000 端口）。
 * 用法：node webui/verify-fs-panel.shot.mjs
 *       可选环境变量：VERIFY_BASE / VERIFY_OUT / CDP_PORT / CHROME_PATH
 * 产物：$VERIFY_OUT（默认 .tmp-verify-fs）下 png + summary.json；chrome 档案亦在该目录，用完可整个删除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.VERIFY_BASE || 'http://localhost:5173/verify-fs-panel.html';
const OUT = path.resolve(process.env.VERIFY_OUT || '.tmp-verify-fs');
const PORT = Number(process.env.CDP_PORT || 9336);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VP = { width: 1600, height: 1000 };

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
/** 页面内求值（返回可序列化值） */
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

/* ---------------- 页面内探针 ---------------- */
/* eslint-disable */
function pageProbe() {
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const px = (el, prop) => (el ? parseFloat(getComputedStyle(el)[prop]) || 0 : null);
  const rgb = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
  const side = q('.files-side');
  if (!side) return { ok: false, reason: '未找到 .files-side' };
  const rect = side.getBoundingClientRect();
  const rows = qa('.fs-body .row');
  const firstRow = rows[0];
  const dirRow = rows.find((r) => r.classList.contains('dir'));
  const fileRow = rows.find((r) => r.classList.contains('file') && !r.classList.contains('sel'));
  const selRow = q('.fs-body .row.sel');
  const selBar = selRow ? getComputedStyle(selRow, '::before') : null;
  const marks = qa('.res-hit mark');
  const mark = marks[0] ?? null;
  const head = q('.pn-head');
  const foot = q('.fs-foot');
  const skel = qa('.skel .sk');
  const empt = q('.fs-body .empt');
  const drop = q('.fs-body .drop:not(.row)'); // 注意：目录行落点也会加 .drop 类，需排除
  const dropRows = qa('.fs-body .row.drop');
  const groups = qa('.res-group');
  return {
    ok: true,
    side: { x: +rect.x.toFixed(1), y: +rect.y.toFixed(1), w: +rect.width.toFixed(1), h: +rect.height.toFixed(1) },
    headH: head ? +head.getBoundingClientRect().height.toFixed(2) : null,
    footH: foot ? +foot.getBoundingClientRect().height.toFixed(2) : null,
    rowCount: rows.length,
    rowH: firstRow ? +firstRow.getBoundingClientRect().height.toFixed(2) : null,
    // 缩进步长：第 2 层行的 padding-left 减去第 1 层
    lv0Pad: rows[0] ? px(rows[0], 'paddingLeft') : null,
    lv1Pad: (() => {
      const lv1 = rows.find((r) => r.style.getPropertyValue('--lv') === '1');
      return lv1 ? px(lv1, 'paddingLeft') : null;
    })(),
    // 引导线：四层展开后应存在 .gl
    guides: qa('.fs-body .gl').length,
    guideColor: qa('.fs-body .gl')[0] ? rgb(qa('.fs-body .gl')[0], 'backgroundColor') : null,
    selBarW: selBar ? selBar.width : null,
    selBarColor: selBar ? selBar.backgroundColor : null,
    selNameWeight: selRow ? rgb(selRow.querySelector('.nm'), 'fontWeight') : null,
    dirNameWeight: dirRow ? rgb(dirRow.querySelector('.nm'), 'fontWeight') : null,
    fileNameWeight: fileRow ? rgb(fileRow.querySelector('.nm'), 'fontWeight') : null,
    dirIconColor: dirRow ? rgb(dirRow.querySelector('.ico'), 'color') : null,
    fileIconColor: fileRow ? rgb(fileRow.querySelector('.ico'), 'color') : null,
    // 图标必须是内联 SVG，且全文不得再有 emoji / 字符三角
    svgIcons: qa('.fs-body .row .ico svg').length,
    emoji: /[📁📄▼▶]/.test(document.body.innerText),
    // 搜索态
    markCount: marks.length,
    markBg: mark ? rgb(mark, 'backgroundColor') : null,
    resGroups: groups.length,
    resHeadText: q('.res-head') ? q('.res-head').innerText.replace(/\s+/g, ' ') : null,
    resFileTexts: qa('.res-file').map((e) => e.innerText.replace(/\s+/g, ' ')),
    // 四态
    skelCount: skel.length,
    skelRowH: skel[0] ? +skel[0].getBoundingClientRect().height.toFixed(2) : null,
    emptyText: empt ? empt.innerText.replace(/\s+/g, ' ') : null,
    emptyBtn: empt?.querySelector('button')?.innerText ?? null,
    emptyIconDash: empt ? empt.querySelector('.big svg path')?.getAttribute('stroke-dasharray') ?? null : null,
    // 层级深度：data-path → --lv（视觉模型易把兄弟节点误读成子节点，用数据交叉核对）
    lv: (() => {
      const m = {};
      rows.forEach((r) => {
        if (r.dataset.path) m[r.dataset.path] = r.style.getPropertyValue('--lv');
      });
      return m;
    })(),
    crumbText: q('.crumb') ? q('.crumb').innerText.replace(/\s+/g, ' ') : null,
    dropText: drop ? drop.innerText.replace(/\s+/g, ' ') : null,
    dropRowHi: dropRows.length,
    dropRowPath: dropRows[0]?.dataset.path ?? null,
    footText: foot ? foot.innerText.replace(/\s+/g, ' ') : null,
    placeholder: q('.pn-head input') ? q('.pn-head input').placeholder : null,
    // 交互与无障碍
    headBtnTitles: qa('.pn-head .ib').map((b) => b.title),
    rowRoles: qa('.fs-body .row').every((r) => r.getAttribute('role') === 'treeitem' && r.tabIndex === 0),
    dirAria: qa('.fs-body .row.dir').every((r) => r.hasAttribute('aria-expanded')),
    dirActs: dirRow ? dirRow.querySelectorAll('.acts button').length : null,
    fileActs: fileRow ? fileRow.querySelectorAll('.acts button').length : null,
  };
}
/* eslint-enable */

const probe = () => ev(`(${pageProbe.toString()})()`);

/** 截图：裁到右栏面板（带 8px 余量），2 倍像素密度 */
async function shot(name) {
  const r = await probe();
  if (!r.ok) throw new Error(`场景 ${name} 探针失败：${r.reason}（检查 VERIFY_BASE 是否指向 vite dev，而非静态托管）`);
  const clip = {
    x: Math.max(0, r.side.x - 8),
    y: 0,
    width: Math.min(VP.width - Math.max(0, r.side.x - 8), r.side.w + 16),
    height: Math.min(VP.height, r.side.y + r.side.h),
    scale: 2,
  };
  const png = await send('Page.captureScreenshot', { format: 'png', clip });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(png.result.data, 'base64'));
  return file;
}

async function nav(scenario) {
  await send('Page.navigate', { url: `${BASE}?scenario=${scenario}` });
  await sleep(2200);
  for (let i = 0; i < 30; i++) {
    if (await ev('!!window.__fsVerifyEntryMount')) break;
    await sleep(200);
  }
  await sleep(600);
}

const summary = {};

/* ---------------- 场景 1：浅色主视图 + 四层展开 + 选中 ---------------- */
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await nav('tree');
for (const p of ['docs', 'docs/designs', 'docs/designs/sub']) {
  await ev(`(()=>{const r=document.querySelector('.row[data-path="${p}"]'); if(r) r.click(); return 1;})()`);
  await sleep(700);
}
await ev(`(()=>{const r=document.querySelector('.row[data-path="docs/designs/sub/deep.md"]'); if(r) r.click(); return 1;})()`);
await sleep(900);
summary.light = { png: await shot('light-4level'), ...(await probe()) };

/* ---------------- 场景 2：深色 ---------------- */
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await sleep(900);
summary.dark = { png: await shot('dark-4level'), ...(await probe()) };
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await sleep(500);

/* ---------------- 场景 3：搜索分组 + 高亮 ---------------- */
await nav('tree');
await ev(`(()=>{
  const inp = document.querySelector('.pn-head input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(inp, '引导线');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return inp.value;
})()`);
await sleep(1400);
summary.search = { png: await shot('search-grouped'), ...(await probe()) };

/* ---------------- 场景 4：拖拽浮层（根区 / 目录行） ---------------- */
await nav('tree');
const dragTo = async (selector) =>
  ev(`(()=>{
    const dt = new DataTransfer();
    dt.items.add(new File(['probe'], 'probe.txt', { type: 'text/plain' }));
    const el = document.querySelector('${selector}');
    if (!el) return 'no-target';
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return 'ok';
  })()`);
await dragTo('.fs-body');
await sleep(500);
summary.dropRoot = { png: await shot('drop-root'), ...(await probe()) };

await ev(`(()=>{const r=document.querySelector('.row[data-path="docs"]'); if(r){const dt=new DataTransfer();dt.items.add(new File(['p'],'p.txt',{type:'text/plain'}));r.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));} return 1;})()`);
await sleep(500);
summary.dropDir = { png: await shot('drop-dir-row'), ...(await probe()) };

/* ---------------- 场景 5：骨架屏 / 错误态 / 空态 ---------------- */
await nav('loading');
summary.loading = { png: await shot('state-loading'), ...(await probe()) };

await nav('error');
summary.error = { png: await shot('state-error'), ...(await probe()) };

await nav('empty');
summary.empty = { png: await shot('state-empty'), ...(await probe()) };

/* ---------------- 场景 6：交互（头部菜单 / hover 淡入）与宽度 ---------------- */
await nav('tree');
// 点头部第 2 个图标（上传）→ 应弹出二级菜单（上传文件 / 上传文件夹）
const uploadBtn = await ev(`(()=>{
  const b = document.querySelectorAll('.pn-head .ib')[1];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  b.click();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
await sleep(500);
const uploadMenu = await ev(`(()=>{const m=document.querySelector('.fs-menu'); return m ? m.innerText.replace(/\\s+/g,' ') : null;})()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: uploadBtn ? uploadBtn.x : 10, y: uploadBtn ? uploadBtn.y : 10, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: uploadBtn ? uploadBtn.x : 10, y: uploadBtn ? uploadBtn.y : 10, button: 'left', clickCount: 1 });
summary.menu = { png: await shot('header-upload-menu'), menuText: uploadMenu, ...(await probe()) };
await ev(`document.body.click()`);
await sleep(400);

// hover 文件行 → 行内操作应从 opacity:0 淡入到 1
const pt = await ev(`(()=>{const row=document.querySelector('.fs-body .row.file:not(.sel)'); if(!row) return null; const b=row.getBoundingClientRect(); return {x:b.x+b.width/2, y:b.y+b.height/2};})()`);
const actsBefore = await ev(`(()=>{const a=document.querySelector('.fs-body .row.file:not(.sel) .acts'); return a?getComputedStyle(a).opacity:null;})()`);
if (pt) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
await sleep(500);
const actsAfter = await ev(`(()=>{const a=document.querySelector('.fs-body .row.file:not(.sel) .acts'); return a?getComputedStyle(a).opacity:null;})()`);
summary.hover = { actsBefore, actsAfter, ...(await probe()) };

/* ---------------- 场景 7：搜索无命中 → 空态 + 清除 ---------------- */
await nav('tree');
await ev(`(()=>{
  const inp = document.querySelector('.pn-head input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(inp, 'zzz-not-exist');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return 1;
})()`);
await sleep(1400);
summary.searchEmpty = { png: await shot('search-empty'), ...(await probe()) };

/* ---------------- 结论 ---------------- */
const pad = (v) => (v === null || v === undefined ? 'n/a' : v);
const rows = [];
const add = (k, got, want) => rows.push({ 断言: k, 实测: got, 期望: want, ok: String(got) === String(want) });
const addOk = (k, ok, got) => rows.push({ 断言: k, 实测: got, 期望: '见断言名', ok: !!ok });

addOk('头部高度 ≤64px', summary.light.headH !== null && summary.light.headH <= 64, summary.light.headH);
add('树行高 26px', summary.light.rowH, 26);
add('缩进步长 14px', summary.light.lv1Pad - summary.light.lv0Pad, 14);
add('引导线数量 >0', summary.light.guides > 0, true);
add('选中色条宽 3px', summary.light.selBarW, '3px');
add('选中名 600', summary.light.selNameWeight, '600');
add('目录名 500', summary.light.dirNameWeight, '500');
add('文件名 400', summary.light.fileNameWeight, '400');
add('内联 SVG 图标 >0', summary.light.svgIcons > 0, true);
add('无 emoji/字符三角', summary.light.emoji, false);
addOk('搜索结果分组 ≥2', summary.search.resGroups >= 2, summary.search.resGroups);
add('搜索头部命中统计', /处命中 · .*个文件/.test(summary.search.resHeadText ?? ''), true);
add('mark 命中数 >0', summary.search.markCount > 0, true);
add('骨架屏 12 行', summary.loading.skelCount, 12);
add('骨架行高 26', summary.loading.skelRowH, 26);
add('错误态按钮', summary.error.emptyBtn, '重试');
add('空态文案含新建提示', /新建文件夹|还没有文件/.test(summary.empty.emptyText ?? ''), true);
add('空态图标为虚线空文件夹', summary.empty.emptyIconDash, '3 2.4');
add('加载态底栏文案', /加载中/.test(summary.loading.footText ?? ''), true);
add('错误态底栏文案', /读取失败/.test(summary.error.footText ?? ''), true);
add('根区浮层目标', summary.dropRoot.dropText, '松开即上传 目标：loop-agent-command / 根目录');
add('目录行浮层目标', summary.dropDir.dropText, '松开即上传 目标：docs');
add('目录行落点高亮', summary.dropDir.dropRowHi, 1);
add('落点高亮行 = docs', summary.dropDir.dropRowPath, 'docs');
add('底栏项数可见', /项/.test(summary.light.footText ?? ''), true);
// 层级交叉核对：docs=0、docs/designs=1、docs/designs/原型…html=2（兄弟，不是 sub 的子）、sub/deep.md=3
add('docs 层级 0', summary.light.lv.docs, '0');
add('designs 层级 1', summary.light.lv['docs/designs'], '1');
add('原型 html 层级 2（与 sub 同级）', summary.light.lv['docs/prototypes/2026-10-26/原型-20261026-001+文件目录重设计v2.html'], '2');
add('deep.md 层级 3', summary.light.lv['docs/designs/sub/deep.md'], '3');
add('面包屑文本', summary.light.crumbText, 'loop-agent-command › docs › designs › sub');
// 交互 / 无障碍 / 尺寸
add('面板默认宽 264px', summary.light.side.w, 264);
add('底栏项数 = 渲染行数', /^(\d+) 项/.exec(summary.light.footText ?? '')?.[1], String(summary.light.rowCount));
add('头部按钮 title 三连', summary.light.headBtnTitles.join('|'), '在根目录新建文件夹|上传文件 / 文件夹|刷新已展开的目录');
addOk('上传按钮弹出二级菜单', /上传文件.*上传文件夹/.test(summary.menu.menuText ?? ''), summary.menu.menuText);
add('行 role=treeitem + tabindex=0', summary.light.rowRoles, true);
add('目录行 aria-expanded', summary.light.dirAria, true);
add('目录行内操作 3 个（＋ ↑ ⋯）', summary.light.dirActs, 3);
add('文件行内操作 3 个（⤓ ✎ ⋯）', summary.light.fileActs, 3);
add('hover 前操作隐藏', summary.hover.actsBefore, '0');
add('hover 后操作淡入', summary.hover.actsAfter, '1');
addOk('搜索无命中空态', /没有匹配的文件/.test(summary.searchEmpty.emptyText ?? ''), summary.searchEmpty.emptyText);
add('搜索空态清除按钮', summary.searchEmpty.emptyBtn, '清除搜索');

console.log('\n=== 像素探针 ===');
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.断言}  实测=${pad(r.实测)}  期望=${pad(r.期望)}`);
const failed = rows.filter((r) => !r.ok);
console.log(`\n合计 ${rows.length} 条断言，失败 ${failed.length} 条`);

const detail = {
  light: summary.light,
  dark: summary.dark,
  search: summary.search,
  dropRoot: summary.dropRoot,
  dropDir: summary.dropDir,
  loading: summary.loading,
  error: summary.error,
  empty: summary.empty,
  menu: summary.menu,
  hover: summary.hover,
  searchEmpty: summary.searchEmpty,
};
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ asserts: rows, detail }, null, 2));
console.log(`\n产物目录：${OUT}`);

ws.close();
chrome.kill();
process.exit(failed.length ? 1 : 0);
