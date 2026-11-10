/**
 * Session 恢复和隔离功能测试
 *
 * 测试内容：
 * 1. 单一真源落盘（messages 全量历史 + is_compact/is_show 标记）
 * 2. 压缩落盘与恢复（被折叠消息 is_compact=true、总结消息 is_show=false）
 * 3. L2 Episodic Memory Session 隔离（scope: session 只在当前会话可见）
 * 4. L2 Episodic Memory 全局共享（scope: global 跨会话可见）
 * 5. Phase 1.14: Session 超大恢复（500 条消息折叠后首轮不触发 L1 压缩）
 * 6. 合并写不丢头（传入尾部窗口不覆盖全量）
 * 7. 三视图统一：写盘过滤摘要占位 + L2 compaction 双通道防护
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SessionStore, SessionNotFoundError } from '../src/session/store.js';
import { EpisodicMemory } from '../src/memory/episodic.js';
import { WorkingMemory, isSummaryPlaceholder } from '../src/memory/working.js';
import { stripMemorySection, withMemorySection } from '../src/memory/memory-section.js';
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
    store = new SessionStore(TEST_WORKSPACE, true, TEST_DIR);
    await store.init();

    episodic = new EpisodicMemory(MEMORY_DIR);
    await episodic.init();
  });

  afterAll(async () => {
    await store.deleteAllSessions();
    episodic.closeIndex();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ===== 1. 单一真源落盘 =====
  it('1.11 单一真源：未压缩时 messages 落盘全量历史（无折叠标记）', async () => {
    const messages = makeMessages(50); // 100 条消息
    const meta = await store.createSession('单一真源测试', messages);
    await store.updateSession(meta.id, messages);

    const data = await store.loadSession(meta.id);

    // 单一 messages 真源：全量历史落盘，无摘要占位
    expect(data.messages.length).toBe(messages.length);
    expect(data.messages.some((m) => isSummaryPlaceholder(m))).toBe(false);
    // 未发生压缩：全部消息 is_compact=false，非 system 消息 is_show=true
    expect(data.messages.every((m) => m.is_compact === false)).toBe(true);
    expect(
      data.messages.filter((m) => m.role !== 'system').every((m) => m.is_show === true),
    ).toBe(true);
  });

  // ===== 2. 压缩落盘与恢复 =====
  it('1.12/1.13 压缩轮次落盘 + 恢复：折叠标记 + 总结消息（is_show=false）', async () => {
    const messages = makeMessages(50);
    const meta = await store.createSession('压缩恢复测试', messages);
    await store.updateSession(meta.id, messages);

    // 模拟 L1 压缩：system + 摘要占位（is_show=false）+ 最近 3 次模型调用
    const wm = new WorkingMemory({ maxTokens: 102400, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const view = wm.compact(
      [{ role: 'system', content: '你是一个测试助手' }, ...messages],
      '早前的决定：store 采用合并写',
    );
    expect(view.some((m) => isSummaryPlaceholder(m))).toBe(true);
    await store.updateSession(meta.id, view);

    const data = await store.loadSession(meta.id);

    // 全量历史保留（system + 100 条 + 总结消息），被折叠部分标记 is_compact=true
    expect(data.messages.length).toBe(messages.length + 2);
    expect(data.messages.filter((m) => m.is_compact === true).length).toBeGreaterThan(0);
    // 总结消息：role=user、is_show=false，且已剥离 [历史摘要] 前缀
    const summaries = data.messages.filter((m) => m.role !== 'system' && m.is_show === false);
    expect(summaries.length).toBe(1);
    expect(summaries[0].content).toBe('早前的决定：store 采用合并写');
    // 临时占位（[历史摘要] 前缀）不落盘；已落盘的是剥离前缀的总结消息
    expect(
      data.messages.some(
        (m) => typeof m.content === 'string' && m.content.startsWith('[历史摘要]'),
      ),
    ).toBe(false);
    const agent = new ReActAgent();
    const systemPrompt = '你是一个测试助手';
    agent.restoreSession(data, systemPrompt);

    const restored = agent.getSessionMessages();
    expect(restored.length).toBeLessThan(messages.length + 1);
    expect(restored.length).toBeLessThanOrEqual(8);
    expect(restored[0].role).toBe('system');
    expect(restored[0].content).toContain(systemPrompt);
    // 被折叠的消息不参与上下文；总结消息作为普通 user 消息进入上下文
    expect(restored.some((m) => m.is_compact === true)).toBe(false);
    expect(restored.some((m) => m.role !== 'system' && m.is_show === false)).toBe(true);
  });

  it('SessionStore.getRestoreMessages：折叠标记过滤 + 总结消息进入上下文', async () => {
    const messages = makeMessages(50);
    const meta = await store.createSession('静态恢复测试', messages);
    await store.updateSession(meta.id, messages);

    const wm = new WorkingMemory({ maxTokens: 102400, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const view = wm.compact(
      [{ role: 'system', content: '系统提示' }, ...messages],
      '本次摘要文本',
    );
    await store.updateSession(meta.id, view);

    const data = await store.loadSession(meta.id);
    const restoreMsgs = SessionStore.getRestoreMessages(data, '系统提示');

    expect(restoreMsgs[0].role).toBe('system');
    expect(restoreMsgs.length).toBeLessThan(data.messages.length);
    // 被折叠的消息（is_compact=true）不进上下文
    expect(restoreMsgs.some((m) => m.is_compact === true)).toBe(false);
    // 总结消息（is_show=false）作为普通 user 消息进入上下文，且只有一条
    const summaries = restoreMsgs.filter((m) => m.role !== 'system' && m.is_show === false);
    expect(summaries.length).toBe(1);
    expect(summaries[0].content).toContain('本次摘要文本');
  });

  // ===== 6. 合并写不丢头（传入尾部窗口不覆盖全量） =====
  it('1.15 updateSession 合并写：传入尾部窗口不丢全量头部、不引入重复', async () => {
    const full = makeMessages(10); // 20 条
    const withSystem: ChatMessage[] = [
      { role: 'system', content: '测试 system' },
      ...full,
    ];
    const meta = await store.createSession('头部保留测试', withSystem);
    await store.updateSession(meta.id, withSystem);

    // 传入尾部窗口（system + 最近 2 轮）：旧模型会覆盖，新模型应合并保留全量头部
    const compacted = [withSystem[0], ...full.slice(-4)];
    await store.updateSession(meta.id, compacted);

    let data = await store.loadSession(meta.id);
    // 全量字段头部完整：system + 首轮 user 仍在
    expect(data.messages[0].role).toBe('system');
    expect(data.messages[1].role).toBe('user');
    expect(data.messages[1].content).toContain('用户问题 0');
    // 尾部窗口传入不引入重复，长度不回缩
    expect(data.messages.length).toBe(withSystem.length);

    // 正常追加回归：新增一轮只追加 2 条
    const nextTurn: ChatMessage[] = [
      ...compacted,
      { role: 'user', content: '用户问题 追加轮：这是一条较长的测试消息。' },
      { role: 'assistant', content: '助手回复 追加轮。' },
    ];
    await store.updateSession(meta.id, nextTurn);
    data = await store.loadSession(meta.id);
    expect(data.messages.length).toBe(withSystem.length + 2);
    expect(data.messages.at(-1)?.content).toContain('追加轮');
    // 头部不受追加影响
    expect(data.messages[1].content).toContain('用户问题 0');
  });

  // ===== 7. 压缩边界锚点对齐（P1/P2 回归） =====
  it('1.16 压缩轮次：重复内容不吞新消息、边界不早于上一轮 recent（P1-a/P1-b）', async () => {
    // 10 轮，首轮用户输入与最后一轮相同（"继续"），制造「同内容跨归档边界」
    const history: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: 'user', content: i === 0 ? '继续' : `问题 ${i}` });
      history.push({ role: 'assistant', content: `回复 ${i}` });
    }
    // keepRecentTurns=1：压缩后 kept 首条恰好是重复内容，旧实现会命中首条归档副本
    const wm = new WorkingMemory({
      maxTokens: 102400,
      compactionThreshold: 0.8,
      keepRecentTurns: 1,
      flushFailure: 'skip',
    });

    const meta = await store.createSession('重复内容边界测试', history);
    await store.updateSession(meta.id, history);

    // 第一轮压缩：折叠前 9 轮（18 条），保留最后 1 轮
    await store.updateSession(meta.id, wm.compact(history, '摘要1'));
    let data = await store.loadSession(meta.id);
    expect(data.messages.filter((m) => m.is_compact === true).length).toBe(18);

    // 第二轮压缩：新用户输入与已归档的首条消息同内容
    const summary = data.messages.find((m) => m.role !== 'system' && m.is_show === false)!;
    const recent = data.messages.filter((m) => m.is_compact !== true && m.is_show !== false);
    const view2 = wm.compact(
      [
        summary,
        ...recent,
        { role: 'user', content: '继续' },
        { role: 'assistant', content: '回复 新' },
      ],
      '摘要2',
    );
    await store.updateSession(meta.id, view2);

    data = await store.loadSession(meta.id);
    // P1-a：旧归档不会被复活成 recent
    expect(data.messages.filter((m) => m.is_compact === true).length).toBeGreaterThanOrEqual(18);
    // P1-b：重复内容的合法新消息没有被去重吞掉（归档旧条 + recent 新条）
    expect(data.messages.filter((m) => m.role === 'user' && m.content === '继续').length).toBe(2);
    // 新一轮完整保留在尾部且为 recent
    expect(data.messages.at(-2)).toMatchObject({
      role: 'user',
      content: '继续',
      is_compact: false,
    });
    expect(data.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '回复 新',
      is_compact: false,
    });
    // 总结消息仍只有一条，且被新摘要取代
    const summaries = data.messages.filter((m) => m.role !== 'system' && m.is_show === false);
    expect(summaries.length).toBe(1);
    expect(summaries[0].content).toBe('摘要2');
  });

  it('1.17 压缩轮次：锚点未命中时保守归档旧历史，不把 kept 一起折叠（P2-a）', async () => {
    const history = makeMessages(6); // 12 条
    const meta = await store.createSession('锚点未命中测试', history);
    await store.updateSession(meta.id, history);

    // 模拟 kept 与已有历史完全不重叠（内容被外部改写/替换）
    await store.updateSession(meta.id, [
      { role: 'user', content: '[历史摘要] 摘要', is_show: false },
      { role: 'user', content: '全新消息 A' },
      { role: 'assistant', content: '全新回复 A' },
    ]);

    const data = await store.loadSession(meta.id);
    // 旧历史按压缩意图归档
    expect(data.messages.filter((m) => m.is_compact === true).length).toBe(history.length);
    // kept 不被一起折叠：最近消息仍在 recent 区，可被恢复进上下文
    const restore = SessionStore.getRestoreMessages(data).filter((m) => m.role !== 'system');
    expect(restore.map((m) => m.content)).toEqual(['摘要', '全新消息 A', '全新回复 A']);
    expect(data.messages.filter((m) => m.is_compact === false && m.is_show !== false).length).toBe(2);
  });

  it('1.18 未压缩轮次：重复内容消息正常落盘，重复写入不膨胀（P1-b）', async () => {
    const firstTurn: ChatMessage[] = [
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '好的' },
    ];
    const meta = await store.createSession('重复内容落盘测试', firstTurn);
    await store.updateSession(meta.id, firstTurn);
    expect((await store.loadSession(meta.id)).messages.length).toBe(2);

    // 用户重发同样内容：属于合法消息，必须落盘
    const secondTurn = [...firstTurn, { role: 'user', content: '继续' }, { role: 'assistant', content: '好的' }];
    await store.updateSession(meta.id, secondTurn);
    expect((await store.loadSession(meta.id)).messages.length).toBe(4);

    // 同一快照重复写入：锚点全命中，不产生重复
    await store.updateSession(meta.id, secondTurn);
    expect((await store.loadSession(meta.id)).messages.length).toBe(4);
  });

  it('1.19 封顶：优先丢弃最老的非总结消息，保留总结消息（P2-b）', async () => {
    // 4000 条 = 1 条总结 + 3999 条普通消息；追加 2 条后触发 4000 条封顶
    const bulk: ChatMessage[] = [{ role: 'user', content: '历史摘要文本', is_show: false }];
    for (let i = 0; i < 3999; i++) {
      bulk.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `批量消息 ${i}` });
    }
    const meta = await store.createSession('封顶测试', bulk);
    // 传入不含总结消息的窗口 → 走未压缩分支，由封顶逻辑处理超限
    await store.updateSession(meta.id, [
      ...bulk.slice(1),
      { role: 'user', content: '新增消息 A' },
      { role: 'assistant', content: '新增回复 A' },
    ]);

    const data = await store.loadSession(meta.id);
    expect(data.messages.length).toBe(4000);
    const summaries = data.messages.filter((m) => m.role !== 'system' && m.is_show === false);
    expect(summaries.length).toBe(1);
    expect(summaries[0].content).toBe('历史摘要文本');
    expect(data.messages.at(-1)?.content).toBe('新增回复 A');
  });

  it('1.20 总结消息显式落盘 kind=summary，判据优先于 is_show（P3）', async () => {
    const history = makeMessages(6); // 12 条
    const meta = await store.createSession('kind 标记测试', history);
    await store.updateSession(meta.id, history);

    // 传入的总结消息只带 kind='summary'（is_show 故意给 true），验证显式种类优先
    await store.updateSession(meta.id, [
      { role: 'user', content: '摘要文本', kind: 'summary', is_show: true },
      { role: 'user', content: '全新消息 B' },
      { role: 'assistant', content: '全新回复 B' },
    ]);

    const data = await store.loadSession(meta.id);
    const summaries = data.messages.filter((m) => m.kind === 'summary');
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toMatchObject({
      role: 'user',
      content: '摘要文本',
      is_show: false,
      is_compact: false,
      kind: 'summary',
    });
    // 旧历史全部归档，总结与 kept 保持 recent
    expect(data.messages.filter((m) => m.is_compact === true).length).toBe(history.length);
    const restore = SessionStore.getRestoreMessages(data).filter((m) => m.role !== 'system');
    expect(restore.map((m) => m.content)).toEqual(['摘要文本', '全新消息 B', '全新回复 B']);
  });

  it('1.21 非总结的隐藏消息不会被误判成总结消息（P3）', async () => {
    // 旧判据 role!=='system' && is_show===false 会把这条 assistant 当成总结消息转写成 user
    const turn: ChatMessage[] = [
      { role: 'user', content: '开始' },
      { role: 'assistant', content: '隐藏回复', is_show: false },
    ];
    const meta = await store.createSession('隐藏消息测试', turn);
    await store.updateSession(meta.id, turn);

    const data = await store.loadSession(meta.id);
    expect(data.messages.length).toBe(2);
    const hidden = data.messages.find((m) => m.content === '隐藏回复');
    expect(hidden?.role).toBe('assistant');
    expect(hidden?.kind).toBeUndefined();
    expect(hidden?.is_compact).toBe(false);
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
  it('1.14 Session 超大恢复：500 条历史折叠后恢复，首轮不触发 L1 压缩', async () => {
    // 500 条消息（250 轮）
    const messages = makeMessages(250);
    expect(messages.length).toBe(500);

    const meta = await store.createSession('超大 Session 测试', messages);
    await store.updateSession(meta.id, messages);

    // 模拟 L1 压缩：折叠头部，只保留最近 3 次模型调用 + 摘要占位
    const wm = new WorkingMemory({ maxTokens: 102400, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const view = wm.compact(
      [{ role: 'system', content: '系统提示' }, ...messages],
      '前 247 轮的关键结论',
    );
    await store.updateSession(meta.id, view);

    const data: SessionData = await store.loadSession(meta.id);

    // 全量历史落盘（不丢历史），多数被折叠
    expect(data.messages.length).toBeGreaterThan(messages.length);
    expect(data.messages.filter((m) => m.is_compact === true).length).toBeGreaterThan(0);

    // 恢复 Session
    const agent = new ReActAgent();
    agent.restoreSession(data, '系统提示');

    // 关键断言：只恢复未折叠部分（最近 3 次调用 + 总结），不加载全部 500 条
    const restored = agent.getSessionMessages();
    expect(restored.length).toBeLessThan(messages.length);
    expect(restored.length).toBeLessThanOrEqual(8);

    // 首轮 = 恢复后的上下文 + 用户新消息，不应触发 L1 压缩
    // （若错误加载全量 500 条，估算 token 约 2.5w+，远超 102400*0.8=81920 阈值）
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
  it('1.16 写盘过滤摘要占位：临时占位转为总结消息，不落盘、不残留占位前缀', async () => {
    const base: ChatMessage[] = [
      { role: 'system', content: '测试 system' },
      ...makeMessages(10),
    ];
    const meta = await store.createSession('占位过滤测试', base);
    await store.updateSession(meta.id, base);

    // 模拟 L1 压缩：产出含摘要占位（is_show=false）的视图
    const wm = new WorkingMemory({ maxTokens: 102400, compactionThreshold: 0.8, keepRecentTurns: 3 });
    const view = wm.compact(base, '早前的决定：store 采用合并写');
    expect(view.some((m) => isSummaryPlaceholder(m))).toBe(true);
    await store.updateSession(meta.id, view);

    const data = await store.loadSession(meta.id);
    // 临时占位不落盘，占位前缀不残留
    expect(
      data.messages.some(
        (m) => typeof m.content === 'string' && m.content.startsWith('[历史摘要]'),
      ),
    ).toBe(false);
    // 摘要以总结消息落盘（is_show=false，展示层据此隐藏/还原）
    const summaries = data.messages.filter((m) => m.role !== 'system' && m.is_show === false);
    expect(summaries.length).toBe(1);
    expect(summaries[0].content).toContain('store 采用合并写');
  });

  // ===== 8. 会话文件缺失与跨扩展名兼容 =====
  it('1.19 会话文件缺失：loadSession 抛 SessionNotFoundError，deleteSession 清理僵尸索引', async () => {
    const meta = await store.createSession('缺失测试', makeMessages(1));
    // 模拟存储数据被外部清理：删除落盘文件（保留索引条目）
    rmSync(join(TEST_DIR, 'sessions', store.id, `${meta.id}.enc`), { force: true });

    // 读取：抛类型化错误（API 层映射 404，而非底层 ENOENT 500）
    await expect(store.loadSession(meta.id)).rejects.toThrowError(SessionNotFoundError);

    // 删除：文件已缺失仍清理索引，避免僵尸条目
    await store.deleteSession(meta.id);
    const list = await store.listSessions();
    expect(list.some((s) => s.id === meta.id)).toBe(false);
  });

  it('1.20 跨扩展名兼容：明文写入的会话可被加密实例读取与删除', async () => {
    // 明文实例写入（.json）
    const plainStore = new SessionStore(TEST_WORKSPACE, false, TEST_DIR);
    await plainStore.init();
    const messages = makeMessages(2);
    const meta = await plainStore.createSession('明文会话', messages);

    // 加密实例读取 .json 文件：按实际扩展名解析，不报 ENOENT
    const data = await store.loadSession(meta.id);
    expect(data.messages.length).toBe(messages.length);

    // 加密实例删除明文文件：文件 + 索引一并清理
    await store.deleteSession(meta.id);
    const list = await store.listSessions();
    expect(list.some((s) => s.id === meta.id)).toBe(false);
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

  it('1.18 防护 C：查询增强拼接检索词时排除摘要占位', async () => {
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
      { role: 'user', content: '[历史摘要] 早前决定：store 改用合并写', is_show: false },
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

  it('1.19 防护 D：L2 记忆只注入真实用户消息，不写入摘要占位（bug 修复）', async () => {
    const fakeEpisodic = {
      search: async () => [{ day: '2026-10-19', content: '历史记忆片段', score: 1 }],
    } as unknown as EpisodicMemory;

    mkdirSync(join(TEST_DIR, 'curated-empty'), { recursive: true });
    const assembler = new ContextAssembler(
      new CuratedMemory(join(TEST_DIR, 'curated-empty')),
      fakeEpisodic,
    );

    const current: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '[历史摘要] 早前决定：store 改用合并写', is_show: false, kind: 'summary' },
      { role: 'user', content: '继续改 session 恢复逻辑' },
    ];
    const assembled = await assembler.assemble('继续改 session 恢复逻辑', current, [], {
      sessionId: 'sess_D',
    });

    // 摘要占位保持纯净（记忆块不得拼到它前面）
    const summary = assembled.find((m) => m.kind === 'summary');
    expect(summary?.content).toBe('[历史摘要] 早前决定：store 改用合并写');
    // 记忆块注入到真实用户消息
    const realUser = assembled.filter((m) => m.role === 'user' && !isSummaryPlaceholder(m)).pop();
    expect(realUser?.content).toContain('历史记忆片段');
    expect(realUser?.content).toContain('继续改 session 恢复逻辑');
  });

  it('1.20 防护 E：压缩后视图无可注入的真实用户时不写记忆（避免摘要被污染）', async () => {
    const fakeEpisodic = {
      search: async () => [{ day: '2026-10-19', content: '历史记忆片段', score: 1 }],
    } as unknown as EpisodicMemory;

    mkdirSync(join(TEST_DIR, 'curated-empty'), { recursive: true });
    const assembler = new ContextAssembler(
      new CuratedMemory(join(TEST_DIR, 'curated-empty')),
      fakeEpisodic,
    );

    const current: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '[历史摘要] 单轮截尾后的摘要', is_show: false, kind: 'summary' },
      { role: 'assistant', content: '工具调用后的助手回复' },
    ];
    const assembled = await assembler.assemble('继续', current, [], { sessionId: 'sess_D' });

    expect(assembled.some((m) => typeof m.content === 'string' && m.content.includes('历史记忆片段'))).toBe(false);
    expect(assembled.find((m) => m.kind === 'summary')?.content).toBe('[历史摘要] 单轮截尾后的摘要');
  });

  // ===== 9. 记忆前缀哨兵剥离健壮性 =====
  it('1.21 记忆块含 markdown `---` 等分隔符时，strip 仍能精确还原原始 content', () => {
    const original = '我有什么技能';
    // 模拟 L2 检索结果：含 markdown 水平分割线、代码块等会与旧哨兵 `\n\n---\n\n` 冲突的内容
    const memoryBlock = [
      '## [2026-10-17T09:27:57.337Z] [scope: session] [tag: final_answer]用户: 帮我看下这个项目结构',
      '结果: # 📁 loop-agent-command 项目结构',
      '',
      '**项目定位**：基于 ReAct 循环的 TypeScript Agent 工具。',
      '',
      '---',
      '',
      '## 一、顶层目录结构',
      '',
      '```',
      'loop-agent-command/',
      '├── src/',
      '',
    ].join('\n');

    const injected = withMemorySection(memoryBlock, original);
    // 注入后以 HEAD 开头、原始 content 在末尾
    expect(injected.endsWith(original)).toBe(true);

    // 剥离应精确还原原始 content，不受记忆块内 `---` 干扰
    const stripped = stripMemorySection(injected);
    expect(stripped).toBe(original);
  });

  it('1.22 无记忆前缀的 content 原样返回，幂等剥离不破坏内容', () => {
    const plain = '普通用户输入，不含任何前缀';
    expect(stripMemorySection(plain)).toBe(plain);

    // 多次 strip 结果一致（幂等）
    expect(stripMemorySection(stripMemorySection(plain))).toBe(plain);
  });
});
