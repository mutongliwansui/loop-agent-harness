/**
 * 参数校验子集与键序规范化。
 *
 * 两条主线：
 * 1. `validateArgs()` 的**宽松策略**——覆盖子集，超出子集的关键字跳过而非报错；
 * 2. `canonicalize()` 的**前缀缓存不变量**——等价 schema 必须产出逐字节相同结果。
 */

import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  formatIssues,
  validateArgs,
  validateDescription,
  validateParametersSchema,
  validateToolName,
} from '../src/index.js';

/** 断言校验通过（无问题） */
function ok(parameters: Record<string, unknown>, args: unknown): void {
  expect(validateArgs(parameters, args)).toEqual([]);
}

/** 断言校验失败并返回问题清单 */
function bad(parameters: Record<string, unknown>, args: unknown) {
  const issues = validateArgs(parameters, args);
  expect(issues.length).toBeGreaterThan(0);
  return issues;
}

describe('validateToolName（D8 幂等字符集与长度）', () => {
  it('合法名通过', () => {
    for (const name of ['fileRead', 'file_read', 'file-read', 'a', 'A1', 'x'.repeat(64)]) {
      expect(validateToolName(name).ok, name).toBe(true);
    }
  });

  it('含 `.` 拒绝（OpenAI/Anthropic 会 400）', () => {
    expect(validateToolName('my.tool').ok).toBe(false);
  });

  it('含空格拒绝', () => {
    expect(validateToolName('my tool').ok).toBe(false);
  });

  it('超过 64 字符拒绝', () => {
    expect(validateToolName('x'.repeat(65)).ok).toBe(false);
    expect(validateToolName('x'.repeat(65)).reason).toContain('64');
  });

  it('空串与纯空白拒绝', () => {
    expect(validateToolName('').ok).toBe(false);
    expect(validateToolName('   ').ok).toBe(false);
  });

  it('`__` 前缀拒绝（保留给 MCP 适配器命名空间）', () => {
    const result = validateToolName('__server__tool');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('__');
  });

  it('单个下划线前缀合法（不同于双下划线）', () => {
    expect(validateToolName('_private').ok).toBe(true);
  });

  it('非字符串拒绝', () => {
    expect(validateToolName(123).ok).toBe(false);
    expect(validateToolName(null).ok).toBe(false);
    expect(validateToolName(undefined).ok).toBe(false);
  });

  it('中文名拒绝（非 ASCII 字符集）', () => {
    expect(validateToolName('读文件').ok).toBe(false);
  });
});

describe('validateDescription / validateParametersSchema', () => {
  it('description 为空串报问题（模型靠它决定何时调用）', () => {
    expect(validateDescription('')).not.toEqual([]);
    expect(validateDescription('   ')).not.toEqual([]);
  });

  it('description 非空通过', () => {
    expect(validateDescription('读取文件')).toEqual([]);
  });

  it('parameters 必须是 object 型 schema', () => {
    expect(validateParametersSchema({ type: 'object', properties: {} })).toEqual([]);
    expect(validateParametersSchema({ type: 'string' })).not.toEqual([]);
    expect(validateParametersSchema({})).not.toEqual([]);
  });

  it('parameters 非对象报问题', () => {
    expect(validateParametersSchema(null)).not.toEqual([]);
    expect(validateParametersSchema('x')).not.toEqual([]);
  });
});

describe('validateArgs：type / required', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      limit: { type: 'integer' },
    },
    required: ['path'],
  };

  it('符合 schema 通过', () => {
    ok(schema, { path: '/a', limit: 3 });
  });

  it('缺必填参数报问题且路径指向参数名', () => {
    const issues = bad(schema, {});
    expect(issues.some((i) => i.path === 'path')).toBe(true);
  });

  it('类型不符报问题', () => {
    const issues = bad(schema, { path: 123 });
    expect(issues[0]!.path).toBe('path');
    expect(issues[0]!.keyword).toBe('type');
  });

  it('integer 拒绝小数', () => {
    bad(schema, { path: '/a', limit: 1.5 });
  });

  it('number 接受整数与小数', () => {
    ok({ type: 'object', properties: { n: { type: 'number' } } }, { n: 1 });
    ok({ type: 'object', properties: { n: { type: 'number' } } }, { n: 1.5 });
  });

  it('boolean / array / null 各类型', () => {
    ok({ type: 'object', properties: { b: { type: 'boolean' } } }, { b: true });
    ok({ type: 'object', properties: { a: { type: 'array' } } }, { a: [1, 2] });
    ok({ type: 'object', properties: { z: { type: 'null' } } }, { z: null });
  });

  it('未声明字段在无 additionalProperties:false 时放行', () => {
    ok(schema, { path: '/a', extra: 'whatever' });
  });
});

