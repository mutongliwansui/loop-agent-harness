#!/usr/bin/env node
/**
 * 对话输入区（.composer）现状基线探针（需求 20261025-001 · 设计前的实测取证）
 *
 * 用 headless Chrome + CDP 打开真实 WebUI（vite dev），对输入区取 DOM 像素探针 +
 * 截图，得到「改版前」的真实数值，供原型对照与后续落地回归。
 *
 * 前置：另开终端在 webui/ 跑 `npm run dev`。
 * 用法：node webui/verify-composer.shot.mjs
 *       可选环境变量：VERIFY_BASE / VERIFY_OUT / CDP_PORT / CHROME_PATH
 * 产物：$VERIFY_OUT（默认 .tmp-verify-composer）下 png + summary.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.VERIFY_BASE || 'http://localhost:5173/';
const OUT = path.resolve(process.env.VERIFY_OUT || '.tmp-verify-composer');
const PORT = Number(process.env.CDP_PORT || 9337);
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

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return p;
}

async function goto(theme) {
  await send('Page.navigate', { url: BASE });
  await sleep(1600);
  await ev(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; 1`);
  await sleep(500);
  for (let i = 0; i < 40; i++) {
    const ok = await ev(`!!document.querySelector('.composer')`);
    if (ok) break;
    await sleep(250);
  }
  await sleep(400);
}

/* ---------------- 页面内探针 ---------------- */
/* eslint-disable */
function pageProbe() {
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
  const inner = q('.composer-inner');
  const box = q('.composer .box');
  const ta = q('.composer textarea');
  const attach = q('.composer .attach');
  const sendBtn = q('.composer .send');
  const stopBtn = q('.composer .stop');
  const meta = q('.composer .meta');
  const hint = q('.composer .hint');
  const notify = q('.composer .notify-btn');
  const bodyText = comp ? comp.innerText : '';
  const EMOJI = ['\u{1F4CE}', '\u{1F514}', '\u25A0', '\u2715'];
  return {
    composer: {
      rect: rect(comp),
      borderTopWidth: px(comp, 'borderTopWidth'),
      paddingTop: px(comp, 'paddingTop'),
      paddingBottom: px(comp, 'paddingBottom'),
      paddingLeft: px(comp, 'paddingLeft'),
      bg: cs(comp, 'backgroundColor'),
    },
    inner: { rect: rect(inner), maxWidth: px(inner, 'maxWidth') },
    box: { rect: rect(box), gap: px(box, 'gap'), alignItems: cs(box, 'alignItems') },
    textarea: {
      rect: rect(ta),
      height: px(ta, 'height'),
      lineHeight: cs(ta, 'lineHeight'),
      resize: cs(ta, 'resize'),
      borderWidth: px(ta, 'borderTopWidth'),
      borderColor: cs(ta, 'borderTopColor'),
      radius: px(ta, 'borderTopLeftRadius'),
      placeholder: ta ? ta.placeholder : null,
      scrollH: ta ? ta.scrollHeight : null,
    },
    attach: {
      rect: rect(attach),
      fontSize: px(attach, 'fontSize'),
      borderWidth: px(attach, 'borderTopWidth'),
      text: attach ? attach.innerText : null,
      hasSvg: attach ? !!attach.querySelector('svg') : null,
    },
    send: { rect: rect(sendBtn), text: sendBtn ? sendBtn.innerText : null, bg: cs(sendBtn, 'backgroundColor') },
    stop: { rect: rect(stopBtn), text: stopBtn ? stopBtn.innerText : null },
    meta: {
      rect: rect(meta),
      fontSize: px(meta, 'fontSize'),
      color: cs(meta, 'color'),
      gap: px(meta, 'gap'),
      text: meta ? meta.innerText.replace(/\s+/g, ' ') : null,
    },
    hint: { rect: rect(hint), fontSize: px(hint, 'fontSize'), visible: hint ? cs(hint, 'display') !== 'none' : null },
    notify: { text: notify ? notify.innerText : null, hasSvg: notify ? !!notify.querySelector('svg') : null },
    // emoji / 字符图标取证
    emojiHits: EMOJI.filter((e) => bodyText.includes(e)).map((e) => 'U+' + e.codePointAt(0).toString(16).toUpperCase()),
    svgInComposer: qa('.composer svg').length,
    // 边框层数：composer 上沿 + textarea 上沿 + chip 上沿
    borderStack: [px(comp, 'borderTopWidth'), px(ta, 'borderTopWidth')],
    // 按钮种类与权重
    btnKinds: qa('.composer button').map((b) => ({
      cls: b.className,
      bg: cs(b, 'backgroundColor'),
      color: cs(b, 'color'),
      border: cs(b, 'borderTopColor'),
      w: +b.getBoundingClientRect().width.toFixed(1),
    })),
    taResizeTo: (() => {
      // 模拟长输入：写入 6 行文本后看高度是否变化
      if (!ta) return null;
      const before = ta.getBoundingClientRect().height;
      ta.value = Array.from({ length: 6 }, (_, i) => '第' + (i + 1) + '行内容').join('\n');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const after = ta.getBoundingClientRect().height;
      return { before, after, grew: after > before + 1, scrollH: ta.scrollHeight };
    })(),
  };
}

const summary = {};
for (const theme of ['light', 'dark']) {
  await goto(theme);
  summary[theme] = { png: await shot(`baseline-${theme}`), ...(await ev(`(${pageProbe.toString()})()`)) };
}

/* ---------------- 输出 ---------------- */
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
const L = summary.light;
console.log('\n=== 现状基线（改版前，真实渲染 1600×1000）===');
console.log('composer  ', JSON.stringify(L.composer.rect), 'border-top', L.composer.borderTopWidth + 'px', 'padding', `${L.composer.paddingTop}/${L.composer.paddingBottom}px`);
console.log('inner      ', JSON.stringify(L.inner.rect), 'max-width', L.inner.maxWidth + 'px');
console.log('textarea   ', JSON.stringify(L.textarea.rect), 'resize=' + L.textarea.resize, 'border=' + L.textarea.borderWidth + 'px');
console.log('  placeholder:', JSON.stringify(L.textarea.placeholder));
console.log('  scrollHeight:', L.textarea.scrollH);
console.log('attach     ', JSON.stringify(L.attach.rect), 'font', L.attach.fontSize + 'px', 'svg=' + L.attach.hasSvg);
console.log('send       ', JSON.stringify(L.send.rect), JSON.stringify(L.send.text));
console.log('meta       ', JSON.stringify(L.meta.rect), 'font', L.meta.fontSize + 'px', 'color', L.meta.color);
console.log('  text     :', JSON.stringify(L.meta.text));
console.log('emoji 命中  ', L.emojiHits.join(' ') || '（无）', '| composer 内 svg 数:', L.svgInComposer);
console.log('边框层叠    ', L.borderStack.join(' + '), 'px');
console.log('长输入自增高', JSON.stringify(L.taResizeTo));
console.log('按钮权重    ', JSON.stringify(L.btnKinds, null, 1));
console.log('\n产物目录：' + OUT + '\n');

ws.close();
chrome.kill();
process.exit(0);
