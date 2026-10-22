// 20261021-008 缓存命中率优化：R1（L2 run 级缓存）+ R3（system 统一构建）+ R4（run 级冻结）单测
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextAssembler } from '../src/memory/context.js';
import type { CuratedMemory } from '../src/memory/curated.js';
import type { EpisodicMemory } from '../src/memory/episodic.js';
import type { MemorySearchResult } from '../src/memory/types.js';

/** 构造 CuratedMemory mock：buildSystemPrompt 返回固定内容 */
function makeCuratedMock(content = '# USER\n- 测试用户'): CuratedMemory {
  return {
    buildSystemPrompt: vi.fn().mockResolvedValue(content),
  } as unknown as CuratedMemory;
}

/** 构造 EpisodicMemory mock：search 返回可配置结果，spy 统计调用次数 */
function makeEpisodicMock(results: MemorySearchResult[] = []) {
  return {
    search: vi.fn().mockResolvedValue(results),
  } as unknown as EpisodicMemory;
}

function msg(role: 'user' | 'assistant' | 'tool', content: string, extra: Record<string, unknown> = {}) {
  return { role, content, ...extra } as Parameters<ContextAssembler['assemble']>[1][number];
}

describe('20261021-008 R1：L2 检索结果 run 级缓存', () => {
  let episodic: EpisodicMemory;
  let assembler: ContextAssembler;
  const searchResults: MemorySearchResult[] = [
    { content: '记忆条目 A', score: 0.9 },
    { content: '记忆条目 B', score: 0.8 },
  ];

  beforeEach(() => {
    episodic = makeEpisodicMock(searchResults);
    assembler = new ContextAssembler(makeCuratedMock(), episodic);
  });

  it('同 userMessage+sessionId 两次调用：检索只调一次，产物逐字节一致', async () => {
    const messages = [msg('user', '帮我分析这段代码')];
    const opts = { sessionId: 'sess_a' } as const;

    const first = await assembler.assemble('帮我分析这段代码', messages, [], opts);
    const second = await assembler.assemble('帮我分析这段代码', messages, [], opts);

    expect(episodic.search).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // 首次调用有注入
    expect(JSON.stringify(first)).toContain('记忆条目 A');
  });

  it('不同 userMessage 重新检索（新 run 天然失效）', async () => {
    const messages = [msg('user', '问题一')];
    await assembler.assemble('问题一', messages, [], { sessionId: 'sess_a' });
    await assembler.assemble('问题二', [msg('user', '问题二')], [], { sessionId: 'sess_a' });
    expect(episodic.search).toHaveBeenCalledTimes(2);
  });

  it('sessionId 不同不串缓存', async () => {
    const messages = [msg('user', '同一句话')];
    await assembler.assemble('同一句话', messages, [], { sessionId: 'sess_a' });
    await assembler.assemble('同一句话', messages, [], { sessionId: 'sess_b' });
    expect(episodic.search).toHaveBeenCalledTimes(2);
  });

  it('检索结果为空（超时/失败）也冻结：第二轮不再重检索、保持无注入形态', async () => {
    (episodic.search as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const messages = [msg('user', '冷门问题')];
    const first = await assembler.assemble('冷门问题', messages, [], { sessionId: 'sess_a' });
    // safeSearch 本身含「会话优先 + 全局兜底」两次底层调用；首轮后调用数应固定
    const callsAfterFirst = (episodic.search as ReturnType<typeof vi.fn>).mock.calls.length;
    const second = await assembler.assemble('冷门问题', messages, [], { sessionId: 'sess_a' });
    // R1 冻结：第二轮不再新增任何底层检索调用
    expect((episodic.search as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // 空结果 → 不注入记忆前缀
    expect((first.find(m => m.role === 'user') as { content: string }).content).toBe('冷门问题');
  });

  it('缓存命中路径产物与冷启动路径逐字节一致（走同一组装函数）', async () => {
    const messages = [msg('user', '问题'), msg('assistant', '', { tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] }), msg('tool', '结果', { tool_call_id: 't1' })];
    const opts = { sessionId: 'sess_a' } as const;
    const cold = await assembler.assemble('问题', messages, [], opts);
    // 模拟同 run 第二轮：messages 增加了新 tool 消息（尾部追加，user 消息不变）
    const grown = [...messages, msg('assistant', '继续'), msg('user', '', { is_show: false })];
    const warm = await assembler.assemble('问题', grown, [], opts);
    expect(episodic.search).toHaveBeenCalledTimes(1);
    // user 消息的注入前缀完全一致（前缀稳定 → LLM 侧可命中）
    const coldUser = cold.find(m => m.role === 'user') as { content: string };
    const warmUser = warm.filter(m => m.role === 'user' && m.is_show !== false).at(-1) as { content: string };
    expect(warmUser.content.startsWith(coldUser.content)).toBe(true);
  });
});

describe('20261021-008 R3：system prompt 统一构建', () => {
  it('传 systemPrompt 时：assemble 产物 system 段与传入值字节级一致（不再自建）', async () => {
    const curated = makeCuratedMock('# USER\n- 记忆');
    const episodic = makeEpisodicMock([]);
    const assembler = new ContextAssembler(curated, episodic);
    const custom = '自定义 system prompt（含环境信息与视觉段）';
    const out = await assembler.assemble('问题', [msg('user', '问题')], [], { systemPrompt: custom });
    const system = out.find(m => m.role === 'system') as { content: string };
    expect(system.content.startsWith(custom)).toBe(true);
  });

  it('不传 systemPrompt 时回退 buildSystemPrompt(skills)（旧行为兼容）', async () => {
    const episodic = makeEpisodicMock([]);
    const assembler = new ContextAssembler(makeCuratedMock(), episodic);
    const out = await assembler.assemble('问题', [msg('user', '问题')], []);
    const system = out.find(m => m.role === 'system') as { content: string };
    expect(system.content).toContain('ReAct');
  });
});

describe('R4：run 级冻结', () => {
  it('同 run 内 memoryBlock 冻结后，检索结果集后续变化不影响本轮视图', async () => {
    const episodic = makeEpisodicMock([{ content: '首轮记忆', score: 1 }]);
    const assembler = new ContextAssembler(makeCuratedMock(), episodic);
    const messages = [msg('user', '问题')];
    const first = await assembler.assemble('问题', messages, [], { sessionId: 'sess_a' });
    // 模拟工具写入 L2 后检索结果变化
    (episodic.search as ReturnType<typeof vi.fn>).mockResolvedValue([{ content: '工具新写入的记忆', score: 1 }]);
    const second = await assembler.assemble('问题', messages, [], { sessionId: 'sess_a' });
    expect(episodic.search).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(second)).not.toContain('工具新写入的记忆');
  });
});
