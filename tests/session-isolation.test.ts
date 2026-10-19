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
import { WorkingMemory, isEphemeral } from '../src/memory/working.js';
import { ContextAssembler } from '../src/memory/context.js';
import { CuratedMemory } from '../src/memory/curated.js';
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
  it('1.12/1.13 Session 分层恢复：统一压缩视图（system + 摘要占位 + 最近 3 轮）', async () => {
    const messages = makeMessages(50);
    const meta = await store.createSession('分层恢复测试', messages, []);
    await store.updateSession(meta.id, messages, []);

    const data = await store.loadSession(meta.id);
    const agent = new ReActAgent();
    const systemPrompt = '你是一个测试助手';
    agent.restoreSession(data, systemPrompt);

    const restored = agent.getSessionMessages();

    // 统一压缩视图：system + (摘要占位) + 最近 3 轮（远小于全量 100 条）
    expect(restored.length).toBeLessThanOrEqual(8);
    expect(restored.length).toBeLessThan(messages.length);
    expect(restored[0].role).toBe('system');
    expect(restored[0].content).toContain(systemPrompt);

    // lastSummary 以 ephemeral 占位注入首条 user 消息（不污染 system，也不写盘）
    if (data.lastSummary) {
      expect(restored[1].role).toBe('user');
      expect(isEphemeral(restored[1])).toBe(true);
      expect(restored[1].content).toContain('[历史摘要]');
    }
  });

  it('SessionStore.getRestoreMessages：统一压缩视图，与 compact 产出同形态', async () => {
    const messages = makeMessages(50);
    const meta = await store.createSession('静态恢复测试', messages, []);
    await store.updateSession(meta.id, messages, []);

    const data = await store.loadSession(meta.id);
    const restoreMsgs = SessionStore.getRestoreMessages(data, '系统提示');

    expect(restoreMsgs[0].role).toBe('system');
    expect(restoreMsgs.length).toBeLessThan(messages.length);
    // 摘要占位为 ephemeral（LLM 可见、不落盘），且只注入一次
    const placeholders = restoreMsgs.filter((m) => isEphemeral(m));
    expect(placeholders.length).toBe(1);
    expect(placeholders[0].content).toContain('[历史摘要]');

    // === 一致性断言：内存压缩与磁盘恢复产出同一形态 ===
    const wm = new WorkingMemory();
    const compacted = wm.compact(
      [
        { role: 'system', content: '系统提示' },
        ...data.messages!.filter((m) => m.role !== 'system'),
      ],
      data.lastSummary || undefined,
    );
    expect(compacted.map((m) => m.role)).toEqual(restoreMsgs.map((m) => m.role));
    expect(compacted.map((m) => m.content)).toEqual(restoreMsgs.map((m) => m.content));
  });

  // ===== 6. 全量 messages 头部保留（L1 压缩不丢头） =====
  it('1.15 L1 压缩后 updateSession 不丢全量头部：data.messages 合并而非覆盖', async () => {
    const full = makeMessages(10); // 20 条
    const withSystem: ChatMessage[] = [
      { role: 'system', content: '测试 system' },
      ...full,
    ];
    const meta = await store.createSession('头部保留测试', withSystem, []);
    await store.updateSession(meta.id, withSystem, []);

    // 模拟 L1 压缩：传入视图只剩 system + 最近 2 轮（头部轮次被 WorkingMemory.compact 丢弃）
    const compacted = [withSystem[0], ...full.slice(-4)];
    await store.updateSession(meta.id, compacted, []);

    let data = await store.loadSession(meta.id);
    // 全量字段头部完整：system + 首轮 user 仍在
    expect(data.messages![0].role).toBe('system');
    expect(data.messages![1].role).toBe('user');
    expect(data.messages![1].content).toContain('用户问题 0');
    // 压缩传入不引入重复，长度不回缩
    expect(data.messages!.length).toBe(withSystem.length);

    // 正常追加回归：新增一轮只追加 2 条
    const nextTurn: ChatMessage[] = [
      ...compacted,
      { role: 'user', content: '用户问题 追加轮：这是一条较长的测试消息。' },
      { role: 'assistant', content: '助手回复 追加轮。' },
    ];
    await store.updateSession(meta.id, nextTurn, []);
    data = await store.loadSession(meta.id);
    expect(data.messages!.length).toBe(withSystem.length + 2);
    expect(data.messages!.at(-1)?.content).toContain('追加轮');
    // 头部不受追加影响
    expect(data.messages![1].content).toContain('用户问题 0');
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
      tag: 'knowledge', // 非压缩类 tag（压缩笔记 tag: compaction 已被检索侧过滤）
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

    // 关键断言：只恢复统一压缩视图（最近 3 轮），不加载全部 500 条
    const restored = agent.getSessionMessages();
    expect(restored.length).toBeLessThan(messages.length);
    expect(restored.length).toBeLessThanOrEqual(8);

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

  // ===== 7. 三视图统一：写盘过滤 + 双通道防护 =====
  it('1.16 写盘过滤 ephemeral：临时占位不进入全量历史与 recentMessages', async () => {
    const base: ChatMessage[] = [
      { role: 'system', content: '测试 system' },
      ...makeMessages(3),
    ];
    const meta = await store.createSession('占位过滤测试', base, []);
    await store.updateSession(meta.id, base, []);

    // 模拟恢复/压缩后的内存视图：含一条 ephemeral 摘要占位
    const withPlaceholder: ChatMessage[] = [
      { role: 'system', content: '测试 system' },
      { role: 'user', content: '[历史摘要] 早前的决定：store 采用合并写', ephemeral: true },
      ...makeMessages(3),
    ];
    await store.updateSession(meta.id, withPlaceholder, []);

    const data = await store.loadSession(meta.id);
    // 全量历史：占位被过滤，长度不受影响
    expect(data.messages!.some((m) => isEphemeral(m))).toBe(false);
    expect(
      data.messages!.some(
        (m) => typeof m.content === 'string' && m.content.startsWith('[历史摘要]'),
      ),
    ).toBe(false);
    expect(data.messages!.length).toBe(base.length);
    // 分层原材料同样不含占位
    expect(data.recentMessages!.some((m) => isEphemeral(m))).toBe(false);
  });

  it('1.17 防护 B：L2 检索跳过 tag: compaction 的压缩笔记（避免双通道重复注入）', async () => {
    await episodic.appendToday('压缩笔记：当前进度是修复 store 合并写', {
      sessionId: 'sess_C',
      scope: 'session',
      tag: 'compaction',
    });
    await episodic.appendToday('压缩笔记：跨会话的压缩内容', {
      sessionId: 'sess_C',
      scope: 'global',
      tag: 'compaction',
    });

    const hit = await episodic.search('压缩笔记', 5, { sessionId: 'sess_C' });
    expect(hit.length).toBe(0);

    // 同前缀的非压缩类条目仍可检索（确认过滤只针对 compaction tag）
    await episodic.appendToday('普通笔记：压缩相关但不是压缩笔记', {
      sessionId: 'sess_C',
      scope: 'session',
      tag: 'note',
    });
    const hit2 = await episodic.search('普通笔记', 5, { sessionId: 'sess_C' });
    expect(hit2.length).toBe(1);
  });

  it('1.18 防护 C：查询增强拼接检索词时排除 ephemeral 占位', async () => {
    const queries: string[] = [];
    const fakeEpisodic = {
      search: async (q: string) => {
        queries.push(q);
        return [];
      },
    } as unknown as EpisodicMemory;

    mkdirSync(join(TEST_DIR, 'curated-empty'), { recursive: true });
    const assembler = new ContextAssembler(
      new CuratedMemory(join(TEST_DIR, 'curated-empty')),
      fakeEpisodic,
    );

    const current: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '[历史摘要] 早前决定：store 改用合并写', ephemeral: true },
      { role: 'user', content: '继续改 session 恢复逻辑' },
    ];
    await assembler.assemble('继续改 session 恢复逻辑', current, [], {
      queryEnhanceRounds: 3,
      sessionId: 'sess_D',
    });

    expect(queries.length).toBeGreaterThan(0);
    // 占位文本不得进入检索词，真实用户消息必须进入
    for (const q of queries) {
      expect(q).not.toContain('[历史摘要]');
    }
    expect(queries.some((q) => q.includes('继续改 session 恢复逻辑'))).toBe(true);
  });
});
