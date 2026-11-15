/**
 * 行为声明与展示元信息的默认值口径。
 *
 * 这些断言锁的是**契约级默认值**：一旦有人把「缺省即可写」改成「缺省只读」，
 * 宿主侧的确认门禁就会静默放行危险工具，必须让测试先炸。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TOOL_ANNOTATIONS,
  DEFAULT_TOOL_TIMEOUT_MS,
  resolveAnnotations,
  ToolBase,
  type ToolAnnotations,
} from '../src/index.js';

/** 最小可实例化工具（只为拿 annotations getter） */
class NoAnnotationsTool extends ToolBase {
  constructor(annotations?: ToolAnnotations) {
    super({
      name: 'no-annotations',
      description: '测试用',
      parameters: { type: 'object', properties: {} },
      ...(annotations !== undefined ? { annotations } : {}),
    });
  }
  protected override execute(): string {
    return 'ok';
  }
}

describe('MCP 悲观默认值', () => {
  it('常量与 MCP 规范一致：read-only=false / destructive=true / idempotent=false / openWorld=true', () => {
    expect(DEFAULT_TOOL_ANNOTATIONS).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('未声明任何 annotations → 取悲观默认（缺省即最保守）', () => {
    expect(resolveAnnotations()).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('工具未声明 annotations → getter 补全为悲观默认', () => {
    const tool = new NoAnnotationsTool();
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

describe('resolveAnnotations 的补全语义', () => {
  it('显式 false 不被默认值覆盖', () => {
    expect(resolveAnnotations({ destructiveHint: false })).toMatchObject({
      destructiveHint: false,
      readOnlyHint: false,
    });
  });

  it('显式 true 生效', () => {
    expect(resolveAnnotations({ readOnlyHint: true, openWorldHint: false })).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  it('显式 undefined 视为未声明（回落默认）', () => {
    const result = resolveAnnotations({ destructiveHint: undefined });
    expect(result.destructiveHint).toBe(true);
  });

  it('title 未声明时不出现在结果里（不塞空串）', () => {
    expect('title' in resolveAnnotations({})).toBe(false);
    expect(resolveAnnotations({ title: '读文件' }).title).toBe('读文件');
  });

  it('部分声明时其余字段仍是悲观默认', () => {
    const result = resolveAnnotations({ readOnlyHint: true });
    expect(result).toEqual({
      readOnlyHint: true,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});

describe('默认超时', () => {
  it('DEFAULT_TOOL_TIMEOUT_MS 为 30_000（对齐 runner.ts:65）', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(30_000);
  });

  it('工具未声明 timeoutMs → getter 返回默认值', () => {
    expect(new NoAnnotationsTool().timeoutMs).toBe(30_000);
  });

  it('工具声明 timeoutMs → getter 返回声明值', () => {
    class SlowTool extends ToolBase {
      constructor() {
        super({
          name: 'slow',
          description: '慢工具',
          parameters: { type: 'object', properties: {} },
          timeoutMs: 120_000,
        });
      }
      protected override execute(): string {
        return 'ok';
      }
    }
    expect(new SlowTool().timeoutMs).toBe(120_000);
  });
});
