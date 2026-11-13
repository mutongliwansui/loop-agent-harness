/**
 * 需求 20261113-002 D6 单测：存量幽灵空间识别与告警（**只读**）
 *
 * 覆盖任务文档 6.3 清单：
 * - 判据①：仅 meta.json（或 + 空 sessions.json）才判幽灵
 * - 判据②：出现任何非元数据项（sess_* 会话体 / runs/ 目录 / 散落文件）一律不判
 * - 判据③：meta.json 缺 workspacePath（孤儿）或损坏 → 不判
 * - 告警：有幽灵才写日志；无幽灵零落盘；日志追加、超限重写
 * - 安全边界：扫描与告警全程不删除、不改名任何文件
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanGhostWorkspaces, reportGhostWorkspaces } from '../src/api/ghost-workspaces.js';

const TMP_ROOT = join(tmpdir(), 'loop-agent-tests', 'test-ghost-ws');

let dirSeq = 0;
function freshDir(): string {
  return join(TMP_ROOT, `${Date.now()}-${dirSeq++}`);
}

/** 在 userDir 下造一个空间存储目录，写入给定文件（内容为字符串或 JSON 对象） */
function makeWs(
  userDir: string,
  wsId: string,
  files: Record<string, unknown> = {},
  dirs: string[] = [],
): string {
  const wsDir = join(userDir, 'sessions', wsId);
  mkdirSync(wsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    writeFileSync(join(wsDir, name), body, 'utf-8');
  }
  for (const d of dirs) mkdirSync(join(wsDir, d), { recursive: true });
  return wsDir;
}

/** 标准 meta.json 内容 */
function meta(workspacePath = '/real/space'): Record<string, unknown> {
  return {
    workspacePath,
    workspaceName: 'space',
    createdAt: '2026-11-01T00:00:00.000Z',
    lastAccessedAt: '2026-11-01T00:00:00.000Z',
  };
}

const GHOST_ID = '776e97820388b15d';
const REAL_ID = '522b6010f5ea7e0b';

