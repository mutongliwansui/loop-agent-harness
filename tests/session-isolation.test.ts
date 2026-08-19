/**
 * Session 恢复和隔离功能测试
 *
 * 测试内容：
 * 1. Session 分层存储（recentMessages / lastSummary / archivedMessages）
 * 2. Session 分层恢复（只加载 recentMessages，lastSummary 注入）
 * 3. L2 Episodic Memory Session 隔离（scope: session 只在当前会话可见）
 * 4. L2 Episodic Memory 全局共享（scope: global 跨会话可见）
 * 5. Phase 1.14: Session 超大恢复（500 条消息，首轮不触发 L1 压缩）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SessionStore } from '../src/session/store.js';
import { EpisodicMemory } from '../src/memory/episodic.js';
import { WorkingMemory } from '../src/memory/working.js';
import { ReActAgent } from '../src/agent/react-agent.js';
import { keychain } from '../src/session/keychain.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import type { ChatMessage } from '../src/types.js';
import type { SessionData } from '../src/session/types.js';

const TEST_DIR = join(tmpdir(), 'loop-agent-tests', 'test-session-isolation');
const TEST_WORKSPACE = join(TEST_DIR, 'workspace');
const MEMORY_DIR = join(TEST_DIR, 'memory');

/** 生成消息历史：count 轮（每轮 user + assistant 两条） */
function makeMessages(count: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: 'user',
      content: `用户问题 ${i}：这是一条较长的测试消息，用于模拟真实对话的上下文体积。${'x'.repeat(100)}`,
    });
    messages.push({
      role: 'assistant',
      content: `助手回复 ${i}：${'y'.repeat(100)}`,
    });
  }
  return messages;
}

