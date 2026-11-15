/**
 * 类型契约：把「公开类型长什么样」钉住，防止有人顺手删字段/改可选性。
 *
 * 运行期断言只做浅检查，真正的锁在**编译期**——本文件能被 tsc 通过
 * 本身就是断言：字段缺失、可选性收紧都会让 `tsc --noEmit` 失败。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TOOL_ANNOTATIONS,
  DEFAULT_TOOL_TIMEOUT_MS,
  resolveAnnotations,
  type JsonSchema,
  type ToolAnnotations,
  type ToolDefView,
  type ToolDisplay,
  type ToolInvokeContext,
  type ToolResult,
  type ToolSpec,
} from '../src/index.js';
import type { ToolsEvents } from '../src/events.js';

describe('ToolSpec', () => {
  it('必填 name/description/parameters，其余可选', () => {
    const minimal: ToolSpec = {
      name: 'x',
      description: '说明',
      parameters: { type: 'object', properties: {} },
    };
    expect(minimal.name).toBe('x');

    const full: ToolSpec = {
      ...minimal,
      annotations: { title: '展示标题', readOnlyHint: true },
      display: { label: '展示名', icon: 'file', paramLabels: { a: '甲' } },
      timeoutMs: 5_000,
    };
    expect(full.annotations?.title).toBe('展示标题');
    expect(full.annotations?.readOnlyHint).toBe(true);
    expect(full.display?.icon).toBe('file');
    expect(full.timeoutMs).toBe(5_000);
  });
});

describe('ToolResult', () => {
  it('text 必填，isError 与 structured 可选', () => {
    const minimal: ToolResult = { text: 'ok' };
    const full: ToolResult = { text: 'ok', isError: false, structured: { a: 1 } };
    expect(minimal.text).toBe('ok');
    expect(full.structured).toEqual({ a: 1 });
  });
});

describe('ToolDefView', () => {
  it('恰好三字段（模型侧最小信息集）', () => {
    const def: ToolDefView = {
      name: 'x',
      description: 'd',
      parameters: { type: 'object' },
    };
    // 不允许有第四个必填字段：模型侧只吃这三样
    expect(Object.keys(def)).toHaveLength(3);
  });
});

describe('ToolInvokeContext', () => {
  it('全部可选，空对象合法', () => {
    const empty: ToolInvokeContext = {};
    expect(empty).toEqual({});

    const full: ToolInvokeContext = {
      signal: new AbortController().signal,
      metadata: { sessionId: 's' },
    };
    expect(full.metadata?.sessionId).toBe('s');
  });
});

describe('ToolAnnotations', () => {
  it('四个 hint 均可选', () => {
    const empty: ToolAnnotations = {};
    expect(empty).toEqual({});
  });

  it('DEFAULT_TOOL_ANNOTATIONS 是悲观默认（未知即危险）', () => {
    expect(DEFAULT_TOOL_ANNOTATIONS).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('resolveAnnotations 用默认补全缺失项', () => {
    expect(resolveAnnotations(undefined)).toEqual(DEFAULT_TOOL_ANNOTATIONS);
    expect(resolveAnnotations({ readOnlyHint: true })).toEqual({
      ...DEFAULT_TOOL_ANNOTATIONS,
      readOnlyHint: true,
    });
    // 显式 false 不被默认值覆盖
    expect(resolveAnnotations({ destructiveHint: false }).destructiveHint).toBe(false);
  });
});

describe('ToolDisplay', () => {
  it('label / icon / paramLabels 均可选', () => {
    const d: ToolDisplay = {};
    expect(d).toEqual({});
    expect({ label: '读文件', icon: 'file', paramLabels: { path: '路径' } }).toBeDefined();
  });
});

describe('JsonSchema', () => {
  it('允许任意 JSON Schema 片段（不锁死子集）', () => {
    const schemas: JsonSchema[] = [
      { type: 'object' },
      { type: 'array', items: { type: 'string' } },
      { type: 'object', properties: { a: { type: 'number', minimum: 0 } }, required: ['a'] },
      { oneOf: [{ type: 'string' }, { type: 'number' }] },
    ];
    expect(schemas).toHaveLength(4);
  });
});

describe('ToolsEvents', () => {
  it('五个事件名固定（改名字是破坏性变更）', () => {
    // 编译期断言：这些键必须存在
    type Keys = keyof ToolsEvents;
    const keys: Keys[] = [
      'tools/registered',
      'tools/unregistered',
      'tools/invoke',
      'tools/result',
      'tools/error',
    ];
    expect(keys).toHaveLength(5);
  });
});

describe('超时常量', () => {
  it('DEFAULT_TOOL_TIMEOUT_MS 是合理量级（秒级到十分钟级）', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBeLessThanOrEqual(600_000);
  });
});
