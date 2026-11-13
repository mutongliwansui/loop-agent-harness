// 后台任务统一读模型单测（需求 20261112-006）
// 覆盖：状态映射、字段投影、会话过滤、类型过滤、排序、getJob
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandStatusOf,
  getJob,
  listJobs,
  subAgentStatusOf,
  toCommandJob,
  toSubAgentJob,
} from '../src/background/jobs.js';
import {
  backgroundTasks,
  setRunsDirForTest,
  type BackgroundTask,
} from '../src/tools/background-tasks.js';
import { subAgentRegistry } from '../src/agent/subagent-registry.js';

let dir = '';

function command(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: `bg_test_${Math.random().toString(16).slice(2, 10)}_1`,
    command: 'node server.js',
    cwd: dir,
    logPath: join(dir, 'x.log'),
    startedAt: 1_000,
    status: 'running',
    cursor: 0,
    ...over,
  };
}

/** 直接往全局表里塞一条任务（绕过 spawn，仅测读模型） */
function startCommand(over: Partial<BackgroundTask> = {}): BackgroundTask {
  const t = command(over);
  backgroundTasks.start({
    taskId: t.taskId,
    pid: t.pid,
    command: t.command,
    cwd: t.cwd,
    logPath: t.logPath,
    startedAt: t.startedAt,
    sessionId: t.sessionId,
  });
  return backgroundTasks.get(t.taskId)!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop-jobs-'));
  setRunsDirForTest(dir);
  subAgentRegistry.reset();
});

afterEach(() => {
  subAgentRegistry.reset();
  setRunsDirForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe('状态映射', () => {
  it('命令任务：running / exited / killed / orphaned 映射到统一状态', () => {
    expect(commandStatusOf(command({ status: 'running' }))).toBe('running');
    expect(commandStatusOf(command({ status: 'exited', exitCode: 0 }))).toBe('done');
    expect(commandStatusOf(command({ status: 'exited', exitCode: 2 }))).toBe('failed');
    expect(commandStatusOf(command({ status: 'exited', exitCode: null }))).toBe('failed');
    expect(commandStatusOf(command({ status: 'killed' }))).toBe('stopped');
    expect(commandStatusOf(command({ status: 'orphaned-running' }))).toBe('lost');
    expect(commandStatusOf(command({ status: 'orphaned-exited' }))).toBe('lost');
  });

  it('子任务：running / done / failed / aborted 映射到统一状态', () => {
    const rec = subAgentRegistry.create({ taskId: 'sub_x', task: 't' });
    expect(subAgentStatusOf(rec)).toBe('running');
    subAgentRegistry.finish('sub_x', { status: 'done' });
    expect(subAgentStatusOf(subAgentRegistry.get('sub_x')!)).toBe('done');
    subAgentRegistry.create({ taskId: 'sub_y', task: 't' });
    subAgentRegistry.finish('sub_y', { status: 'failed' });
    expect(subAgentStatusOf(subAgentRegistry.get('sub_y')!)).toBe('failed');
    const rec2 = subAgentRegistry.create({ taskId: 'sub_y2', task: 't' });
    expect(subAgentStatusOf(rec2)).toBe('running');
    subAgentRegistry.finish('sub_y2', { status: 'aborted' });
    expect(subAgentStatusOf(subAgentRegistry.get('sub_y2')!)).toBe('stopped');
  });
});

describe('字段投影', () => {
  it('命令任务：标题/耗时/停止与日志能力', () => {
    const job = toCommandJob(command({ status: 'running', startedAt: 1_000 }), 6_000);
    expect(job).toMatchObject({
      kind: 'command',
      title: 'node server.js',
      status: 'running',
      elapsedMs: 5_000,
      canStop: true,
      canReadLogs: true,
    });
  });

  it('子任务：标题/轮次/错误/停止能力', () => {
    const rec = subAgentRegistry.create({ taskId: 'sub_a', task: '调研' });
    subAgentRegistry.touch('sub_a', { iterations: 3 });
    const job = toSubAgentJob(subAgentRegistry.get('sub_a')!, rec.startedAt + 2_000);
    expect(job).toMatchObject({
      kind: 'subagent',
      title: '调研',
      status: 'running',
      iterations: 3,
      canStop: false,
      canReadLogs: false,
    });
  });
});

describe('listJobs：会话与类型过滤', () => {
  it('当前会话 + 无归属；其他会话不出现', () => {
    startCommand({ taskId: 'bg_aaaaaaa1_1', sessionId: 'sessA', startedAt: 1_000 });
    startCommand({ taskId: 'bg_aaaaaaa2_1', sessionId: 'sessB', startedAt: 2_000 });
    startCommand({ taskId: 'bg_aaaaaaa3_1', startedAt: 3_000 });
    subAgentRegistry.create({ taskId: 'sub_jobA', sessionId: 'sessA', task: 'A 的任务' });
    subAgentRegistry.create({ taskId: 'sub_jobB', sessionId: 'sessB', task: 'B 的任务' });

    const ids = listJobs({ sessionId: 'sessA', limit: 50 }).map((j) => j.id);
    expect(ids).toContain('bg_aaaaaaa1_1');
    expect(ids).toContain('bg_aaaaaaa3_1');
    expect(ids).toContain('sub_jobA');
    expect(ids).not.toContain('bg_aaaaaaa2_1');
    expect(ids).not.toContain('sub_jobB');
  });

  it('kind 过滤与 startedAt 倒序', () => {
    startCommand({ taskId: 'bg_bbbbbbb1_1', sessionId: 'sessC', startedAt: 1_000 });
    startCommand({ taskId: 'bg_bbbbbbb2_1', sessionId: 'sessC', startedAt: 5_000 });
    subAgentRegistry.create({ taskId: 'sub_C', sessionId: 'sessC', task: 'C' });

    const commands = listJobs({ sessionId: 'sessC', kind: 'command' });
    expect(commands.every((j) => j.kind === 'command')).toBe(true);
    expect(commands[0].id).toBe('bg_bbbbbbb2_1');

    const subs = listJobs({ sessionId: 'sessC', kind: 'subagent' });
    expect(subs.map((j) => j.id)).toEqual(['sub_C']);
  });

  it('includeUnowned=false 时排除无归属任务', () => {
    startCommand({ taskId: 'bg_ccccccc1_1' });
    const ids = listJobs({ sessionId: 'sessD', includeUnowned: false }).map((j) => j.id);
    expect(ids).not.toContain('bg_ccccccc1_1');
  });

  it('limit 截断', () => {
    for (let i = 0; i < 5; i++) {
      startCommand({ taskId: `bg_ddddddd${i}_1`, sessionId: 'sessE', startedAt: 1_000 + i });
    }
    expect(listJobs({ sessionId: 'sessE', limit: 2 })).toHaveLength(2);
  });
});

describe('getJob', () => {
  it('两类任务均可按 ID 查询，未知返回 undefined', () => {
    startCommand({ taskId: 'bg_eeeeeee1_1', sessionId: 'sessF' });
    subAgentRegistry.create({ taskId: 'sub_F', sessionId: 'sessF', task: 'F' });

    expect(getJob('bg_eeeeeee1_1')?.kind).toBe('command');
    expect(getJob('sub_F')?.kind).toBe('subagent');
    expect(getJob('nope')).toBeUndefined();
  });
});
