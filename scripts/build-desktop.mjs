#!/usr/bin/env node
/**
 * 桌面端打包构建脚本（任务 20261112-007-04 / D4-7）。
 *
 * 为什么用脚本而不是 npm 链式 `&&`：
 *   1. Windows 下 npm script 的 `&&` 与 sh/cmd 语义差异大，任一环节报错不易定位；
 *   2. 需要在阶段之间做**产物校验**（尤其 SEA 是否内嵌 WebUI），`&&` 做不到条件拦截；
 *   3. 需要打印阶段耗时与最终产物路径/体积，便于交付时核对。
 *
 * 为什么必须强校验「SEA 已内嵌 WebUI」（本脚本最关键的一步）：
 *   安装后布局是 resources/loop-agent-core.exe，**没有 webui/dist 目录**，
 *   而 src/api/static.ts 的解析顺序是「显式 webRoot → 磁盘探测 → SEA 内嵌兜底」。
 *   磁盘探测必然落空，唯一可用来源就是内嵌资源；一旦未内嵌，结果是
 *   「构建成功、安装成功、双击白屏」——最难排查的一种故障。
 *   而 scripts/build-sea.mjs:72-73 在缺 webui/dist 时**只打印一行提示、不报错不阻断**，
 *   所以这里必须自己拦：以 build:sea 的日志作为判据，未出现「内嵌 WebUI 资源」即失败。
 *
 * 阶段：build:webui → build:sea → 校验内嵌 → 构建壳(tsup) → 校验资源 → electron-builder
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DESKTOP = join(ROOT, 'desktop');
const DIST_SEA = join(ROOT, 'dist-sea');
const WEBUI_DIST = join(ROOT, 'webui', 'dist');
const OUT = join(ROOT, 'dist-desktop');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// electron-builder 默认从 GitHub 下载 electron / winCodeSign / nsis 二进制。
// 在国内网络下这一步经常 600s 超时（RequestError: Timeout awaiting 'request'），
// 且失败发生在「下载进度 100%」之后，很容易误判成本地打包问题。
// 这里默认切到 npmmirror 镜像；需要走官方源时用环境变量显式覆盖。
if (!process.env.ELECTRON_MIRROR) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
}
if (!process.env.ELECTRON_BUILDER_BINARIES_MIRROR) {
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR =
    'https://npmmirror.com/mirrors/electron-builder-binaries/';
}

/** 阶段计时，末尾汇总 */
const timings = [];
function stage(name) {
  const started = Date.now();
  console.log(`\n[build:desktop] ▶ ${name}`);
  return {
    done(extra = '') {
      const ms = Date.now() - started;
      timings.push({ name, ms });
      console.log(`[build:desktop] ✔ ${name} 完成${extra ? `（${extra}）` : ''} 用时 ${(ms / 1000).toFixed(1)}s`);
    },
  };
}

function fail(title, hints = []) {
  console.error(`\n[build:desktop] ✘ ${title}`);
  for (const h of hints) console.error(`  · ${h}`);
  process.exit(1);
}

/**
 * 跑子命令并**捕获输出**（用于校验），同时回显给用户。
 *
 * 不能直接 stdio:'inherit'：内嵌校验要读 build:sea 的输出判断是否内嵌成功。
 */
function runCapture(cmd, args, cwd, label) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8', shell: process.platform === 'win32' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(out);
  if (r.status !== 0) {
    fail(`${label} 失败（退出码 ${r.status ?? 'null'}）`, ['请查看上方输出定位原因']);
  }
  return out;
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ─── 阶段 0：前置检查 ───────────────────────────────────────────────
console.log('[build:desktop] 桌面端打包（NSIS 安装包 + portable 兜底）');
console.log(`[build:desktop] 仓库根：${ROOT}`);

for (const f of ['desktop/package.json', 'desktop/assets/icon.png']) {
  if (!existsSync(join(ROOT, f))) fail(`缺少必需文件：${f}`);
}

// ─── 阶段 1：构建 WebUI ─────────────────────────────────────────────
{
  const s = stage('构建 WebUI（npm run build:webui）');
  runCapture(NPM, ['run', 'build:webui'], ROOT, 'WebUI 构建');
  if (!existsSync(join(WEBUI_DIST, 'index.html'))) fail('WebUI 构建完成但缺少 index.html');
  s.done(`${readdirSync(WEBUI_DIST).length} 个顶层条目`);
}

// ─── 阶段 2：构建 SEA 单文件后端 ────────────────────────────────────
let seaLog = '';
{
  const s = stage('构建 SEA 单文件后端（npm run build:sea）');
  seaLog = runCapture(NPM, ['run', 'build:sea'], ROOT, 'SEA 构建');
  if (!existsSync(join(DIST_SEA, 'loop-agent.exe'))) fail('SEA 构建完成但缺少 dist-sea/loop-agent.exe');
  s.done(`体积 ${mb(statSync(join(DIST_SEA, 'loop-agent.exe')).size)}`);
}

