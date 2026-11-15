/**
 * 参数校验与序列化规范化。
 *
 * ## 为什么手写而不引 zod / ajv
 *
 * 工程默认约束「零三方运行时依赖」；且使用面很窄——只判断「模型给的参数是否
 * 符合 schema 的基本形状」，不做完整 JSON Schema 实现。所以：
 * - 只支持子集：type / properties / required / items / enum / minimum /
 *   maximum / minLength / maxLength / pattern / additionalProperties
 * - **超出子集的关键字一律跳过**（宽松），不会因用户写了 `oneOf` 就被拒
 *
 * ## canonicalize 为什么是契约的一部分
 *
 * 工具定义处于每轮请求的**前缀**位置，键序抖动会让 provider 侧前缀缓存整体
 * 失效——成本与延迟双升，且不报错、极难察觉。`src/tools/registry.ts:108-123`
 * 已实证该不变量，这里原样继承语义。
 */

import type { JsonSchema } from './types.js';

/** 单条校验问题 */
export interface ValidationIssue {
  /** 出错位置，如 `''`（根）/ `args.limit` / `args.items[0].name` */
  path: string;
  /** 人读说明 */
  message: string;
  /** 触发的 schema 关键字 */
  keyword: string;
}

/** 工具名合法性检查结果 */
export interface ToolNameCheck {
  ok: boolean;
  /** 不合法原因（ok=true 时不填） */
  reason?: string;
}

/**
 * 工具名规则：`^[A-Za-z0-9_-]{1,64}$`，且不以 `__` 开头。
 *
 * 为什么是 64 而不是 MCP 规范里的 128：三大厂商的 function name 实际限制
 * 一致取 64（Anthropic 放宽到 128，但 OpenAI 侧是硬 64），MCP 规范允许的
 * `.` 会被 OpenAI / Anthropic 直接拒。取**最低公共上限**是唯一安全解——
 * 否则会写出「本地能注册、上云每轮请求 400」的工具名，而 MCP 侧
 * `tools/list` 一切正常，根因排查成本极高。
 *
 * 为什么禁 `__` 前缀：主工程 MCP 适配用 `server__tool` 区分来源
 * （`src/tools/mcp/adapter.ts` 的 `buildToolName`）。该前缀永久保留给适配器，
 * 避免用户工具名与生成名撞车。
 */
export function validateToolName(name: unknown): ToolNameCheck {
  if (typeof name !== 'string') {
    return { ok: false, reason: `工具名必须是字符串，实际收到 ${typeof name}` };
  }
  if (name.trim() === '') {
    return { ok: false, reason: '工具名不能为空' };
  }
  if (name.startsWith('__')) {
    return { ok: false, reason: '工具名不得以 `__` 开头（该前缀保留给 MCP 适配器的命名空间）' };
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    const tooLong = name.length > 64;
    return {
      ok: false,
      reason: tooLong
        ? `工具名长度 ${name.length} 超过 64 字符上限（OpenAI / Bedrock / Gemini 的硬限制）`
        : '工具名只能包含字母、数字、下划线与连字符（不含点号、空格及其他字符）',
    };
  }
  return { ok: true };
}

/**
 * 参数 schema 必须是显式的 object 型。
 *
 * 为什么**强制显式** `type: 'object'` 而不是「缺省视为 object」：模型侧
 * function calling 要求参数的顶层是一个对象 schema，缺 `type` 的 schema
 * 在部分厂商（OpenAI 严格模式、Bedrock）会被直接拒。让错误发生在挂载期、
 * 并指向具体工具名，比留到每轮请求 400 好排查得多（与 D8 同理）。
 */
export function validateParametersSchema(parameters: unknown): ValidationIssue[] {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return [{ path: 'parameters', message: 'parameters 必须是 JSON Schema 对象', keyword: 'type' }];
  }
  const type = (parameters as Record<string, unknown>).type;
  if (type === undefined) {
    return [
      {
        path: 'parameters',
        message: "parameters 必须显式声明 type: 'object'（缺省不会被当作 object）",
        keyword: 'required',
      },
    ];
  }
  if (type !== 'object') {
    return [
      {
        path: 'parameters',
        message: `parameters 的 type 必须是 'object'，实际为 ${JSON.stringify(type)}`,
        keyword: 'type',
      },
    ];
  }
  return [];
}

/** 描述不能为空：模型靠它决定何时调用工具 */
export function validateDescription(description: unknown): ValidationIssue[] {
  if (typeof description !== 'string' || description.trim() === '') {
    return [{ path: 'description', message: 'description 不能为空', keyword: 'required' }];
  }
  return [];
}

