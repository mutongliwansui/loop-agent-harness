#!/usr/bin/env node
/**
 * 工作空间解耦静态断言 + 存量会话核对（Task-20261021-010-06 P0）
 *
 * 覆盖方案 3.1 / 3.4：
 * - A4-1 `process.chdir` 在 src/ 下零出现
 * - A4-2 `process.cwd()` 命中项全部落在白名单（与 tests/no-chdir.test.ts 同一份口径）
 * - A7.1 `git diff --stat -- src/cli src/commands` 为空（工作区 + 本批次基线两次比对）
 * - A5-1 同一目录的三种书写形式 → 同一 workspaceId
 * - A5-2 存量 `<userDir>/sessions/<旧id>/meta.json` 反算 canonical → 新 workspaceId 核对
 *        （不一致只告警，不迁移——风险 R2 约定）
 *
 * 用法（需 tsx 以加载 src 下的 TS 模块，零新依赖）：
 *   node --import tsx scripts/verify-workspace-decoupling.mjs
 *   node --import tsx scripts/verify-workspace-decoupling.mjs --base 8095c5e --user-dir C:\Users\me\.loop-agent
 *
 * 退出码：0 = 全部硬断言通过（存量不一致仅为告警）；1 = 有硬断言失败。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { canonicalWorkspacePath } from '../src/session/path-utils.ts';
import { workspaceId } from '../src/session/store.ts';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');

/** CLI 零改动红线覆盖的目录（A7.1） */
const CLI_PATHS = ['src/cli', 'src/commands'];

const results = [];

function record(code, title, ok, detail) {
  results.push({ code, title, ok, detail });
}

function parseArgs(argv) {
  const get = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { base: get('--base'), userDir: get('--user-dir') };
}

/** 递归收集 src/ 下所有 .ts 文件 */
function walkTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const relOf = (file) => relative(SRC, file).split(sep).join('/');

/**
 * 允许保留 process.cwd() 的文件（相对 src/，POSIX 分隔符）。
 * 口径与 tests/no-chdir.test.ts 的 CWD_ALLOWLIST 保持一致，改动需两处同步。
 */
const CWD_ALLOWLIST = new Set([
  // 应用自身资源（与工作空间无关）
  'api/static.ts', // webui 构建产物定位
  'config/loader.ts', // .env 读取 + 构造默认
  'config/writer.ts', // 构造默认
  // 共享默认值（CLI 单空间 = 启动目录；serve 侧被 runtime 显式覆盖）
  'session/store.ts',
  'runtime/init.ts',
  'bootstrap/doctor.ts',
  'tools/runner.ts',
  'tools/workspace-fs.ts',
  'agent/react-agent.ts',
  'api/bootstrap.ts', // 启动目录即初始空间
  'config/mcp-manager.ts', // MCP stdio cwd：配置值 ?? 启动目录（D19）
  // CLI 单空间红线（D11：src/cli/**、src/commands/** 零 diff，保留）
  'cli/start.ts',
  'commands/skill-command.ts',
  'commands/session-command.ts',
]);

/** 仅统计"代码行"里的 process.cwd()（行注释/块注释/文档注释不算），与单测口径一致 */
function hasCwdCode(file) {
  let inBlock = false;
  for (const raw of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    if (line.includes('process.cwd()')) return true;
  }
  return false;
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
}

/** 本批次基线：最早提及需求编号 20261021-010 的提交（docs 拆分提交），回退 HEAD */
function deriveBase() {
  try {
    const first = git(['rev-list', '--reverse', '--grep=20261021-010', 'HEAD'])
      .split(/\r?\n/)
      .filter(Boolean)[0];
    return first ? `${first}~1` : 'HEAD';
  } catch {
    return 'HEAD';
  }
}

function checkChdir(files) {
  const offenders = files
    .filter((f) => readFileSync(f, 'utf-8').includes('process.chdir('))
    .map(relOf);
  record('A4-1', 'process.chdir 全仓零出现', offenders.length === 0,
    offenders.length === 0 ? `0 命中（扫描 ${files.length} 个 .ts）` : offenders.join(', '));
}