describe('Session 分层存储和恢复', () => {
  let store: SessionStore;
  let episodic: EpisodicMemory;

  beforeAll(async () => {
    // 清理并重建测试目录
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });

    keychain.ensureUnlocked();

    // 使用隔离的 workspace/userDir 路径，避免污染真实会话数据（沙盒禁止写真实 HOME）
    store = new SessionStore(TEST_WORKSPACE, 3, true, TEST_DIR);
    await store.init();

    episodic = new EpisodicMemory(MEMORY_DIR);
    await episodic.init();
  });

  afterAll(async () => {
    await store.deleteAllSessions();
    episodic.closeIndex();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ===== 1. Session 分层存储 =====
  it('1.11 Session 分层存储：recentMessages / lastSummary / archivedMessages 分离', async () => {
    const messages = makeMessages(50); // 100 条消息
    const meta = await store.createSession('分层存储测试', messages, []);
    await store.updateSession(meta.id, messages, []);

    const data = await store.loadSession(meta.id);

    // recentMessages 只保留最近 3 轮（每轮约 4 条 = 12 条上限）
    expect(data.recentMessages!.length).toBeGreaterThan(0);
    expect(data.recentMessages!.length).toBeLessThanOrEqual(12);

    // 归档存在，且超过 30 条阈值后生成 lastSummary
    expect(data.archivedMessages!.length).toBeGreaterThan(0);
    expect(data.archivedCount).toBeGreaterThan(0);
    expect(data.lastSummary).toBeTruthy();
  });

  // ===== 2. Session 分层恢复 =====
  it('1.12/1.13 Session 分层恢复：只加载 recentMessages，lastSummary 注入 system', async () => {
    const messages = makeMessages(50);
    const meta = await store.createSession('分层恢复测试', messages, []);
    await store.updateSession(meta.id, messages, []);

    const data = await store.loadSession(meta.id);
    const agent = new ReActAgent();
    const systemPrompt = '你是一个测试助手';
    agent.restoreSession(data, systemPrompt);

    const restored = agent.getSessionMessages();

    // 只恢复 system + lastSummary + recentMessages（远小于全量 100 条）
    expect(restored.length).toBeLessThanOrEqual(14);
    expect(restored.length).toBeLessThan(messages.length);
    expect(restored[0].role).toBe('system');
    expect(restored[0].content).toContain(systemPrompt);

    // lastSummary 作为首条 user 消息注入（不污染 system，保留前缀缓存）
    if (data.lastSummary) {
      expect(restored[1].role).toBe('user');
      expect(restored[1].content).toContain('会话历史摘要');
    }
  });

  it('SessionStore.getRestoreMessages 只含 system + lastSummary + recentMessages', async () => {
    const messages = makeMessages(50);
    const meta = await store.createSession('静态恢复测试', messages, []);
    await store.updateSession(meta.id, messages, []);

    const data = await store.loadSession(meta.id);
    const restoreMsgs = SessionStore.getRestoreMessages(data, '系统提示');

    expect(restoreMsgs[0].role).toBe('system');
    expect(restoreMsgs.length).toBeLessThan(messages.length);
    expect(
      restoreMsgs.some(
        (m) => typeof m.content === 'string' && m.content.includes('会话历史摘要'),
      ),
    ).toBe(true);
  });

  // ===== 3. L2 Episodic Memory Session 隔离 =====
  it('1.4/1.7 L2 Session 隔离：session 级条目只对来源会话可见', async () => {
    const sessionA = 'sess_A';
    const sessionB = 'sess_B';

    await episodic.appendToday('机密信息：华锐报价 12.5 元', {
      sessionId: sessionA,
      scope: 'session',
      tag: 'tool',
    });

    const fromA = await episodic.search('华锐报价', 5, { sessionId: sessionA });
    const fromB = await episodic.search('华锐报价', 5, { sessionId: sessionB });

    expect(fromA.length).toBe(1);
    expect(fromB.length).toBe(0);
  });

  // ===== 4. L2 全局共享 =====
  it('1.8 L2 global 级共享：全局记忆跨会话可见', async () => {
    await episodic.appendToday('项目知识：本项目使用 TypeScript + Node.js 技术栈', {
      sessionId: 'sess_A',
      scope: 'global',
      tag: 'compaction',
    });

    const fromB = await episodic.search('TypeScript', 5, { sessionId: 'sess_B' });
    expect(fromB.length).toBe(1);
  });

  // ===== 5. Phase 1.14: Session 超大恢复 =====
  it('1.14 Session 超大恢复：恢复 500 条消息的 Session，首轮不触发 L1 压缩', async () => {
    // 500 条消息（250 轮）
    const messages = makeMessages(250);
    expect(messages.length).toBe(500);

    const meta = await store.createSession('超大 Session 测试', messages, []);
    await store.updateSession(meta.id, messages, []);
    const data: SessionData = await store.loadSession(meta.id);

    // 分层存储：归档了大量历史
    expect(data.archivedMessages!.length).toBeGreaterThan(0);
    expect(data.recentMessages!.length).toBeLessThanOrEqual(12);

    // 恢复 Session
    const agent = new ReActAgent();
    agent.restoreSession(data, '系统提示');

    // 关键断言：只加载 recentMessages，不加载全部 500 条
    const restored = agent.getSessionMessages();
    expect(restored.length).toBeLessThan(messages.length);
    expect(restored.length).toBeLessThanOrEqual(14);

    // 首轮 = 恢复后的上下文 + 用户新消息，不应触发 L1 压缩
    // （若错误加载全量 500 条，估算 token 约 2.5w+，必触发 8000*0.8=6400 阈值）
    const wm = new WorkingMemory();
    const firstRound: ChatMessage[] = [
      ...restored,
      { role: 'user', content: '新的问题' },
    ];
    expect(wm.needsCompaction(firstRound)).toBe(false);
    expect(wm.estimateTokens(firstRound)).toBeLessThan(
      wm.getConfig().maxTokens * wm.getConfig().compactionThreshold,
    );
  });
});