/** 判断一个值的 JSON 类型 */
function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** 类型是否匹配声明（`integer` 与 `number` 兼容关系按 JSON Schema 语义） */
function typeMatches(declared: string, actual: string, value: unknown): boolean {
  if (declared === actual) return true;
  // number 接受整数值；integer 只接受整数
  if (declared === 'number' && actual === 'integer') return true;
  if (declared === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return false;
}

/** 递归校验单个值；问题累积到 issues */
function validateValue(
  schema: unknown,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return;
  const s = schema as Record<string, unknown>;

  // ── type ──
  const declaredType = s.type;
  if (typeof declaredType === 'string') {
    const actual = jsonTypeOf(value);
    if (!typeMatches(declaredType, actual, value)) {
      issues.push({
        path,
        message: `期望类型 ${declaredType}，实际 ${actual}`,
        keyword: 'type',
      });
      return; // 类型不符时后续关键字无意义
    }
  } else if (Array.isArray(declaredType)) {
    // 联合类型（子集外的宽松处理：任一匹配即可）
    const types = declaredType.filter((t): t is string => typeof t === 'string');
    const actual = jsonTypeOf(value);
    if (types.length > 0 && !types.some((t) => typeMatches(t, actual, value))) {
      issues.push({
        path,
        message: `期望类型 ${types.join(' | ')}，实际 ${actual}`,
        keyword: 'type',
      });
      return;
    }
  }

  // ── enum ──（仅对原始值有意义）
  if (Array.isArray(s.enum)) {
    const hit = s.enum.some((candidate) => Object.is(candidate, value));
    if (!hit) {
      issues.push({
        path,
        message: `取值必须是 ${s.enum.map((v) => JSON.stringify(v)).join(' / ')} 之一`,
        keyword: 'enum',
      });
    }
  }

  // ── 字符串约束 ──
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      issues.push({
        path,
        message: `长度不得少于 ${s.minLength}，实际 ${value.length}`,
        keyword: 'minLength',
      });
    }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
      issues.push({
        path,
        message: `长度不得超过 ${s.maxLength}，实际 ${value.length}`,
        keyword: 'maxLength',
      });
    }
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern).test(value)) {
          issues.push({ path, message: `不匹配正则 ${s.pattern}`, keyword: 'pattern' });
        }
      } catch {
        // 非法正则是 schema 作者的问题，不惩罚调用方：跳过
      }
    }
  }

  // ── 数值约束 ──
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) {
      issues.push({ path, message: `不得小于 ${s.minimum}，实际 ${value}`, keyword: 'minimum' });
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      issues.push({ path, message: `不得大于 ${s.maximum}，实际 ${value}`, keyword: 'maximum' });
    }
  }

  // ── 数组 items ──
  if (Array.isArray(value) && s.items !== undefined) {
    value.forEach((item, i) => validateValue(s.items, item, `${path}[${i}]`, issues));
  }

  // ── 对象 properties / required / additionalProperties ──
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties =
      s.properties !== null && typeof s.properties === 'object' && !Array.isArray(s.properties)
        ? (s.properties as Record<string, unknown>)
        : undefined;

    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key !== 'string') continue;
        if (!(key in obj)) {
          issues.push({
            path: path === '' ? key : `${path}.${key}`,
            message: '缺少必填参数',
            keyword: 'required',
          });
        }
      }
    }

    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in obj) {
          validateValue(propSchema, obj[key], path === '' ? key : `${path}.${key}`, issues);
        }
      }
    }

    // additionalProperties:false → 报告未声明字段；未声明该关键字时**原样放行**
    // （模型偶尔多加个无用字段不应导致整次调用失败）
    if (s.additionalProperties === false) {
      const allowed = new Set(properties ? Object.keys(properties) : []);
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          issues.push({
            path: path === '' ? key : `${path}.${key}`,
            message: '未在 parameters.properties 中声明的参数',
            keyword: 'additionalProperties',
          });
        }
      }
    }
  }
}

/** 校验实参是否符合参数 schema；返回问题清单（空数组＝通过） */
export function validateArgs(parameters: JsonSchema, args: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateValue(parameters, args, '', issues);
  return issues;
}

/** 把问题清单渲染成一段人读文本（供 `invoke()` 返回给模型） */
export function formatIssues(issues: ValidationIssue[], limit = 10): string {
  const shown = issues.slice(0, limit);
  const lines = shown.map((i) => `- ${i.path === '' ? '(根)' : i.path}: ${i.message}`);
  if (issues.length > shown.length) {
    lines.push(`- …另有 ${issues.length - shown.length} 处问题未列出`);
  }
  return lines.join('\n');
}

/**
 * 递归键序规范化：对象键按字典序排序，数组按元素递归。
 *
 * 目的不是「好看」，而是让**等价的 schema 产出逐字节相同的序列化结果**，
 * 从而命中模型前缀缓存。语义与 `src/tools/registry.ts:15-24` 完全一致。
 */
export function canonicalize<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => canonicalize(v)) as unknown as T;
  const source = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    result[key] = canonicalize(source[key]);
  }
  return result as unknown as T;
}
