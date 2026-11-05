// 需求 20261105-001：后台任务完成通知卡片纯函数（整体识别 / 容错降级 / 历史脏数据兜底）
import { describe, it, expect } from 'vitest';
import {
  noticeLabel,
  noticeTone,
  parseBackgroundNotice,
  stripAnsi,
} from '../webui/src/background-notice.js';

function noticeText(overrides?: { status?: string; logTail?: string }): string {
  return [
    '<background_task_notification>',
    'taskId: bg_b2c77fd5_1793812232',
    'command: npm test -- --reporter=verbose 2>&1',
    `status: ${overrides?.status ?? 'exited (exitCode=1)'}`,
    'duration: 198.8s',
    'logTail:',
    overrides?.logTail ?? ' FAIL  tests/x.test.ts\nError: waitFor 超时',
    '</background_task_notification>',
  ].join('\n');
}

describe('parseBackgroundNotice', () => {
  it('完整通知 → 字段齐全（失败态）', () => {
    const n = parseBackgroundNotice(noticeText());
    expect(n).toBeDefined();
    expect(n!.taskId).toBe('bg_b2c77fd5_1793812232');
    expect(n!.command).toBe('npm test -- --reporter=verbose 2>&1');
    expect(n!.exitCode).toBe(1);
    expect(n!.killed).toBe(false);
    expect(n!.durationSec).toBeCloseTo(198.8);
    expect(n!.logLines).toBe(2);
    expect(noticeTone(n!)).toBe('danger');
    expect(noticeLabel(n!)).toBe('失败（退出码 1）');
  });

  it('成功（exitCode=0）→ ok/已完成', () => {
    const n = parseBackgroundNotice(noticeText({ status: 'exited (exitCode=0)', logTail: '✓ built in 11s' }));
    expect(n!.exitCode).toBe(0);
    expect(noticeTone(n!)).toBe('ok');
    expect(noticeLabel(n!)).toBe('已完成');
  });

  it('killed（用户停止）→ warn/已停止，exitCode 为 null', () => {
    const n = parseBackgroundNotice(noticeText({ status: 'killed（用户停止）' }));
    expect(n!.killed).toBe(true);
    expect(n!.exitCode).toBeNull();
    expect(noticeTone(n!)).toBe('warn');
    expect(noticeLabel(n!)).toBe('已停止');
  });

  it('混合文本（通知块前后有其他内容）→ undefined，不吞正常消息', () => {
    expect(parseBackgroundNotice(`看看这个\n${noticeText()}`)).toBeUndefined();
    expect(parseBackgroundNotice(`${noticeText()}\n再帮我跑一遍`)).toBeUndefined();
    expect(parseBackgroundNotice('随便一句用户消息')).toBeUndefined();
  });

  it('缺 taskId / status 行不认识 → undefined 降级纯文本', () => {
    const noTaskId = noticeText().replace('taskId: bg_b2c77fd5_1793812232\n', '');
    expect(parseBackgroundNotice(noTaskId)).toBeUndefined();
    expect(parseBackgroundNotice(noticeText({ status: 'crashed somehow' }))).toBeUndefined();
  });

  it('历史脏数据兜底：logTail 含 ANSI 与 \\r 覆写 → 显示干净', () => {
    // \r 覆写收敛会丢弃 \r 前内容（进度条语义），故 ANSI 与覆写分属两行断言
    const n = parseBackgroundNotice(
      noticeText({ logTail: '\x1b[31mFAIL\x1b[39m tests/x\nprogress 10%\rprogress 90%\ndone' }),
    );
    expect(n!.logTail).not.toContain('\x1b');
    expect(n!.logTail).not.toContain('[31m');
    expect(n!.logTail).toContain('FAIL');
    expect(n!.logTail).toContain('progress 90%');
    expect(n!.logTail).not.toContain('\r');
  });

  it('旧版遗留：被 L2 记忆前缀包裹的通知仍识别为卡片（D9 兼容）', () => {
    const wrapped = `## 相关历史记忆\n\n<<<LOOP_AGENT_MEMORY_END_7f3a9c2e>>>\n\n${noticeText()}`;
    const n = parseBackgroundNotice(wrapped);
    expect(n).toBeDefined();
    expect(n!.taskId).toBe('bg_b2c77fd5_1793812232');
    // 记忆前缀不应混入 command / logTail
    expect(n!.logTail).not.toContain('相关历史记忆');
  });

  it('缺 command/duration/logTail → 可缺省渲染', () => {
    const bare = [
      '<background_task_notification>',
      'taskId: bg_12345678_1',
      'status: exited (exitCode=0)',
      '</background_task_notification>',
    ].join('\n');
    const n = parseBackgroundNotice(bare);
    expect(n).toBeDefined();
    expect(n!.command).toBe('');
    expect(n!.durationSec).toBeNull();
    expect(n!.logTail).toBe('');
    expect(n!.logLines).toBe(0);
  });

  it('stripAnsi 与后端同形：CSI/OSC/字符集全剥', () => {
    expect(stripAnsi('\x1b[1;31mred\x1b[0m \x1b]0;t\x07\x1b(0x')).toBe('red x');
  });
});
