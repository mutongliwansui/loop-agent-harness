// 需求 20261104-004：后台任务完成通知（队列 / drain / 去重 / 恢复补投）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureBackgroundNotify,
  drainBackgroundNotices,
  installBackgroundNoticeForwarder,
  resetBackgroundNoticesForTest,
  restoreBackgroundNotices,
  sanitizeLogText,
} from '../src/agent/background-notice.js';
import {
  backgroundTasks,
  setRunsDirForTest,
  type BackgroundTask,
} from '../src/tools/background-tasks.js';

let dir = '';

function taskJsonPath(taskId: string): string {
  return join(dir, `${taskId}.json`);
}

function writeTask(task: Partial<BackgroundTask> & { taskId: string }): void {
  writeFileSync(taskJsonPath(task.taskId), JSON.stringify(task, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bg-notice-'));
  setRunsDirForTest(dir);
  resetBackgroundNoticesForTest();
  configureBackgroundNotify({ enabled: true, tailLines: 3, maxChars: 200 });
  installBackgroundNoticeForwarder();
});

afterEach(() => {
  setRunsDirForTest(undefined);
  resetBackgroundNoticesForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('后台任务完成通知', () => {
  it('finish 入队，drain 返回注入文本并落盘 notifiedAt，重复 drain 为空', () => {
    const logPath = join(dir, 'bg_test.log');
    writeFileSync(logPath, 'line1\nline2\nline3\nline4\nline5\nlast\n');
    backgroundTasks.start({
      taskId: 'bg_aaaaaaaa_1700000000',
      pid: 1,
      command: 'npm run dev',
      cwd: dir,
      logPath,
      startedAt: Date.now(),
      sessionId: 's1',
    });
    backgroundTasks.finish('bg_aaaaaaaa_1700000000', 0);

    const first = drainBackgroundNotices('s1');
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('bg_aaaaaaaa_1700000000');
    expect(first[0]).toContain('npm run dev');
    expect(first[0]).toContain('exited (exitCode=0)');
    // tailLines=3：只保留最后 3 行
    expect(first[0]).toContain('line5');
    expect(first[0]).not.toContain('line1');

    const persisted = JSON.parse(
      readFileSync(taskJsonPath('bg_aaaaaaaa_1700000000'), 'utf-8'),
    ) as BackgroundTask;
    expect(persisted.notifiedAt).toBeGreaterThan(0);

    expect(drainBackgroundNotices('s1')).toHaveLength(0);
  });

  it('kill 也产生通知，文本标记 killed', () => {
    const logPath = join(dir, 'bg_bbbbbbbb.log');
    writeFileSync(logPath, 'working\n');
    backgroundTasks.start({
      taskId: 'bg_bbbbbbbb_1700000001',
      pid: 1,
      command: 'long task',
      cwd: dir,
      logPath,
      startedAt: Date.now(),
      sessionId: 's1',
    });
    backgroundTasks.kill('bg_bbbbbbbb_1700000001');
    const texts = drainBackgroundNotices('s1');
    expect(texts[0]).toContain('killed');
  });

  it('会话隔离：s2 的通知不会投递给 s1；无归属桶所有会话可见', () => {
    const logPath = join(dir, 'bg_cccccccc.log');
    writeFileSync(logPath, 'x\n');
    backgroundTasks.start({
      taskId: 'bg_cccccccc_1700000002',
      pid: 1,
      command: 'c',
      cwd: dir,
      logPath,
      startedAt: Date.now(),
      sessionId: 's2',
    });
    backgroundTasks.finish('bg_cccccccc_1700000002', 1);

    backgroundTasks.start({
      taskId: 'bg_dddddddd_1700000003',
      pid: 1,
      command: 'd',
      cwd: dir,
      logPath: join(dir, 'bg_dddddddd.log'),
      startedAt: Date.now(),
    });
    backgroundTasks.finish('bg_dddddddd_1700000003', 0);

    const forS1 = drainBackgroundNotices('s1');
    expect(forS1).toHaveLength(1);
    expect(forS1[0]).toContain('bg_dddddddd_1700000003');

    const forS2 = drainBackgroundNotices('s2');
    expect(forS2).toHaveLength(1);
    expect(forS2[0]).toContain('bg_cccccccc_1700000002');
  });

  it('恢复补投：扫盘读取同会话未投递任务，drain 后磁盘 notifiedAt 写入', () => {
    const finishedAt = Date.now() - 60_000;
    writeTask({
      taskId: 'bg_eeeeeeee_1700000010',
      command: 'restored',
      cwd: dir,
      logPath: join(dir, 'bg_eeeeeeee.log'),
      startedAt: finishedAt - 5000,
      status: 'exited',
      exitCode: 0,
      finishedAt,
      cursor: 0,
      sessionId: 's1',
    });
    writeFileSync(join(dir, 'bg_eeeeeeee.log'), 'done\n');

    const count = restoreBackgroundNotices('s1', dir);
    expect(count).toBe(1);

    const texts = drainBackgroundNotices('s1');
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('restored');

    const persisted = JSON.parse(
      readFileSync(taskJsonPath('bg_eeeeeeee_1700000010'), 'utf-8'),
    ) as BackgroundTask;
    expect(persisted.notifiedAt).toBeGreaterThan(0);

    // 再次恢复不应重复入队
    expect(restoreBackgroundNotices('s1', dir)).toBe(0);
  });

  it('恢复补投跳过其他会话、已投递与运行中任务', () => {
    const base = Date.now() - 60_000;
    writeTask({
      taskId: 'bg_ffffffff_1700000020',
      command: 'other',
      cwd: dir,
      logPath: join(dir, 'bg_ffffffff.log'),
      startedAt: base,
      status: 'exited',
      exitCode: 0,
      finishedAt: base + 1000,
      cursor: 0,
      sessionId: 's2',
    });
    writeTask({
      taskId: 'bg_99999999_1700000021',
      command: 'already',
      cwd: dir,
      logPath: join(dir, 'bg_99999999.log'),
      startedAt: base,
      status: 'exited',
      exitCode: 0,
      finishedAt: base + 1000,
      notifiedAt: base + 5000,
      cursor: 0,
      sessionId: 's1',
    });
    writeTask({
      taskId: 'bg_77777777_1700000022',
      command: 'running',
      cwd: dir,
      logPath: join(dir, 'bg_77777777.log'),
      startedAt: base,
      status: 'running',
      cursor: 0,
      sessionId: 's1',
    });
    expect(restoreBackgroundNotices('s1', dir)).toBe(0);
  });

  it('enabled=false 时不产生任何通知', () => {
    configureBackgroundNotify({ enabled: false });
    const logPath = join(dir, 'bg_88888888.log');
    writeFileSync(logPath, 'x\n');
    backgroundTasks.start({
      taskId: 'bg_88888888_1700000030',
      pid: 1,
      command: 'x',
      cwd: dir,
      logPath,
      startedAt: Date.now(),
      sessionId: 's1',
    });
    backgroundTasks.finish('bg_88888888_1700000030', 0);
    expect(drainBackgroundNotices('s1')).toHaveLength(0);
  });

  it('20261105-001：注入文本剥离 ANSI（CSI/OSC/字符集），正文保留', () => {
    const logPath = join(dir, 'bg_aaaa0001.log');
    // 首行为引导行：readLogTail 既有语义会丢弃首行残片（004），断言针对其后两行
    writeFileSync(
      logPath,
      'preamble\n\x1b[31m\x1b[1m FAIL \x1b[22m\x1b[39m tests/x.test.ts\n\x1b]0;npm test\x07\x1b(0normal line\n',
    );
    backgroundTasks.start({
      taskId: 'bg_aaaa0001_1700000050',
      pid: 1,
      command: 'npm test',
      cwd: dir,
      logPath,
      startedAt: Date.now(),
      sessionId: 's1',
    });
    backgroundTasks.finish('bg_aaaa0001_1700000050', 1);
    const texts = drainBackgroundNotices('s1');
    expect(texts).toHaveLength(1);
    expect(texts[0]).not.toContain('\x1b');
    expect(texts[0]).not.toContain('[31m');
    expect(texts[0]).toContain('FAIL');
    expect(texts[0]).toContain('tests/x.test.ts');
    expect(texts[0]).toContain('normal line');
    // 标签结构不变（D8）
    expect(texts[0]).toContain('<background_task_notification>');
    expect(texts[0]).toContain('status: exited (exitCode=1)');
  });

  it('20261105-001：sanitizeLogText 收敛 \\r 行内覆写为最终态', () => {
    expect(sanitizeLogText('progress 10%\rprogress 90%\ndone\n')).toBe('progress 90%\ndone\n');
    expect(sanitizeLogText('a\nb\rc\n')).toBe('a\nc\n');
    expect(sanitizeLogText('')).toBe('');
    expect(sanitizeLogText('\x1b[32mok\x1b[39m')).toBe('ok');
  });

  it('日志缺失时降级为「日志已清理」，不影响通知', () => {
    backgroundTasks.start({
      taskId: 'bg_12345678_1700000040',
      pid: 1,
      command: 'gone',
      cwd: dir,
      logPath: join(dir, 'missing.log'),
      startedAt: Date.now(),
      sessionId: 's1',
    });
    backgroundTasks.finish('bg_12345678_1700000040', 0);
    const texts = drainBackgroundNotices('s1');
    expect(texts[0]).toContain('日志已清理');
  });
});