// ─── 阶段 3：强校验 SEA 已内嵌 WebUI（D4-7 核心增值）─────────────────
{
  console.log('\n[build:desktop] ▶ 校验 SEA 内嵌 WebUI');
  // build-sea.mjs 成功内嵌时打印「内嵌 WebUI 资源: N 个文件」；
  // 未内嵌时打印「webui/dist 不存在，跳过前端内嵌（纯后端 exe）」。
  const embedded = /内嵌 WebUI 资源:\s*(\d+)\s*个文件/.exec(seaLog);
  if (!embedded || Number(embedded[1]) <= 0) {
    fail('SEA 产物未内嵌 WebUI，禁止继续打包', [
      '原因：安装后布局 resources/ 下没有 webui/dist，只能依赖 SEA 内嵌资源；',
      '      未内嵌会导致「构建成功、安装成功、双击白屏」，故此处强制失败。',
      '       判据：build:sea 输出中未出现「内嵌 WebUI 资源: N 个文件」。',
      '',
      '排查建议：',
      '  1) 确认 webui/dist/index.html 存在（本脚本阶段 1 已构建，若缺失说明前端构建异常）；',
      '  2) 查看上方 build:sea 输出是否有「webui/dist 不存在，跳过前端内嵌」提示；',
      '  3) 单独执行 npm run build:sea 复查该行输出。',
    ]);
  }
  console.log(`[build:desktop] ✔ 已内嵌 WebUI 资源：${embedded[1]} 个文件`);
}

// ─── 阶段 4：构建壳（tsup）──────────────────────────────────────────
{
  const s = stage('构建桌面壳（desktop 下 npm run build）');
  runCapture(NPM, ['run', 'build'], DESKTOP, '壳构建');
  if (!existsSync(join(DESKTOP, 'dist', 'main.cjs'))) fail('壳构建完成但缺少 desktop/dist/main.cjs');
  s.done();
}

// ─── 阶段 5：准备打包资源 ───────────────────────────────────────────
{
  const s = stage('准备打包资源');
  // electron-builder 的 extraResources 从 desktop/ 相对定位，见 desktop/package.json 的 build 字段
  const resDir = join(DESKTOP, 'resources');
  rmSync(resDir, { recursive: true, force: true });
  mkdirSync(resDir, { recursive: true });
  // 重命名为 loop-agent-core.exe：让「壳」与「后端」在安装目录里一眼可辨（D4-3）。
  // SEA 资源内嵌不依赖自身文件名，重命名安全（已于任务 04 真机实测确认）。
  copyFileSync(join(DIST_SEA, 'loop-agent.exe'), join(resDir, 'loop-agent-core.exe'));
  console.log(`[build:desktop]   后端 → desktop/resources/loop-agent-core.exe（${mb(statSync(join(resDir, 'loop-agent-core.exe')).size)}）`);
  s.done();
}

// ─── 阶段 6：electron-builder 打包 ──────────────────────────────────
{
  const s = stage('electron-builder 打包（nsis + portable）');
  rmSync(OUT, { recursive: true, force: true });
  runCapture(
    NPM,
    ['exec', '--', 'electron-builder', '--win', '--x64', '--publish', 'never'],
    DESKTOP,
    'electron-builder 打包',
  );
  s.done();
}

// ─── 汇总 ──────────────────────────────────────────────────────────
console.log('\n[build:desktop] ══════ 构建完成 ══════');
for (const t of timings) {
  console.log(`  ${t.name.padEnd(40, ' ')} ${(t.ms / 1000).toFixed(1)}s`);
}

if (!existsSync(OUT)) fail('打包完成但未找到 dist-desktop 目录');
const artifacts = readdirSync(OUT)
  .filter((n) => n.endsWith('.exe'))
  .map((n) => ({ name: n, size: statSync(join(OUT, n)).size }));

console.log(`\n[build:desktop] 产物目录：${relative(ROOT, OUT)}`);
for (const a of artifacts) {
  console.log(`  · ${a.name}  (${mb(a.size)})`);
}
if (artifacts.length === 0) fail('dist-desktop 内没有任何 exe 产物');

// 交付物自检：安装包与便携版都必须存在（两者共用同一壳产物，D4-2）
const hasSetup = artifacts.some((a) => /Setup/i.test(a.name));
const hasPortable = artifacts.some((a) => !/Setup/i.test(a.name));
if (!hasSetup) console.warn('[build:desktop] ⚠ 未产出安装包（名称含 Setup 的 exe），请检查 nsis 配置');
if (!hasPortable) console.warn('[build:desktop] ⚠ 未产出便携版（不含 Setup 的 exe），请检查 portable 目标');

// 记录体积供文档回填
console.log('\n[build:desktop] 体积记录：');
console.log(`  安装包/便携版：见上方清单`);
for (const a of artifacts) console.log(`  ${a.name}: ${a.size} 字节`);
