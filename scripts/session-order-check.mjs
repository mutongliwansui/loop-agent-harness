#!/usr/bin/env node
/**
 * 存量会话「消息顺序」诊断脚本（需求 20261029-003 / D4，需求 20261113-008 补充说明）
 *
 * 背景：L1 压缩历史上出现过落盘顺序缺陷——保留区收缩时，当前轮 user 会被「任务锚点 pin」
 * 抽出插到保留区头部，落盘后表现为「一整轮应答在前、提问在后」（首修在存储侧落盘轨迹，
 * 需求 20261113-008 进一步删除了 `src/memory/working.ts` 里的 pin 本身，并新增写盘前
 * msgId 单调性告警）。本脚本用于**只读诊断**已落盘会话，帮助判断哪些存量会话受影响。
 *
 * 为什么不做自动修复（诚实说明）：
 *   - 原始轨迹 `transcript` 从未落盘，多轮压缩反复重建后，历史顺序**无法无损还原**；
 *   - `is_compact` 只能区分「折叠 / 保留」，无法区分「修复前的 pin anchor」与「正常轮次的
 *     user」——两者在标记层面同构。任何自动重排都只能靠猜测，风险高于收益。
 *   故本脚本只输出启发式可疑项供人工判断，**永不写文件**。
 *
 * 用法：
 *   node scripts/session-order-check.mjs                  # 诊断默认目录 ~/.loop-agent/sessions
 *   node scripts/session-order-check.mjs --dir=<路径>      # 指定 sessions 根目录
 *   node scripts/session-order-check.mjs --json           # 机器可读输出
 *   node scripts/session-order-check.mjs --limit=50       # 只列前 N 个可疑会话（默认 20）
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const dirArg = argv.find((a) => a.startsWith('--dir='));
const limitArg = argv.find((a) => a.startsWith('--limit='));
const root = dirArg ? dirArg.slice('--dir='.length) : join(homedir(), '.loop-agent', 'sessions');
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) || 20 : 20;

/** 摘要占位：kind='summary' 或 is_show=false 的 user 消息（与 src/memory/summary-message.ts 同构） */
function isSummary(m) {
  return m && m.role === 'user' && (m.kind === 'summary' || m.is_show === false);
}

/**
 * 统计单会话：数量分布 + 启发式可疑项。
 *
 * 判据 A（结构硬错误）：普通 user 之后紧跟的消息 role 为 'tool' —— 正常轨迹中 user 之后
 *   必然是 assistant（可能是带 tool_calls 的），紧跟 tool 说明顺序被打乱。
 * 判据 B（pin 锚点形态）：普通 user 且 is_compact!==true，前一条非摘要消息已折叠、
 *   后一条非摘要消息未折叠 —— 对应「保留段被拼到归档段之后」的错位形态。
 *   修复后的正确形态里，被 pin 的 user 后面紧跟的正是那批折叠消息，故不命中。
 *
 * 注意：若某轮 user 及其后续消息在后续压缩中**全部**折叠为 is_compact=true，
 * 标记层面与正常历史不可区分（真实会话 sess_522b6010_20261029_162540 即此种情形），
 * 此时任何启发式都无法检出——故输出中的 0 可疑**不代表**未受影响。
 */
function analyze(messages) {
  const list = messages.filter((m) => m && typeof m.role === 'string');
  const body = list.filter((m) => m.role !== 'system');
  let archive = 0;
  let recent = 0;
  let summary = 0;
  for (const m of body) {
    if (isSummary(m)) summary++;
    else if (m.is_compact === true) archive++;
    else recent++;
  }

  const suspicious = [];
  const nonSummary = body.filter((m) => !isSummary(m));
  for (let i = 0; i < nonSummary.length; i++) {
    const m = nonSummary[i];
    if (m.role !== 'user') continue;
    const prev = nonSummary[i - 1];
    const next = nonSummary[i + 1];

    if (next && next.role === 'tool') {
      suspicious.push({
        rule: 'A',
        index: list.indexOf(m),
        preview: String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 40),
        detail: 'user 之后紧跟 tool（应为 assistant）',
      });
      continue;
    }
    if (
      m.is_compact !== true &&
      prev &&
      prev.is_compact === true &&
      !(next && next.is_compact === true)
    ) {
      suspicious.push({
        rule: 'B',
        index: list.indexOf(m),
        preview: String(m.content ?? '').replace(/\s+/g, ' ').slice(0, 40),
        detail: `前一条已折叠、下一条未折叠（下一条 role=${next ? next.role : '无'}），疑似被 pin 的保留锚点`,
      });
    }
  }

  return {
    total: list.length,
    archive,
    recent,
    summary,
    suspicious,
    userCount: body.filter((m) => m.role === 'user' && !isSummary(m)).length,
  };
}

async function listSessionFiles(base) {
  const out = [];
  let wsDirs = [];
  try {
    wsDirs = await readdir(base, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of wsDirs) {
    if (!d.isDirectory()) continue;
    const dir = join(base, d.name);
    let files = [];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.json') && f.startsWith('sess_')) out.push(join(dir, f));
    }
  }
  return out;
}

async function main() {
  const files = await listSessionFiles(root);
  const results = [];
  let encrypted = 0;

  for (const path of files) {
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // 加密会话（store 启用加密时整文件不可离线解析）
      encrypted++;
      continue;
    }
    const messages = Array.isArray(data.messages) ? data.messages : [];
    if (messages.length === 0) continue;
    const stat = analyze(messages);
    if (stat.suspicious.length > 0) {
      results.push({ file: path, id: data.id ?? '', updatedAt: data.updatedAt ?? '', ...stat });
    }
  }

  results.sort((a, b) => b.suspicious.length - a.suspicious.length);

  if (wantJson) {
    console.log(JSON.stringify({ root, scanned: files.length, encrypted, suspicious: results }, null, 2));
    return;
  }

  console.log(`会话顺序诊断（只读）`);
  console.log(`目录：${root}`);
  console.log(`扫描会话：${files.length} 个，加密跳过：${encrypted} 个`);
  console.log(`可疑会话：${results.length} 个（启发式判据，仅供参考，不作自动修复依据）`);
  if (results.length > 0) {
    console.log('');
    for (const r of results.slice(0, limit)) {
      console.log(`■ ${r.id || r.file}`);
      console.log(
        `  总 ${r.total} 条 · user ${r.userCount} · 归档 ${r.archive} · 保留 ${r.recent} · 摘要 ${r.summary}`,
      );
      for (const s of r.suspicious.slice(0, 5)) {
        console.log(`  ! [${s.rule}] #${s.index} ${s.detail}：${s.preview}`);
      }
      if (r.suspicious.length > 5) console.log(`  … 另有 ${r.suspicious.length - 5} 处`);
    }
    if (results.length > limit) console.log(`\n（仅显示前 ${limit} 个，可用 --limit 调整）`);
  }
  console.log('');
  console.log('注意：0 可疑不代表未受影响——若某轮 user 及其后续消息在后续压缩中已全部折叠');
  console.log('      （is_compact=true），标记层面与正常历史不可区分，启发式无法检出。');
  console.log(
    '说明：本脚本不修改任何文件。原始轨迹未落盘，存量顺序无法无损还原；' +
      '修复自本版本起对新写入生效，历史错乱如需纠正建议新建会话继续。',
  );
}

main().catch((err) => {
  console.error('诊断失败：', err?.message ?? err);
  process.exit(1);
});
