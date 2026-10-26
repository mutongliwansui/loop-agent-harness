#!/usr/bin/env node
/**
 * 模型性能测试 WebUI 真机验证（需求 20261027-003）
 *
 * 与原型验证（verify-bench-proto.shot.mjs）的区别：这里跑的是**真实 WebUI**，
 * 且它不是从静态原型里读假数据，而是：
 *   假 LLM（真 SSE，节奏按 model 名切换）← 真 API 服务 ← 真 bench 引擎 ← 真 WebUI（webui/dist）
 * 只有模型本身是假的，其余链路（建 run / SSE 事件 / token 计时 / usage 权威计数 /
 * 历史落盘 / 表格「性能」列 / 抽屉四态）全部是真跑。
 *
 * 用法：
 *   npm --prefix webui run build                      # 先构建（静态托管读 webui/dist）
 *   node webui/verify-bench-ui.mjs                    # 自带拉起 verify-bench-ui.server.ts
 *   powershell -NoProfile -ExecutionPolicy Bypass -File webui/verify-bench-ui.pixels.ps1   # 像素复核
 * 环境变量：E2E_BASE（复用已起的服务）/ CDP_PORT / CHROME_PATH / VERIFY_OUT
 * 产物：temp/verify-bench-ui/*.png + temp/verify-bench-ui/summary.json
 * 退出码：断言全绿 0，否则 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('.');
const OUT = path.resolve(process.env.VERIFY_OUT || path.join(ROOT, 'temp', 'verify-bench-ui'));
const PORT = Number(process.env.CDP_PORT || 9351);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VP = { width: 1600, height: 1000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

/* ---------------- 断言账本 ---------------- */
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? 'ok' : 'X '} ${name}${detail ? '  ' + detail : ''}`);
  return ok;
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return check(name, ok, ok ? '' : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}
function near(name, actual, expected, tol) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
  return check(name, ok, `got ${actual} want ${expected}±${tol}`);
}

/* ---------------- 拉起后端（假 LLM + 真 API） ---------------- */
let serverProc = null;
let base = process.env.E2E_BASE || '';

async function startServer() {
  if (base) {
    console.log(`复用已启动服务：${base}`);
    return;
  }
  serverProc = spawn('npx', ['tsx', 'webui/verify-bench-ui.server.ts'], {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('后端 60s 内未就绪：' + buf.slice(-500))), 60_000);
    serverProc.stdout.on('data', (d) => {
      buf += String(d);
      const m = buf.match(/E2E_READY (\{.*\})/);
      if (m) {
        clearTimeout(timer);
        resolve(JSON.parse(m[1]));
      }
    });
    serverProc.stderr.on('data', (d) => {
      buf += String(d);
    });
    serverProc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`后端提前退出 code=${code}：${buf.slice(-800)}`));
    });
  });
  base = ready.base;
  console.log(`后端就绪：api=${ready.base} mock=${ready.mockPort} benchRoot=${ready.benchRoot}`);
}

/* ---------------- Chrome + CDP ---------------- */
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'chrome-profile')}`,
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

let ws;
let seq = 0;
const pending = new Map();
const pageErrors = [];

async function connect() {
  ws = new WebSocket(await wsUrl());
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
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
}

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

/** 轮询等待页面条件成立 */
async function waitFor(expr, label, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await ev(expr)) return true;
    await sleep(80);
  }
  throw new Error(`等待超时（${label}）：${expr}`);
}

async function shot(name) {
  // 截图前等抽屉滑入 / 主题重排稳定：抽屉是 transform 0.2s 过渡，`.open` 类一加就满足
  // vis('.drawer.open')，若此时立刻截图会截到动画中途，像素取样整体偏移十几像素
  // （done-dark 曾偏 20px，被误判成"状态条没画"）。
  try {
    await waitFor(`__t.settle('.drawer.open', 120)`, '抽屉位置稳定', 6000);
  } catch {
    /* 无抽屉的页面忽略 */
  }
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return p;
}