describe('scanGhostWorkspaces（D6：只读识别存量幽灵）', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = freshDir();
    mkdirSync(join(userDir, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('仅含 meta.json 的目录被判幽灵，并带出 workspacePath 与理由', async () => {
    makeWs(userDir, GHOST_ID, { 'meta.json': meta('C:\\Users\\muton') });

    const ghosts = await scanGhostWorkspaces(userDir);

    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].wsId).toBe(GHOST_ID);
    expect(ghosts[0].workspacePath).toBe('C:\\Users\\muton');
    expect(ghosts[0].reason).toContain('仅含 meta.json');
  });

  it('meta.json + 空 sessions.json 仍判幽灵（理由区分两种形态）', async () => {
    makeWs(userDir, GHOST_ID, { 'meta.json': meta(), 'sessions.json': [] });

    const ghosts = await scanGhostWorkspaces(userDir);

    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].reason).toContain('空 sessions.json');
  });

  it('meta.json + 非空 sessions.json 不判幽灵（索引里记着会话）', async () => {
    makeWs(userDir, REAL_ID, {
      'meta.json': meta(),
      'sessions.json': [{ id: 'sess_x', createdAt: '2026-11-01T00:00:00.000Z' }],
    });

    expect(await scanGhostWorkspaces(userDir)).toEqual([]);
  });

  it('存在 sess_* 会话体文件则不判幽灵（.json 与 .enc 都算）', async () => {
    makeWs(userDir, REAL_ID, {
      'meta.json': meta(),
      'sess_522b6010_20261113_094254.json': { id: 'x', messages: [] },
    });
    makeWs(userDir, 'other1234567890', {
      'meta.json': meta('/other'),
      'sess_other_20261113_100000.enc': 'ciphertext',
    });

    expect(await scanGhostWorkspaces(userDir)).toEqual([]);
  });

  it('存在 runs/ 子目录则不判幽灵（有真实活动痕迹，偏保守）', async () => {
    makeWs(userDir, REAL_ID, { 'meta.json': meta() }, ['runs']);

    expect(await scanGhostWorkspaces(userDir)).toEqual([]);
  });

  it('存在其它散落文件也不判幽灵（判据优先「看见就放过」）', async () => {
    makeWs(userDir, REAL_ID, { 'meta.json': meta(), 'notes.txt': 'hi' });

    expect(await scanGhostWorkspaces(userDir)).toEqual([]);
  });

  it('meta.json 缺 workspacePath 的孤儿目录不处理（无从给出可读告警）', async () => {
    makeWs(userDir, 'orphan0000000000', {
      'meta.json': { workspaceName: 'x', createdAt: '2026-11-01T00:00:00.000Z' },
    });

    expect(await scanGhostWorkspaces(userDir)).toEqual([]);
  });

  it('meta.json 损坏（非法 JSON）不判幽灵', async () => {
    makeWs(userDir, 'broken0000000000', { 'meta.json': '{not json' });

    expect(await scanGhostWorkspaces(userDir)).toEqual([]);
  });

  it('sessions 根目录不存在时返回空数组（全新环境）', async () => {
    const empty = freshDir();
    mkdirSync(empty, { recursive: true });
    try {
      expect(await scanGhostWorkspaces(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('混合场景：只挑出幽灵，真实空间与孤儿均不受影响', async () => {
    makeWs(userDir, GHOST_ID, { 'meta.json': meta('C:\\Users\\muton') });
    makeWs(userDir, REAL_ID, {
      'meta.json': meta('D:\\trae_workspace\\loop-agent-command'),
      'sessions.json': [{ id: 'sess_a' }],
      'sess_522b6010_20261113_094254.json': { id: 'sess_a', messages: [] },
    });
    makeWs(userDir, 'orphan0000000000', { 'meta.json': { workspaceName: 'x' } });

    const ghosts = await scanGhostWorkspaces(userDir);

    expect(ghosts.map((g) => g.wsId)).toEqual([GHOST_ID]);
  });

  it('只读保证：扫描前后目录内容与 mtime 完全不变', async () => {
    const wsDir = makeWs(userDir, GHOST_ID, { 'meta.json': meta() });
    const before = readdirSync(wsDir).sort();
    const beforeMtime = statSync(join(wsDir, 'meta.json')).mtimeMs;

    await scanGhostWorkspaces(userDir);

    expect(readdirSync(wsDir).sort()).toEqual(before);
    expect(statSync(join(wsDir, 'meta.json')).mtimeMs).toBe(beforeMtime);
    expect(existsSync(wsDir)).toBe(true); // 绝不删除
  });
});

describe('reportGhostWorkspaces（D6：启动期告警）', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = freshDir();
    mkdirSync(join(userDir, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  it('无幽灵时静默：不打印、不创建日志文件（保持启动零落盘）', async () => {
    const lines: string[] = [];

    const ghosts = await reportGhostWorkspaces(userDir, (m) => lines.push(m));

    expect(ghosts).toEqual([]);
    expect(lines).toEqual([]);
    expect(existsSync(join(userDir, 'ghost-workspaces.log'))).toBe(false);
  });

  it('有幽灵时打印告警并写日志，日志含数量与每条的 wsId/路径', async () => {
    makeWs(userDir, GHOST_ID, { 'meta.json': meta('C:\\Users\\muton') });
    const lines: string[] = [];

    const ghosts = await reportGhostWorkspaces(userDir, (m) => lines.push(m));

    expect(ghosts).toHaveLength(1);
    expect(lines.join('\n')).toContain('存量幽灵空间 1 个');
    expect(lines.join('\n')).toContain('不清理');
    expect(lines.join('\n')).toContain(GHOST_ID);
    expect(lines.join('\n')).toContain('C:\\Users\\muton');
    expect(lines.join('\n')).toContain('ghost-workspaces.log');

    const logged = JSON.parse(readFileSync(join(userDir, 'ghost-workspaces.log'), 'utf-8').trim());
    expect(logged.count).toBe(1);
    expect(logged.ghosts[0].wsId).toBe(GHOST_ID);
    expect(typeof logged.ts).toBe('string');
  });

  it('多次启动追加日志（每次一行），不覆盖历史', async () => {
    makeWs(userDir, GHOST_ID, { 'meta.json': meta() });

    await reportGhostWorkspaces(userDir, () => {});
    await reportGhostWorkspaces(userDir, () => {});

    const rows = readFileSync(join(userDir, 'ghost-workspaces.log'), 'utf-8')
      .trim()
      .split('\n');
    expect(rows).toHaveLength(2);
  });

  it('日志超过上限时重写而非无限增长（只留本次一行）', async () => {
    makeWs(userDir, GHOST_ID, { 'meta.json': meta() });
    const logFile = join(userDir, 'ghost-workspaces.log');
    writeFileSync(logFile, 'x'.repeat(256 * 1024), 'utf-8'); // 已达上限

    await reportGhostWorkspaces(userDir, () => {});

    const content = readFileSync(logFile, 'utf-8');
    expect(content.split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(content.trim()).count).toBe(1);
    expect(statSync(logFile).size).toBeLessThan(64 * 1024);
  });

  it('告警全程不删除任何文件（只读 + 追加日志）', async () => {
    const wsDir = makeWs(userDir, GHOST_ID, { 'meta.json': meta() });
    const before = readdirSync(wsDir).sort();

    await reportGhostWorkspaces(userDir, () => {});

    expect(readdirSync(wsDir).sort()).toEqual(before);
    expect(existsSync(join(wsDir, 'meta.json'))).toBe(true);
  });
});
