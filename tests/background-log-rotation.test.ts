// 后台任务日志轮转/清理单测（需求 20261104-003）
// - 真实临时目录 + utimesSync 造 mtime，验证天数/总量双口径
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, truncateSync, utimesSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BackgroundTaskRegistry,
  setRunsDirForTest,
  configureBackgroundLogPrune,
} from '../src/tools/background-tasks.js';

const DAY = 24 * 60 * 60 * 1000;

describe('BackgroundTaskRegistry.pruneRuns：日志按天数/总量清理', () => {
  let dir: string;
  let reg: BackgroundTaskRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lagent-prune-'));
    setRunsDirForTest(dir);
    configureBackgroundLogPrune({ enabled: true, retentionDays: 7, maxTotalMb: 100 });
    reg = new BackgroundTaskRegistry();
  });

  afterEach(() => {
    setRunsDirForTest(undefined);
    configureBackgroundLogPrune({ enabled: true, retentionDays: 7, maxTotalMb: 100 });
    rmSync(dir, { recursive: true, force: true });
  });

  const touch = (name: string, content: string, ageMs: number): string => {
    const p = join(dir, name);
    writeFileSync(p, content);
    const t = new Date(Date.now() - ageMs);
    utimesSync(p, t, t);
    return p;
  };

  it('按天数：过期 .json + .log 成对删除，近期任务保留', () => {
    const oldJson = touch('bg_old_1.json', '{"taskId":"bg_old_1"}', 30 * DAY);
    const oldLog = touch('bg_old_1.log', 'old output', 30 * DAY);
    const newJson = touch('bg_new_2.json', '{"taskId":"bg_new_2"}', 0);
    const newLog = touch('bg_new_2.log', 'new output', 0);

    const r = reg.pruneRuns({ retentionDays: 7, maxTotalMb: 1000 });

    expect(existsSync(oldJson)).toBe(false);
    expect(existsSync(oldLog)).toBe(false);
    expect(existsSync(newJson)).toBe(true);
    expect(existsSync(newLog)).toBe(true);
    expect(r.removedTasks).toBe(1);
    expect(r.removedLogs).toBe(1);
    expect(r.freedBytes).toBeGreaterThan(0);
  });

  it('按天数：无主 .log（无 .json）超过保留期删除，近期无主日志保留', () => {
    const oldOrphan = touch('bg_gone_3.log', 'orphan', 30 * DAY);
    const newOrphan = touch('bg_gone_4.log', 'orphan-new', 0);

    const r = reg.pruneRuns({ retentionDays: 7, maxTotalMb: 1000 });

    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(newOrphan)).toBe(true);
    expect(r.removedLogs).toBe(1);
  });

  it('活跃任务永不删除（即使 .json/.log 很旧）', () => {
    const t = reg.start({ pid: 1, command: 'watch', cwd: dir, logPath: join(dir, 'live.log'), startedAt: 1 });
    const json = join(dir, `${t.taskId}.json`);
    const log = touch(`${t.taskId}.log`, 'live', 30 * DAY);
    const old = new Date(Date.now() - 30 * DAY);
    utimesSync(json, old, old);

    const r = reg.pruneRuns({ retentionDays: 7, maxTotalMb: 0 });

    expect(existsSync(json)).toBe(true);
    expect(existsSync(log)).toBe(true);
    expect(r.removedTasks).toBe(0);
    expect(r.removedLogs).toBe(0);
  });

  it('按大小：日志总量超限时从 mtime 最旧删起，活跃任务跳过', () => {
    // 三个各 1MB 的日志（无 .json，mtime 均在保留期内，只看总量）
    const sizes = [1024 * 1024, 1024 * 1024, 1024 * 1024];
    const ids = ['bg_size_a', 'bg_size_b', 'bg_size_c'];
    ids.forEach((id, i) => {
      const p = join(dir, `${id}.log`);
      writeFileSync(p, '');
      truncateSync(p, sizes[i]);
      const t = new Date(Date.now() - (ids.length - i) * 60 * 1000); // a 最旧
      utimesSync(p, t, t);
    });

    const r = reg.pruneRuns({ retentionDays: 30, maxTotalMb: 2 });

    expect(existsSync(join(dir, 'bg_size_a.log'))).toBe(false);
    expect(existsSync(join(dir, 'bg_size_b.log'))).toBe(true);
    expect(existsSync(join(dir, 'bg_size_c.log'))).toBe(true);
    expect(r.removedLogs).toBe(1);
  });

  it('enabled=false 时一律不清理', () => {
    const oldJson = touch('bg_old_5.json', '{}', 60 * DAY);
    const r = reg.pruneRuns({ enabled: false, retentionDays: 7, maxTotalMb: 0 });
    expect(existsSync(oldJson)).toBe(true);
    expect(r.removedTasks).toBe(0);
  });

  it('orphaned-running 超 1h 彻底放弃（.json + .log 一并删除）', () => {
    const json = touch(
      'bg_orphan_6.json',
      JSON.stringify({ taskId: 'bg_orphan_6', status: 'orphaned-running' }),
      2 * 60 * 60 * 1000,
    );
    const log = touch('bg_orphan_6.log', 'x', 2 * 60 * 60 * 1000);

    const r = reg.pruneRuns({ retentionDays: 30, maxTotalMb: 1000 });

    expect(existsSync(json)).toBe(false);
    expect(existsSync(log)).toBe(false);
    expect(r.removedTasks).toBe(1);
  });
});