/* ---------------- 页面内的探针与操作助手 ---------------- */
const HELPERS = `
window.__t = {
  txt(sel) { const e = document.querySelector(sel); return e ? e.textContent.trim().replace(/\\s+/g, ' ') : null; },
  vis(sel) { const e = document.querySelector(sel); if (!e) return false; const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity !== 0 && r.width > 0 && r.height > 0; },
  rect(sel) { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; },
  all(sel) { return Array.from(document.querySelectorAll(sel)); },
  // 位置稳定判定：两次测量 rect 一致才算稳定（抽屉 transform 过渡 0.2s）
  settle(sel, ms) {
    const e = document.querySelector(sel);
    if (!e) return Promise.resolve(true);
    const a = JSON.stringify(this.rect(sel));
    return new Promise((res) => setTimeout(() => res(JSON.stringify(this.rect(sel)) === a), ms));
  },
  row(alias) { const re = new RegExp('^' + alias + '(\\\\s|$)'); return this.all('table tbody tr').find((tr) => re.test((tr.children[0]?.textContent || '').trim())) || null; },
  rowBtn(alias, text) { const r = this.row(alias); if (!r) throw new Error('行未找到: ' + alias); const b = Array.from(r.querySelectorAll('button')).find((x) => x.textContent.includes(text)); if (!b) throw new Error('行内按钮未找到: ' + text); b.click(); return true; },
  rowCell(alias, idx) { const r = this.row(alias); return r ? (r.children[idx]?.textContent || '').trim() : null; },
  cellRect(alias, idx) { const r = this.row(alias); const c = r && r.children[idx]; if (!c) return null; const b = c.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; },
  badgeRect(alias, idx) { const r = this.row(alias); const c = r && r.children[idx]; const b = c && c.querySelector('.badge'); if (!b) return null; const x = b.getBoundingClientRect(); return { x: +x.x.toFixed(1), y: +x.y.toFixed(1), w: +x.width.toFixed(1), h: +x.height.toFixed(1) }; },
  clickBtn(text, scope) { const root = scope ? document.querySelector(scope) : document; const b = Array.from(root.querySelectorAll('button')).find((x) => x.textContent.includes(text)); if (!b) throw new Error('按钮未找到: ' + text); b.click(); return true; },
  hasBtn(text, scope) { const root = scope ? document.querySelector(scope) : document; return Array.from(root.querySelectorAll('button')).some((x) => x.textContent.includes(text)); },
  addAlias(alias) { const sel = document.querySelector('.alias-add'); if (!sel) throw new Error('加入对比下拉未找到'); sel.value = alias; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; },
  startAny() {
    const scope = document.querySelector('.drawer');
    const label = (b) => b.textContent.trim();
    const btns = () => Array.from(scope.querySelectorAll('button'));
    const cfg = this.vis('.bench-config');
    if (cfg) { const q = btns().find((b) => b.textContent.includes('快速 · 1 轮')); if (q) q.click(); }
    const run = btns().find((b) => ['开始测试', '按默认档位开跑'].includes(label(b)));
    if (!run) {
      const sections = ['bench-config', 'bench-cfgbar', 'bench-run', 'bench-result', 'bench-empty'].filter((c) => this.vis('.' + c));
      throw new Error('找不到开跑按钮；可见区块=' + JSON.stringify(sections) + ' 按钮=' + JSON.stringify(btns().map(label)));
    }
    run.click();
    return label(run);
  },
  theme(t) { document.documentElement.setAttribute('data-theme', t); return document.documentElement.dataset.theme; },
  badge(sel) { const e = document.querySelector(sel); if (!e) return null; return { text: e.textContent.trim(), color: getComputedStyle(e).color, bg: getComputedStyle(e).backgroundColor }; },
};
true;
`;

/* ---------------- 主流程 ---------------- */
const summary = {};
let failCount = 0;

