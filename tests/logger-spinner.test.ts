/**
 * ConsoleLogger 与 Spinner 协作测试（Task-20260930-001 P0）
 *
 * 覆盖验收项：
 * - 6.6 任一 console.log 触发前，Spinner.stop() 已被调用（无混行）
 * - 6.7 onWarning / onLLMStats / onLLMStatsSummary 亦先 stop()
 * - 6.8 verbose=false 时 onLLMStream 不 stop()
 * - 6.9 起停独立于 verbose（verbose=false 仍能看到 loading 文案）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConsoleLogger } from '../src/agent/logger.js';
import type { Spinner } from '../src/ui/spinner.js';
import type { LLMStats, LLMStatsSummary, CompactionInfo } from '../src/types.js';

/**
 * 构造假 Spinner + 打印事件顺序记录
 * order 记录全序列：'stop' / 'start:<文案>' / 'update:<文案>' / 'log' / 'error'
 */
function setup() {
  const order: string[] = [];
  const spinner = {
    stop: () => {
      order.push('stop');
    },
    start: (t: string) => {
      order.push(`start:${t}`);
    },
    update: (t: string) => {
      order.push(`update:${t}`);
    },
    get isActive() {
      return false;
    },
  } as unknown as Spinner;
  vi.spyOn(console, 'log').mockImplementation(() => {
    order.push('log');
  });
  vi.spyOn(console, 'error').mockImplementation(() => {
    order.push('error');
  });
  return { spinner, order };
}

function makeStats(overrides: Partial<LLMStats> = {}): LLMStats {
  return {
    iteration: 0,
    maxIterations: 5,
    contextTokens: 3214,
    contextMaxTokens: 8000,
    contextThreshold: 6400,
    promptTokens: 2588,
    completionTokens: 412,
    totalTokens: 3000,
    cacheHitRate: 0.72,
    elapsedMs: 1200,
    ...overrides,
  };
}

function makeSummary(): LLMStatsSummary {
  return {
    iterations: 2,
    totalPrompt: 3000,
    totalCompletion: 500,
    totalTokens: 3500,
    totalCacheHit: 1500,
    avgCacheHitRate: 0.5,
    peakContextTokens: 4500,
    peakContextMaxTokens: 8000,
  };
}

function makeCompaction(): CompactionInfo {
  return {
    threshold: 4000,
    contextTokens: 4967,
    flushedChars: 1234,
    keptMessages: 7,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConsoleLogger × Spinner：打印前先停', () => {
  it('onToolStart：先 stop → 打印 [Action] → start 执行中', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onToolStart('grep', { pattern: 'x' });

    expect(order).toEqual(['stop', 'log', 'start:执行中：grep…']);
  });

  it('onToolEnd 打印 [Observation] 前先 stop', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onToolEnd('grep', 'result');

    expect(order[0]).toBe('stop');
    expect(order[1]).toBe('log');
  });

  it('onCompaction：先 stop → 打印 [记忆] → start 思考中', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onCompaction(makeCompaction());

    expect(order).toEqual(['stop', 'log', 'start:思考中…']);
  });
});

describe('ConsoleLogger × Spinner：6.7 特殊打印事件', () => {
  it('onWarning 打印前先 stop（不混行）', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onWarning({ level: 'warning', message: '会话保存失败' });

    expect(order[0]).toBe('stop');
    expect(order[1]).toBe('error');
  });

  it('onLLMStats 打印前先 stop', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onLLMStats(makeStats());

    expect(order[0]).toBe('stop');
    expect(order[1]).toBe('log');
  });

  it('onLLMStatsSummary 打印前先 stop', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onLLMStatsSummary(makeSummary());

    expect(order[0]).toBe('stop');
    expect(order[1]).toBe('log');
  });

  it('onFinal / onError / onEnd 均会 stop', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onFinal('答案');
    logger.onError(new Error('boom'));
    logger.onEnd(null);

    expect(order.filter((c) => c === 'stop').length).toBe(3);
  });
});

