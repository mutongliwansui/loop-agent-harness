// 子 Agent 过程区纯逻辑单测（需求 20261107-003）
import { describe, expect, it } from 'vitest';
import {
  fmtSecs,
  groupProcessIterations,
  processFinal,
  processMeta,
  processToolState,
  type ProcessTrace,
} from '../webui/src/subagent-process.js';

function trace(overrides: Partial<ProcessTrace> = {}): ProcessTrace {
  return {
    status: 'done',
    iterations: 2,
    think: [
      { iteration: 1, text: '先定位记忆模块实现' },
      { iteration: 2, text: '确认压缩阈值来源' },
    ],
    tools: [
      { name: 'fileRead', args: { path: 'src/memory/index.ts', startLine: 1, endLine: 120 }, elapsedMs: 1200, ok: true, iteration: 1, result: 'code' },
      { name: 'grep', args: { pattern: 'compact', path: 'src/memory' }, elapsedMs: 800, ok: true, iteration: 1, result: 'hit' },
      { name: 'commandRun', args: { command: 'npm test' }, elapsedMs: 6100, ok: false, iteration: 2, result: 'exit 1' },
    ],
    final: '三层记忆形态',
    startedAt: 1000,
    ...overrides,
  };
}

describe('groupProcessIterations：按轮分组并复用工具元信息', () => {
  it('轮次拆分：思考与工具各归其轮', () => {
    const rows = groupProcessIterations(trace());
    expect(rows).toHaveLength(2);
    expect(rows[0].think.map((x) => x.text)).toEqual(['先定位记忆模块实现']);
    expect(rows[0].tools.map((x) => x.zh)).toEqual(['读取文件', '搜索内容']);
    expect(rows[1].tools.map((x) => x.zh)).toEqual(['执行命令']);
  });

  it('工具行：中文名 + 语义摘要 + 图标 + 耗时，不出现原始 JSON', () => {
    const rows = groupProcessIterations(trace());
    const read = rows[0].tools[0];
    expect(read.zh).toBe('读取文件');
    expect(read.brief).toBe('index.ts（1-120 行）');
    expect(read.iconSvg.startsWith('<svg ')).toBe(true);
    expect(read.elapsedMs).toBe(1200);
    expect(read.brief).not.toContain('"path"');
  });

  it('缺少 iteration 的工具归入当前轮；未知工具回退英文名', () => {
    const rows = groupProcessIterations(
      trace({ tools: [{ name: 'someFutureTool', args: { a: 1 }, result: 'ok' }] }),
    );
    const last = rows[rows.length - 1];
    expect(last.tools[0].zh).toBe('someFutureTool');
    expect(last.tools[0].brief).toBe('{"a":1}');
  });

  it('args 为空/异常时摘要不崩溃', () => {
    const rows = groupProcessIterations(trace({ tools: [{ name: 'fileRead' }] }));
    expect(rows[0].tools[0].brief).toBe('');
  });
});

describe('processToolState：失败优先，其次运行中', () => {
  it('ok=false → fail；无 result 且 live → run；否则 ok', () => {
    expect(processToolState({ name: 'x', ok: false, result: 'e' }, true)).toBe('fail');
    expect(processToolState({ name: 'x', ok: true, result: '' }, true)).toBe('ok');
    expect(processToolState({ name: 'x' }, true)).toBe('run');
    expect(processToolState({ name: 'x' }, false)).toBe('ok');
  });

  it('interrupted 不再显示运行中', () => {
    const rows = groupProcessIterations(trace({ status: 'running', tools: [{ name: 'fileRead' }] }), 'interrupted');
    expect(rows[0].tools[0].state).toBe('ok');
  });
});

describe('processMeta / processFinal / fmtSecs', () => {
  it('元信息：轮数 · 步数 · 耗时', () => {
    expect(processMeta(trace(), 42000)).toBe('2 轮 · 3 步 · 42s');
  });

  it('结论：trace.final 优先于 answer；都为空返回空串', () => {
    expect(processFinal(trace(), 'answer')).toBe('三层记忆形态');
    expect(processFinal(trace({ final: '' }), 'answer')).toBe('answer');
    expect(processFinal(trace({ final: '' }))).toBe('');
  });

  it('秒数格式与主对话一致', () => {
    expect(fmtSecs(1200)).toBe('1.2s');
    expect(fmtSecs(42000)).toBe('42s');
    expect(fmtSecs(-1)).toBe('0.0s');
  });
});