async function main() {
  await startServer();
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: VP.width, height: VP.height, deviceScaleFactor: 1, mobile: false });

  // ---------- 表格态（未测速） ----------
  console.log('\n=== ① 模型页表格态 ===');
  await send('Page.navigate', { url: `${base}/#/models` });
  await waitFor(`document.querySelectorAll('table tbody tr').length >= 4`, '模型表加载');
  await ev(HELPERS);
  await sleep(300);

  eq('表头含「性能」列', await ev(`__t.all('table thead th').map(th=>th.textContent.trim()).includes('性能')`), true);
  eq('4 行模型都有「测速」按钮', await ev(`__t.all('table tbody tr').filter(tr=>Array.from(tr.querySelectorAll('button')).some(b=>b.textContent.includes('测速'))).length`), 4);
  eq('未测速时性能列显示「未测」', (await ev(`__t.rowCell('fast', 5)`)).includes('未测'), true);
  eq('页面无横向溢出（未测）', await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), true);
  summary['table-light'] = {
    png: await shot('table-light'),
    viewport: { w: await ev('window.innerWidth'), h: await ev('window.innerHeight') },
    perfCells: await ev(`['fast','slow','buffer','fail'].map(a=>__t.rowCell(a,5))`),
    anchors: { body: await ev(`__t.rect('body')`), perfBadge: await ev(`__t.badgeRect('fast',5)`) },
  };

  // ---------- 空态 → 运行中 → 完成态（slow 模型，便于抓运行中） ----------
  console.log('\n=== ② 空态 / 运行中 / 完成态（slow 模型） ===');
  await ev(`__t.rowBtn('slow','测速')`);
  await waitFor(`__t.vis('.drawer.open')`, '抽屉打开');
  await waitFor(`__t.vis('.bench-empty') || __t.vis('.bench-result')`, '抽屉内容就绪', 8000);
  eq('首次进入 = 空态', await ev(`__t.vis('.bench-empty')`), true);
  eq('空态文案点出模型名', (await ev(`__t.txt('.bench-empty .t')`))?.includes('slow'), true);
  eq('空态没有结果区', await ev(`__t.vis('.bench-result')`), false);
  eq('空态给出默认档位开跑按钮', await ev(`__t.hasBtn('按默认档位开跑', '.drawer')`), true);
  summary['empty-light'] = {
    png: await shot('empty-light'),
    viewport: { w: await ev('window.innerWidth'), h: await ev('window.innerHeight') },
    text: { title: await ev(`__t.txt('.bench-empty .t')`) },
  };

  await ev(`__t.clickBtn('按默认档位开跑', '.drawer')`);
  await waitFor(`__t.vis('.bench-run')`, '进入运行中');
  // 抓一帧「已产生 token、脉冲条已画」的运行中画面
  await waitFor(`__t.all('.pulse-box rect').length > 0`, '脉冲条出现', 15_000);
  const runSnap = await ev(`({
    liveTokens: __t.txt('.live-grid .live-cell:nth-child(2) .v'),
    firstToken: __t.txt('.live-grid .live-cell:nth-child(1) .v'),
    firstLabel: __t.txt('.live-grid .live-cell:nth-child(1) .k'),
    pulseRects: __t.all('.pulse-box rect').length,
    progress: __t.txt('.prog-head span'),
    stopVisible: __t.hasBtn('中断', '.drawer'),
    configHidden: !__t.vis('.bench-config'),
    resultHidden: !__t.vis('.bench-result'),
  })`);
  check('运行中：脉冲条已绘制', runSnap.pulseRects > 0, `rect=${runSnap.pulseRects}`);
  check('运行中：首 token 已翻牌', runSnap.firstLabel === '首 token' && /ms|s$/.test(runSnap.firstToken || ''), `${runSnap.firstLabel}=${runSnap.firstToken}`);
  check('运行中：已生成 token 数 > 0', parseInt(runSnap.liveTokens, 10) > 0, runSnap.liveTokens);
  check('运行中：进度文案含轮次', /第 \d+ \/ \d+ 轮/.test(runSnap.progress || ''), runSnap.progress);
  eq('运行中：中断按钮在', runSnap.stopVisible, true);
  eq('运行中：配置区已隐藏', runSnap.configHidden, true);
  eq('运行中：结果区未出现', runSnap.resultHidden, true);
  summary['running-light'] = {
    png: await shot('running-light'),
    viewport: { w: await ev('window.innerWidth'), h: await ev('window.innerHeight') },
    text: runSnap,
  };

  await waitFor(`__t.vis('.bench-result')`, '完成态出现', 40_000);
  // finalize 后的历史是异步拉的，等它落位再断言（否则 rows 可能还是 0）
  await waitFor(`__t.all('.hist .row').length >= 1`, '历史条回填', 10_000);
  const done = await ev(`({
    cfgbar: __t.vis('.bench-cfgbar'),
    cfgbarText: __t.txt('.bench-cfgbar'),
    metricCards: __t.all('.metric-grid .metric').length,
    metricGood: __t.all('.metric-grid .metric.good').length,
    ttft: __t.txt('.metric-grid .metric:nth-child(1) .v'),
    tps: __t.txt('.metric-grid .metric:nth-child(2) .v'),
    stab: __t.txt('.metric-grid .metric:nth-child(3) .v'),
    verdict: __t.txt('.bench-result .cfg-hint'),
    cmpRows: __t.all('.cmp-row').length,
    cmpBest: __t.all('.cmp-row.best').length,
    bestBarPct: (() => { const row = document.querySelector('.cmp-row.best'); if (!row) return null; const bar = row.querySelector('.bar'); const tr = row.querySelector('.track'); return bar && tr ? +(bar.getBoundingClientRect().width / tr.getBoundingClientRect().width * 100).toFixed(1) : null; })(),
    detailRows: __t.all('.mini-tbl tbody tr').length,
    histRows: __t.all('.hist .row').length,
    sparkSvg: __t.all('.hist svg').length,
    actions: __t.hasBtn('重新测试', '.drawer') && __t.hasBtn('导出 JSON', '.drawer'),
    runHidden: !__t.vis('.bench-run'),
    overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
    metricFirstVisibleY: __t.rect('.metric-grid .metric'),
    histFirstValue: __t.txt('.hist .row .n'),
  })`);
  eq('完成态：配置折叠成摘要条', done.cfgbar, true);
  check('完成态：摘要条写清配置', /轮/.test(done.cfgbarText || ''), done.cfgbarText);
  eq('完成态：3 张指标卡', done.metricCards, 3);
  check('完成态：TTFT 卡为绿色档（slow=364ms ≤ 800）', done.metricGood >= 1, `good=${done.metricGood}`);
  check('完成态：TTFT 数值为毫秒', /^\d+ms$/.test(done.ttft || ''), done.ttft);
  check('完成态：吞吐卡有 tok/s', /tok\/s/.test(done.tps || ''), done.tps);
  check('完成态：稳定性卡为百分比', /%$/.test(done.stab || ''), done.stab);
  check('完成态：结论文案非空', (done.verdict || '').length > 5, done.verdict);
  eq('完成态：单模型只有 1 行对比', done.cmpRows, 1);
  near('完成态：单模型对比条 = 100%', done.bestBarPct, 100, 0.5);
  eq('完成态：默认档位 6 轮明细', done.detailRows, 6);
  check('完成态：历史有 1 条且带数值', done.histRows >= 1 && /ms/.test(done.histFirstValue || ''), `rows=${done.histRows} first=${done.histFirstValue}`);
  eq('完成态：历史含两条迷你走势', done.sparkSvg >= 2, true);
  eq('完成态：重新测试/导出按钮在', done.actions, true);
  eq('完成态：运行区已隐藏', done.runHidden, true);
  eq('完成态：无横向溢出', done.overflow, true);
  check('完成态：指标卡首屏可见', (done.metricFirstVisibleY?.y ?? 9999) < 900, `y=${done.metricFirstVisibleY?.y}`);
  summary['done-light'] = {
    png: await shot('done-light'),
    viewport: { w: await ev('window.innerWidth'), h: await ev('window.innerHeight') },
    text: {
      ttft: done.ttft,
      metricCards: done.metricCards,
      histRows: done.histRows,
    },
    anchors: {
      metricGoodBar: await ev(`__t.rect('.metric-grid .metric.good')`),
      bestBar: await ev(`(()=>{const r=document.querySelector('.cmp-row.best');const b=r&&r.querySelector('.bar');if(!b)return null;const x=b.getBoundingClientRect();return{x:+x.x.toFixed(1),y:+x.y.toFixed(1),w:+x.width.toFixed(1),h:+x.height.toFixed(1)};})()`),
      bestTrack: await ev(`(()=>{const r=document.querySelector('.cmp-row.best');const t=r&&r.querySelector('.track');if(!t)return null;const x=t.getBoundingClientRect();return{x:+x.x.toFixed(1),y:+x.y.toFixed(1),w:+x.width.toFixed(1),h:+x.height.toFixed(1)};})()`),
      drawer: await ev(`__t.rect('.drawer.open')`),
    },
  };

  // ---------- 多模型对比 ----------
  console.log('\n=== ③ 多模型对比（slow + fast） ===');
  await ev(`__t.clickBtn('改配置', '.drawer')`);
  await waitFor(`__t.vis('.bench-config')`, '配置区出现');
  await ev(`__t.addAlias('fast')`);
  await sleep(150);
  eq('已加入第二个被测模型', await ev(`__t.all('.alias-chip.on').length`), 2);
  await ev(`__t.clickBtn('快速 · 1 轮', '.drawer')`);
  await ev(`__t.clickBtn('开始测试', '.drawer')`);
  await waitFor(`__t.vis('.bench-run')`, '对比开始');
  await waitFor(`__t.vis('.bench-result')`, '对比完成', 60_000);

  const cmp = await ev(`({
    rows: __t.all('.cmp-row').length,
    best: __t.all('.cmp-row.best').length,
    names: __t.all('.cmp-row .name').map(e=>e.textContent.trim()),
    pcts: __t.all('.cmp-row').map(r=>{const b=r.querySelector('.bar');const t=r.querySelector('.track');return b&&t?+(b.getBoundingClientRect().width/t.getBoundingClientRect().width*100).toFixed(1):null;}),
    bestBarColor: (()=>{const b=document.querySelector('.cmp-row.best .bar');return b?getComputedStyle(b).backgroundColor:null;})(),
    focusBtns: __t.all('.bench-result .seg button').map(b=>b.textContent.trim()),
    detailRows: __t.all('.mini-tbl tbody tr').length,
  })`);
  eq('对比：2 行', cmp.rows, 2);
  eq('对比：只有 1 个最优', cmp.best, 1);
  eq('对比：TTFT 升序（fast 在前）', cmp.names[0], 'fast');
  near('对比：最优条 = 轨道 100%', Math.max(...cmp.pcts.filter((x) => x !== null)), 100, 0.5);
  check('对比：非最优条更短', cmp.pcts[1] < cmp.pcts[0], JSON.stringify(cmp.pcts));
  check('对比：最优条用 brand 色', cmp.bestBarColor === 'rgb(14, 159, 110)', cmp.bestBarColor);
  eq('对比：出现模型切换段', cmp.focusBtns.filter((t) => t === 'fast' || t === 'slow').length, 2);
  eq('对比：明细 2 轮', cmp.detailRows, 2);
  summary['compare-light'] = {
    png: await shot('compare-light'),
    viewport: { w: await ev('window.innerWidth'), h: await ev('window.innerHeight') },
    text: { names: cmp.names, pcts: cmp.pcts },
    anchors: {
      bestBar: await ev(`(()=>{const b=document.querySelector('.cmp-row.best .bar');if(!b)return null;const x=b.getBoundingClientRect();return{x:+x.x.toFixed(1),y:+x.y.toFixed(1),w:+x.width.toFixed(1),h:+x.height.toFixed(1)};})()`),
      drawer: await ev(`__t.rect('.drawer.open')`),
    },
  };

  // 关抽屉，回表格看「性能」列是否回填
  await ev(`__t.clickBtn('✕', '.drawer')`);
  await waitFor(`!__t.vis('.drawer.open')`, '抽屉关闭');
  await sleep(600);
  const perf = await ev(`['fast','slow'].map(a=>__t.rowCell(a,5))`);
  check('表格「性能」列回填 TTFT（fast）', /ms|s/.test(perf[0] || ''), perf[0]);
  check('表格「性能」列回填 TTFT（slow）', /ms|s/.test(perf[1] || ''), perf[1]);
  summary['table-after'] = {
    png: await shot('table-after'),
    viewport: { w: await ev('window.innerWidth'), h: await ev('window.innerHeight') },
    perfCells: perf,
    anchors: { body: await ev(`__t.rect('body')`), fastBadge: await ev(`__t.badgeRect('fast',5)`), slowBadge: await ev(`__t.badgeRect('slow',5)`) },
  };

  // ---------- 失败态 ----------
  console.log('\n=== ④ 失败态（mock 401） ===');
  await ev(`__t.rowBtn('fail','测速')`);
  await waitFor(`__t.vis('.drawer.open')`, '抽屉打开');
  await waitFor(`__t.vis('.bench-empty') || __t.vis('.bench-result')`, '内容就绪', 8000);
  await ev(`__t.startAny()`);
  await waitFor(`__t.vis('.bench-result')`, '失败态出现', 60_000);
  await waitFor(`__t.all('.hist .row').length >= 1`, '失败历史回填', 10_000);
  const errState = await ev(`({
    badMetric: __t.vis('.metric.bad'),
    badText: __t.txt('.metric.bad .v'),
    notice: __t.txt('.bench-result .notice'),
    detailStatus: __t.txt('.mini-tbl tbody tr td:last-child'),
    cmpRows: __t.all('.cmp-row').length,
    histRows: __t.all('.hist .row').length,
  })`);
  eq('失败态：显示红色「测试失败」卡', errState.badMetric, true);
  check('失败态：卡片写出错误类别', /apiKey|失败/.test(errState.badText || ''), errState.badText);
  check('失败态：提示条点明失败轮次', /失败/.test(errState.notice || ''), errState.notice);
  check('失败态：明细状态徽标写 apiKey 无效', /apiKey/.test(errState.detailStatus || ''), errState.detailStatus);
  eq('失败态：对比区仍渲染（1 行）', errState.cmpRows, 1);
  eq('失败态：历史记录 1 条（失败也留痕）', errState.histRows, 1);
  summary['error-light'] = {
    png: await shot('error-light'),
    viewport: { w: await ev('window.innerWidth'), h: await ev('window.innerHeight') },
    text: { badText: errState.badText },
    anchors: { metricBadBar: await ev(`__t.rect('.metric.bad')`), drawer: await ev(`__t.rect('.drawer.open')`) },
  };

  // ---------- 缓冲提示 ----------
  console.log('\n=== ⑤ 网关缓冲提示（mock-buffer） ===');
  await ev(`__t.clickBtn('✕', '.drawer')`);
  await waitFor(`!__t.vis('.drawer.open')`, '抽屉关闭');
  await ev(`__t.rowBtn('buffer','测速')`);
  await waitFor(`__t.vis('.drawer.open')`, '抽屉打开');
  await waitFor(`__t.vis('.bench-empty') || __t.vis('.bench-result')`, '内容就绪', 8000);
  await ev(`__t.startAny()`);
  await waitFor(`__t.vis('.bench-result')`, '缓冲测试完成', 60_000);
  const buf = await ev(`({
    warn: __t.vis('.notice.warn'),
    warnText: __t.txt('.notice.warn'),
    verdict: __t.txt('.bench-result .cfg-hint'),
  })`);
  eq('缓冲：出现「疑似被网关缓冲」告警', buf.warn, true);
  check('缓冲：告警文案说明 TPS 虚高', /缓冲/.test(buf.warnText || ''), buf.warnText);
  check('缓冲：结论行也带限定', /缓冲/.test(buf.verdict || ''), buf.verdict);
  summary['buffered-light'] = {
    png: await shot('buffered-light'),
    viewport: { w: await ev('window.innerWidth'), h: await ev('window.innerHeight') },
    text: { warn: buf.warnText },
  };

  // ---------- 深色主题下的完成态 ----------
  console.log('\n=== ⑥ 深色主题（复用历史直接进完成态） ===');
  await ev(`__t.clickBtn('✕', '.drawer')`);
  await waitFor(`!__t.vis('.drawer.open')`, '抽屉关闭');
  await ev(`__t.theme('dark')`);
  await sleep(250);
  await ev(`__t.rowBtn('slow','测速')`);
  await waitFor(`__t.vis('.drawer.open')`, '抽屉打开');
  await waitFor(`__t.vis('.bench-result')`, '历史回填完成态', 10_000);
  const dark = await ev(`({
    state: document.documentElement.dataset.theme,
    metricCards: __t.all('.metric-grid .metric').length,
    cfgbar: __t.vis('.bench-cfgbar'),
    histRows: __t.all('.hist .row').length,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    drawerBg: getComputedStyle(document.querySelector('.drawer.open')).backgroundColor,
    okBar: (()=>{const m=document.querySelector('.metric.good');return m?getComputedStyle(m,'::before').backgroundColor:null;})(),
  })`);
  eq('深色：主题已切换', dark.state, 'dark');
  eq('深色：历史回填后直接是完成态', dark.metricCards, 3);
  eq('深色：配置折叠条在', dark.cfgbar, true);
  check('深色：历史有记录', dark.histRows >= 1, `rows=${dark.histRows}`);
  eq('深色：指标卡状态条 = --ok #34d399', dark.okBar, 'rgb(52, 211, 153)');
  summary['done-dark'] = {
    png: await shot('done-dark'),
    viewport: { w: await ev('window.innerWidth'), h: await ev('window.innerHeight') },
    text: { metricCards: dark.metricCards },
    anchors: {
      metricGoodBar: await ev(`__t.rect('.metric-grid .metric.good')`),
      drawer: await ev(`__t.rect('.drawer.open')`),
    },
  };

  check('全流程无 console.error / 未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  summary.pageErrors = pageErrors;
}

/* ---------------- 收尾 ---------------- */
try {
  await main();
} catch (e) {
  check('流程异常', false, String(e && e.stack ? e.stack.split('\n')[0] : e));
  console.error(e);
} finally {
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  const failed = results.filter((r) => !r.ok).length;
  failCount = failed;
  console.log(`\nDOM 断言：${results.length} 条，失败 ${failed} 条`);
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  if (serverProc) {
    try {
      spawn('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }
  await sleep(400);
  process.exit(failed === 0 ? 0 : 1);
}
