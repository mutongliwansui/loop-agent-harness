#!/usr/bin/env node
/**
 * 原型-20261027-003「模型性能指标测试」渲染验证（需求 20261027-003）
 *
 * 用 headless Chrome + CDP 打开自包含原型，四态（空态/运行中/完成/失败）× 亮暗双主题
 * 逐一截图并做 DOM 断言；同时把关键元素矩形写入 summary.json，供
 * `webui/verify-bench-proto.pixels.ps1` 做像素级取样复核（颜色令牌是否真的画到屏幕上）。
 *
 * 用法：node webui/verify-bench-proto.shot.mjs
 *       再做像素复核：powershell -NoProfile -ExecutionPolicy Bypass -File webui/verify-bench-proto.pixels.ps1
 * 可选环境变量：PROTO（原型路径） / VERIFY_OUT / CDP_PORT / CHROME_PATH
 * 产物：docs/designs/原型-20261027-003-预览-<state>-<theme>.png（10 张）+ temp/verify-bench-proto.summary.json
 * 退出码：断言全绿 0，否则 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
const PROTO = path.resolve(
  process.env.PROTO || path.join(ROOT, 'docs/designs/原型-20261027-003+模型性能指标测试.html'),
);
const OUT = path.resolve(process.env.VERIFY_OUT || path.join(ROOT, 'docs/designs'));
const PORT = Number(process.env.CDP_PORT || 9341);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VP = { width: 1600, height: 1000 };

if (!fs.existsSync(PROTO)) {
  console.error('原型不存在：' + PROTO);
  process.exit(1);
}
const BASE = pathToFileURL(PROTO).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- CDP ---------------- */
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(ROOT, 'temp', 'verify-bench-profile')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
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
const pageErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push('exception: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    pageErrors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
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
  deviceScaleFactor: 1,
  mobile: false,
});

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, `原型-20261027-003-预览-${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return p;
}

// 预览图沿用项目既有中文命名惯例（见 原型-20261027-001-预览-浅色运行中.png）
const NAME_CN = { empty: '空态', running: '运行中', done: '完成态', error: '失败态', table: '表格态' };
const THEME_CN = { light: '浅色', dark: '深色' };
const shotName = (state, theme) => `${NAME_CN[state]}${THEME_CN[theme]}`;

/* ---------------- 页面探针（在页面内执行） ---------------- */
/* eslint-disable */
function pageProbe() {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const cs = (el, pseudo) => (el ? getComputedStyle(el, pseudo || null) : null);
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  };
  const visible = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const style = (sel, p) => {
    const el = q(sel);
    return el ? getComputedStyle(el)[p] : null;
  };

  const bestRow = q('.cmp-row.best');
  const bestBar = bestRow ? bestRow.querySelector('.bar') : null;
  const bestTrack = bestRow ? bestRow.querySelector('.track') : null;

  return {
    state: document.body.dataset.state,
    theme: document.documentElement.dataset.theme,
    drawerOpen: !!q('.drawer.open'),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    // 区块可见性
    blocks: {
      config: visible(q('.bench-config')),
      cfgbar: visible(q('.bench-cfgbar')),
      run: visible(q('.bench-run')),
      result: visible(q('.bench-result')),
      empty: visible(q('.bench-empty')),
    },
    counts: {
      metricVisible: qa('.metric-grid .metric').filter(visible).length,
      cmpRows: qa('.cmp-row').length,
      detailRows: qa('.mini-tbl tbody tr').length,
      histRows: qa('.hist .row').length,
      pulseRects: qa('#pulse rect').length,
      sparkSvg: qa('.hist svg').length,
    },
    notices: {
      buffered: visible(q('#buffered-note')),
      error: visible(q('#error-note')),
    },
    // 对比图几何：最优项条长应 ≈ 轨道 100%
    best: bestBar && bestTrack
      ? {
          ratio: +(bestBar.getBoundingClientRect().width / bestTrack.getBoundingClientRect().width).toFixed(3),
          color: getComputedStyle(bestBar).backgroundColor,
          track: rect(bestTrack),
          bar: rect(bestBar),
        }
      : null,
    // 令牌契合度：设计令牌应原样落到渲染结果
    tokens: {
      bodyBg: style('body', 'backgroundColor'),
      drawerBg: style('.drawer', 'backgroundColor'),
      brand: style('.badge.brand', 'color'),
      // 指标卡左侧 3px 状态条（伪元素）
      metricGoodBar: q('.metric.good') ? getComputedStyle(q('.metric.good'), '::before').backgroundColor : null,
      metricWarnBar: q('.metric.warn') ? getComputedStyle(q('.metric.warn'), '::before').backgroundColor : null,
      metricBadBar: q('.metric.bad') ? getComputedStyle(q('.metric.bad'), '::before').backgroundColor : null,
    },
    // 像素取样锚点（交给 PowerShell 在 PNG 上复核）
    anchors: {
      metricGoodBar: (() => {
        const el = q('.metric.good');
        return el ? rect(el) : null;
      })(),
      bestBar: bestBar ? rect(bestBar) : null,
      drawer: rect(q('.drawer')),
    },
    // 运行中：首 token 状态与读数
    live: {
      ttftK: q('#live-ttft') ? q('#live-ttft').querySelector('.k').textContent : null,
      ttftV: q('#v-ttft') ? q('#v-ttft').textContent : null,
      tok: q('#v-tok') ? q('#v-tok').textContent : null,
      progW: q('#prog-bar') ? q('#prog-bar').style.width : null,
    },
    // 文本抽查（防文案被改坏）
    text: {
      metricK: qa('.metric .k').map((e) => e.textContent),
      snapshot: q('#cfg-snapshot') ? q('#cfg-snapshot').textContent : null,
      perfCol: qa('[data-perf]').map((e) => e.textContent),
    },
  };
}

/* ---------------- 断言 ---------------- */
const BRAND_LIGHT = 'rgb(14, 159, 110)';
const BRAND_DARK = 'rgb(52, 211, 153)';
const BG_LIGHT = 'rgb(246, 247, 249)';
const BG_DARK = 'rgb(20, 23, 28)';
const OK_LIGHT = 'rgb(5, 150, 105)';
const WARN_LIGHT = 'rgb(180, 83, 9)';
const DANGER_LIGHT = 'rgb(220, 38, 38)';
const OK_DARK = 'rgb(52, 211, 153)';
const WARN_DARK = 'rgb(251, 191, 36)';
const DANGER_DARK = 'rgb(248, 113, 113)';

const checks = [];
function expect(name, cond, detail) {
  checks.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
}

const summary = {};
for (const theme of ['light', 'dark']) {
  for (const state of ['done', 'empty', 'running', 'error']) {
    const url = `${BASE}?state=${state}&theme=${theme}`;
    await send('Page.navigate', { url });
    await sleep(700);
    if (state === 'running') {
      // 运行中态：轮询等「首 token 已翻牌 + 脉冲柱已生成」，最多 8s（避免固定 sleep 的时序抖动）
      for (let i = 0; i < 32; i++) {
        const ready = await ev(
          `(function(){var k=document.querySelector('#live-ttft .k');var r=document.querySelectorAll('#pulse rect').length;return !!k && k.textContent==='TTFT' && r>0;})()`,
        );
        if (ready) break;
        await sleep(250);
      }
      await sleep(300);
    } else {
      await sleep(300);
    }
    const probe = await ev(`(${pageProbe.toString()})()`);
    const png = await shot(shotName(state, theme));
    summary[`${state}-${theme}`] = { png, ...probe };

    const tag = `[${state}/${theme}]`;
    expect(`${tag} 页面无 JS 异常`, pageErrors.length === 0, pageErrors.join(' | '));
    expect(`${tag} state 落地`, probe.state === state, probe.state);
    expect(`${tag} theme 落地`, probe.theme === theme, probe.theme);
    expect(`${tag} 抽屉已展开`, probe.drawerOpen);
    expect(`${tag} 无横向溢出`, probe.scrollWidth <= probe.viewport.w + 1, `${probe.scrollWidth} vs ${probe.viewport.w}`);

    if (state === 'done') {
      expect(`${tag} 结果区可见 / 运行区隐藏`, probe.blocks.result && !probe.blocks.run && !probe.blocks.empty);
      expect(`${tag} 配置折叠为摘要条`, probe.blocks.cfgbar && !probe.blocks.config);
      expect(`${tag} 结果区首屏可见指标卡`, probe.anchors.metricGoodBar && probe.anchors.metricGoodBar.y < probe.viewport.h,
        probe.anchors.metricGoodBar && probe.anchors.metricGoodBar.y);
      expect(`${tag} 三张指标卡可见`, probe.counts.metricVisible === 3, probe.counts.metricVisible);
      expect(`${tag} 对比 4 行`, probe.counts.cmpRows === 4, probe.counts.cmpRows);
      expect(`${tag} 明细 6 行`, probe.counts.detailRows === 6, probe.counts.detailRows);
      expect(`${tag} 历史 5 行`, probe.counts.histRows === 5, probe.counts.histRows);
      expect(`${tag} 历史迷你图 10 个 SVG`, probe.counts.sparkSvg === 10, probe.counts.sparkSvg);
      expect(`${tag} 无缓冲/限流告警`, !probe.notices.buffered && !probe.notices.error);
      expect(`${tag} 最优条长 ≈100%`, probe.best && probe.best.ratio > 0.97 && probe.best.ratio <= 1.001, probe.best && probe.best.ratio);
      expect(`${tag} 最优条为 brand 色`,
        probe.best && probe.best.color === (theme === 'light' ? BRAND_LIGHT : BRAND_DARK), probe.best && probe.best.color);
      expect(`${tag} 指标卡三色状态条`,
        probe.tokens.metricGoodBar === (theme === 'light' ? OK_LIGHT : OK_DARK) &&
        probe.tokens.metricWarnBar === (theme === 'light' ? WARN_LIGHT : WARN_DARK) &&
        probe.tokens.metricBadBar === (theme === 'light' ? DANGER_LIGHT : DANGER_DARK),
        JSON.stringify([probe.tokens.metricGoodBar, probe.tokens.metricWarnBar, probe.tokens.metricBadBar]));
      expect(`${tag} 指标卡文案齐全`,
        probe.text.metricK.includes('TTFT（首 token）') &&
        probe.text.metricK.includes('解码吞吐') &&
        probe.text.metricK.includes('稳定性'), JSON.stringify(probe.text.metricK));
    }

    if (state === 'empty') {
      expect(`${tag} 空态可见 / 结果区隐藏`, probe.blocks.empty && !probe.blocks.result && !probe.blocks.run);
      expect(`${tag} 空态无指标卡`, probe.counts.metricVisible === 0, probe.counts.metricVisible);
    }

    if (state === 'running') {
      expect(`${tag} 运行区可见 / 配置区隐藏`, probe.blocks.run && !probe.blocks.config);
      expect(`${tag} 脉冲柱已生成`, probe.counts.pulseRects > 0, probe.counts.pulseRects);
      expect(`${tag} 首 token 读数已翻牌`, probe.live.ttftK === 'TTFT' && /ms$/.test(probe.live.ttftV),
        `${probe.live.ttftK} / ${probe.live.ttftV}`);
      expect(`${tag} token 计数在增长`, /\d+ tok/.test(probe.live.tok) && parseInt(probe.live.tok, 10) > 0, probe.live.tok);
      expect(`${tag} 进度条已推进`, probe.live.progW && parseFloat(probe.live.progW) > 0, probe.live.progW);
    }

    if (state === 'error') {
      expect(`${tag} 失败态仅 1 张指标卡（红色）`, probe.counts.metricVisible === 1, probe.counts.metricVisible);
      expect(`${tag} 429 提示可见`, probe.notices.error);
      expect(`${tag} 明细仅保留成功轮次`, probe.counts.detailRows === 2, probe.counts.detailRows);
    }

    // 主题底色
    expect(`${tag} 页面底色契合令牌`,
      probe.tokens.bodyBg === (theme === 'light' ? BG_LIGHT : BG_DARK), probe.tokens.bodyBg);
  }

  // 表格态（抽屉关闭）：验证新增「性能」列与「测速」按钮在首屏可见、未被裁剪
  await send('Page.navigate', { url: `${BASE}?state=done&theme=${theme}&closed=1` });
  await sleep(900);
  const tableProbe = await ev(`(${pageProbe.toString()})()`);
  const tablePng = await shot(shotName('table', theme));
  summary[`table-${theme}`] = { png: tablePng, ...tableProbe };
  const ths = await ev(`Array.from(document.querySelectorAll('table.tbl th')).map(function(e){return e.textContent.trim();})`);
  const benchBtns = await ev(
    `Array.from(document.querySelectorAll('[data-act="bench"]')).map(function(b){var r=b.getBoundingClientRect();return {t:b.textContent,vis:r.width>0&&r.right<window.innerWidth+1};})`,
  );
  const perfCells = await ev(
    `Array.from(document.querySelectorAll('[data-perf]')).map(function(e){var r=e.getBoundingClientRect();return {t:e.textContent,vis:r.width>0&&r.right<window.innerWidth+1};})`,
  );
  expect(`[table/${theme}] 抽屉已关闭`, !tableProbe.drawerOpen);
  expect(`[table/${theme}] 表头含「性能」列`, ths.includes('性能'), JSON.stringify(ths));
  expect(`[table/${theme}] 4 个性能摘要均在视口内`,
    perfCells.length === 4 && perfCells.every((c) => c.vis), JSON.stringify(perfCells));
  expect(`[table/${theme}] 4 个「测速」按钮均在视口内`,
    benchBtns.length === 4 && benchBtns.every((b) => b.t === '测速' && b.vis), JSON.stringify(benchBtns));

  // 表格「性能」列
  const perfCol = summary[`done-${theme}`].text.perfCol;
  expect(`[table/${theme}] 性能列 4 行摘要`,
    perfCol.length === 4 && perfCol[0].includes('TTFT') && perfCol[3] === '未测', JSON.stringify(perfCol));
}

fs.writeFileSync(path.join(ROOT, 'temp', 'verify-bench-proto.summary.json'), JSON.stringify(summary, null, 2));

/* ---------------- 输出 ---------------- */
const failed = checks.filter((c) => !c.ok);
console.log('\n=== 原型-20261027-003 渲染验证 ===');
for (const c of checks) {
  if (!c.ok) console.log(`  ✗ ${c.name}  <${c.detail}>`);
}
console.log(`\n断言 ${checks.length} 条，通过 ${checks.length - failed.length}，失败 ${failed.length}`);
console.log('截图 10 张（四态 × 亮暗 + 表格态 × 亮暗）→ ' + OUT);
console.log('summary → temp/verify-bench-proto.summary.json\n');

ws.close();
chrome.kill();
process.exit(failed.length === 0 ? 0 : 1);