function checkCwdAllowlist(files) {
  const users = files.filter(hasCwdCode).map(relOf).sort();
  const unexpected = users.filter((f) => !CWD_ALLOWLIST.has(f));
  const stale = [...CWD_ALLOWLIST].filter((f) => !users.includes(f));
  record('A4-2', 'process.cwd() 命中项全部在白名单', unexpected.length === 0,
    unexpected.length === 0
      ? `${users.length} 个文件命中，全部已分类${stale.length ? `（白名单中已无命中的条目：${stale.join(', ')}）` : ''}`
      : `未分类：${unexpected.join(', ')}`);
}

function checkCliDiff(base) {
  const worktree = git(['diff', '--stat', 'HEAD', '--', ...CLI_PATHS]);
  const sinceBase = base === 'HEAD' ? '' : git(['diff', '--stat', base, '--', ...CLI_PATHS]);
  const ok = worktree === '' && sinceBase === '';
  const parts = [];
  parts.push(`工作区 vs HEAD：${worktree === '' ? '空' : worktree.replace(/\n/g, ' | ')}`);
  if (base !== 'HEAD') parts.push(`基线 ${base}：${sinceBase === '' ? '空' : sinceBase.replace(/\n/g, ' | ')}`);
  record('A7.1', 'CLI/commands 代码零改动', ok, parts.join('；'));
}

async function checkPathForms() {
  const dir = REPO_ROOT;
  const forms = [dir, `${dir}${sep}`];
  if (process.platform === 'win32') {
    forms.push(dir.toUpperCase(), dir.replace(/\\/g, '/'));
  } else {
    forms.push(`${dir}/./`);
  }
  const canon = [];
  for (const f of forms) canon.push(await canonicalWorkspacePath(f));
  const ids = canon.map((c) => workspaceId(c));
  const ok = ids.every((id) => id === ids[0]) && canon.every((c) => c === canon[0]);
  record('A5-1', '同一目录多种书写 → 同一 workspaceId', ok,
    ok ? `${forms.length} 种书写 → ${ids[0]}（canonical=${canon[0]}）`
      : forms.map((f, i) => `${f} → ${canon[i]} / ${ids[i]}`).join(' ｜ '));
}

/** A5-2 存量核对：目录名（旧 workspaceId） vs meta.json 反算的新 id，不一致只告警 */
async function checkExistingWorkspaces(userDir) {
  const sessionsRoot = join(userDir, 'sessions');
  if (!existsSync(sessionsRoot)) {
    record('A5-2', '存量会话目录核对', true, `跳过：${sessionsRoot} 不存在`);
    return;
  }
  const dirs = readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (dirs.length === 0) {
    record('A5-2', '存量会话目录核对', true, `跳过：${sessionsRoot} 下无空间目录`);
    return;
  }
  const mismatched = [];
  let skipped = 0;
  for (const d of dirs) {
    const metaFile = join(sessionsRoot, d.name, 'meta.json');
    let meta;
    try {
      meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
    } catch {
      skipped += 1; // meta.json 缺失/损坏：无路径信息，无法反算
      continue;
    }
    if (!meta || typeof meta.workspacePath !== 'string' || !meta.workspacePath) {
      skipped += 1;
      continue;
    }
    const canonical = await canonicalWorkspacePath(meta.workspacePath);
    const expect = workspaceId(canonical);
    if (expect !== d.name) mismatched.push(`目录 ${d.name} ≠ 反算 ${expect}（path=${meta.workspacePath}）`);
  }
  const detail = `${dirs.length} 个空间目录，不一致 ${mismatched.length}，无 meta ${skipped}`;
  if (mismatched.length > 0) {
    record('A5-2', '存量会话目录核对（仅告警，不迁移）', true,
      `${detail}\n    - ${mismatched.join('\n    - ')}`);
  } else {
    record('A5-2', '存量会话目录核对', true, detail);
  }
}

async function main() {
  const { base: baseArg, userDir: userDirArg } = parseArgs(process.argv.slice(2));
  const base = baseArg ?? deriveBase();
  const userDir = userDirArg ?? join(homedir(), '.loop-agent');

  const files = walkTs(SRC);

  checkChdir(files);
  checkCwdAllowlist(files);
  checkCliDiff(base);
  await checkPathForms();
  await checkExistingWorkspaces(userDir);

  console.log('\n工作空间解耦断言（Task-20261021-010-06）');
  console.log(`仓库：${REPO_ROOT}`);
  console.log(`userDir：${userDir}\n`);
  for (const r of results) {
    console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.code} ${r.title} —— ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(`[FAIL] 断言脚本异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
});