describe('validateArgs：enum / 数值范围 / 字符串约束', () => {
  it('enum 越界报问题', () => {
    const issues = bad({ type: 'object', properties: { m: { enum: ['a', 'b'] } } }, { m: 'c' });
    expect(issues[0]!.keyword).toBe('enum');
  });

  it('enum 命中通过', () => {
    ok({ type: 'object', properties: { m: { enum: ['a', 'b'] } } }, { m: 'b' });
  });

  it('minimum / maximum 边界', () => {
    const schema = { type: 'object', properties: { n: { type: 'number', minimum: 1, maximum: 5 } } };
    ok(schema, { n: 1 });
    ok(schema, { n: 5 });
    bad(schema, { n: 0 });
    bad(schema, { n: 6 });
  });

  it('minLength / maxLength', () => {
    const schema = {
      type: 'object',
      properties: { s: { type: 'string', minLength: 2, maxLength: 4 } },
    };
    ok(schema, { s: 'ab' });
    ok(schema, { s: 'abcd' });
    bad(schema, { s: 'a' });
    bad(schema, { s: 'abcde' });
  });

  it('pattern 不匹配报问题', () => {
    const schema = { type: 'object', properties: { s: { type: 'string', pattern: '^a+$' } } };
    ok(schema, { s: 'aaa' });
    bad(schema, { s: 'bbb' });
  });

  it('pattern 非法正则不抛异常（宽松跳过）', () => {
    const schema = { type: 'object', properties: { s: { type: 'string', pattern: '([' } } };
    expect(() => validateArgs(schema, { s: 'x' })).not.toThrow();
  });
});

describe('validateArgs：items / additionalProperties', () => {
  it('items 逐元素校验，路径带下标', () => {
    const schema = {
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'string' } } },
    };
    ok(schema, { list: ['a', 'b'] });
    const issues = bad(schema, { list: ['a', 1] });
    expect(issues[0]!.path).toContain('[1]');
  });

  it('additionalProperties:false 报告未声明字段', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    const issues = bad(schema, { a: 'x', b: 'y' });
    expect(issues[0]!.keyword).toBe('additionalProperties');
    expect(issues[0]!.path).toBe('b');
  });

  it('嵌套对象路径用点分', () => {
    const schema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'string' } },
        },
      },
    };
    const issues = bad(schema, { outer: { inner: 1 } });
    expect(issues[0]!.path).toBe('outer.inner');
  });
});

describe('validateArgs：超出子集的关键字宽松跳过', () => {
  it('oneOf / anyOf / $ref / if-then-else 不报错', () => {
    const schema = {
      type: 'object',
      properties: {
        x: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        y: { $ref: '#/definitions/y' },
        z: { anyOf: [{ type: 'string' }] },
      },
      if: { properties: { x: { const: 'a' } } },
      then: { required: ['y'] },
    };
    // 只要 type/properties 这一层能校验通过就应放行
    expect(() => validateArgs(schema, { x: 'v', y: 1, z: 's' })).not.toThrow();
  });

  it('format 关键字被忽略（字符串仍按 type 校验）', () => {
    ok({ type: 'object', properties: { u: { type: 'string', format: 'uri' } } }, { u: '不是URI' });
  });
});

describe('formatIssues', () => {
  it('渲染为多行文本，根路径显示为 (根)', () => {
    const text = formatIssues([{ path: '', message: '根有问题', keyword: 'type' }]);
    expect(text).toContain('(根)');
    expect(text).toContain('根有问题');
  });

  it('超过上限时列出省略提示', () => {
    const issues = Array.from({ length: 15 }, (_, i) => ({
      path: `f${i}`,
      message: '错',
      keyword: 'type',
    }));
    const text = formatIssues(issues, 10);
    expect(text).toContain('另有 5 处问题');
  });
});

describe('canonicalize（D12 前缀缓存不变量）', () => {
  it('键序不同的等价对象产出逐字节相同 JSON', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(JSON.stringify(canonicalize(a))).toBe(JSON.stringify(canonicalize(b)));
  });

  it('数组元素递归规范化，保持顺序（顺序有语义）', () => {
    const result = canonicalize({ list: [{ z: 1, y: 2 }, { y: 3, z: 4 }] });
    expect(JSON.stringify(result)).toBe('{"list":[{"y":2,"z":1},{"y":3,"z":4}]}');
  });

  it('原始值与 null 原样返回', () => {
    expect(canonicalize(null)).toBeNull();
    expect(canonicalize(42)).toBe(42);
    expect(canonicalize('x')).toBe('x');
    expect(canonicalize(true)).toBe(true);
  });

  it('不修改入参（纯函数）', () => {
    const source = { b: 1, a: 2 };
    canonicalize(source);
    expect(Object.keys(source)).toEqual(['b', 'a']);
  });

  it('真实 schema 两份键序不同 → 序列化一致', () => {
    const s1 = {
      type: 'object',
      properties: { path: { type: 'string', description: '路径' } },
      required: ['path'],
    };
    const s2 = {
      required: ['path'],
      properties: { path: { description: '路径', type: 'string' } },
      type: 'object',
    };
    expect(JSON.stringify(canonicalize(s1))).toBe(JSON.stringify(canonicalize(s2)));
  });
});