describe('ConsoleLogger × Spinner：与 verbose 解耦', () => {
  it('6.8 verbose=false 时 onLLMStream 不 stop（指示器持续运转）', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(false, true, spinner);

    logger.onLLMStream('delta');

    expect(order).not.toContain('stop');
    expect(order).toHaveLength(0);
  });

  it('6.8 verbose=true 时 onLLMStream 会 stop', () => {
    const { spinner, order } = setup();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onLLMStream('delta');

    expect(order[0]).toBe('stop');
    writeSpy.mockRestore();
  });

  it('6.9 verbose=false 时仍启动 loading（onStart / onIterationStart / onToolStart）', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(false, true, spinner);

    logger.onStart('hi');
    logger.onIterationStart(0, 3);
    logger.onToolStart('grep', {});

    // verbose=false 时不再产生无谓 stop，只校验 loading 文案确实被启动
    const starts = order.filter((c) => c.startsWith('start:'));
    expect(starts).toEqual([
      'start:思考中…',
      'start:思考中…（第 1 轮）',
      'start:执行中：grep…',
    ]);
  });
});

describe('ConsoleLogger × Spinner：P1 4.6 文案打磨', () => {
  it('多工具并发时合并为「执行中：a、b…」', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onIterationStart(0, 3);
    logger.onToolStart('grep', {});
    logger.onToolStart('fileRead', {});

    const starts = order.filter((c) => c.startsWith('start:'));
    expect(starts[starts.length - 1]).toBe('start:执行中：grep、fileRead…');
  });

  it('过长工具名被截断', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);
    logger.onIterationStart(0, 3);
    const long = 'x'.repeat(50);

    logger.onToolStart(long, {});

    const starts = order.filter((c) => c.startsWith('start:'));
    const label = starts[starts.length - 1];
    expect(label).toContain('…');
    expect(label).not.toContain(long);
  });

  it('新迭代重置本轮工具名单', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onIterationStart(0, 3);
    logger.onToolStart('grep', {});
    logger.onIterationStart(1, 3);
    logger.onToolStart('fileRead', {});

    const starts = order.filter((c) => c.startsWith('start:'));
    expect(starts[starts.length - 1]).toBe('start:执行中：fileRead…');
  });
});

describe('ConsoleLogger × Spinner：P1 4.8 消除无谓闪动', () => {
  it('verbose=false 时 onIterationStart / onToolStart / onCompaction 不产生 stop', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(false, true, spinner);

    logger.onIterationStart(0, 3);
    logger.onToolStart('grep', {});
    logger.onCompaction(makeCompaction());

    expect(order).not.toContain('stop');
    const starts = order.filter((c) => c.startsWith('start:'));
    expect(starts).toEqual([
      'start:思考中…（第 1 轮）',
      'start:执行中：grep…',
      'start:思考中…',
    ]);
  });

  it('verbose=false 时 onLLMStream / onLLMEnd 不 stop（指示器连续运转）', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(false, true, spinner);

    logger.onLLMStream('delta');
    logger.onLLMEnd({ content: 'x', finish_reason: 'stop' });

    expect(order).not.toContain('stop');
  });
});

describe('ConsoleLogger × Spinner：P2 4.11 工具进度心跳', () => {
  it('onToolProgress 更新文案并附带已用时', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onIterationStart(0, 3);
    logger.onToolStart('commandRun', {});
    logger.onToolProgress('commandRun', 3000);

    const updates = order.filter((c) => c.startsWith('update:'));
    expect(updates[updates.length - 1]).toBe('update:执行中：commandRun…（3s）');
  });
});

describe('ConsoleLogger × Spinner：方案 1 生成参数进度', () => {
  it('onToolCallDelta 刷新为「生成参数：…（体积 / 用时）」且不 stop', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onToolCallDelta('fileWrite', 2048, 3200);

    expect(order).toEqual(['start:生成参数：fileWrite…（2.0KB / 3s）']);
  });

  it('小体量显示 B；不足 1s 不显示用时', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onToolCallDelta('grep', 512, 400);

    expect(order).toEqual(['start:生成参数：grep…（512B）']);
  });

  it('verbose=false 时同样刷新文案且不 stop（连续运转）', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(false, true, spinner);

    logger.onToolCallDelta('fileWrite', 100, 200);

    expect(order).toEqual(['start:生成参数：fileWrite…（100B）']);
  });

  it('过长工具名同样截断', () => {
    const { spinner, order } = setup();
    const logger = new ConsoleLogger(true, true, spinner);

    logger.onToolCallDelta('x'.repeat(50), 10, 0);

    const [entry] = order;
    expect(entry).toContain('…');
    expect(entry).not.toContain('x'.repeat(50));
  });
});
