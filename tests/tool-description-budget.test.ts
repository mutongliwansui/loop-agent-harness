// 需求 20261111-003：锁住「面向模型」的工具描述预算与 C 档参数契约
//
// 工具 description + 参数 schema 随每轮请求发送，属于**常态成本**；
// 一旦有人再把实现细节写回 description，就会挤占会话上下文，故用预算断言防回潮。
// 口径与 WorkingMemory.estimateTokens 一致：token ≈ 字符数 / 4。
import { describe, it, expect, beforeAll } from 'vitest';
import { registry } from '../src/tools/registry.js';
import { registerBuiltinTools } from '../src/tools/index.js';

interface Def {
  function: {
    name: string;
    description?: string;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
  };
}

const EXPECTED_TOOLS = [
  'commandRun', 'commandStatus', 'commandLogs', 'commandStop',
  'fileRead', 'fileWrite', 'editFile', 'grep', 'activateSkill', 'delegate',
  'analyzeImage',
];

/** 精简后的实测基线：需求 20261111-003 后 4721 字符；20261111-004 四合一+驼峰后 4190 字符；
 *  20261112-001 新增 fileRead.pages 后约 4330 字符 */
const BUDGET_CHARS = 4400;
const BUDGET_TOKENS = 1100;
/** 单条 description 上限：长过这个数说明又在写使用手册 */
const MAX_DESC_CHARS = 200;
/** 单个参数 schema 上限（最重的是 editFile，673 字符） */
const MAX_PARAM_CHARS = 750;

let defs: Def[] = [];

function descOf(name: string): string {
  const d = defs.find((x) => x.function.name === name);
  if (!d) throw new Error(`未注册工具 ${name}`);
  return d.function.description ?? '';
}

function paramProps(name: string): Record<string, unknown> {
  const d = defs.find((x) => x.function.name === name);
  if (!d) throw new Error(`未注册工具 ${name}`);
  return d.function.parameters?.properties ?? {};
}

beforeAll(() => {
  // 视觉工具仅在 vision.enabled 时注册；这里全开以覆盖 analyzeImage
  registerBuiltinTools(undefined, { enabled: true } as never);
  defs = registry.toOpenAITools() as unknown as Def[];
});

describe('工具描述预算（需求 20261111-003）', () => {
  it('注册的工具集合与预期一致（新增/删除工具需同步本测试）', () => {
    expect(defs.map((d) => d.function.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('description + 参数 schema 总字符数不超预算', () => {
    const totalChars = defs.reduce((sum, d) => {
      const desc = d.function.description ?? '';
      const params = JSON.stringify(d.function.parameters ?? {});
      return sum + desc.length + params.length;
    }, 0);
    expect(totalChars).toBeLessThanOrEqual(BUDGET_CHARS);
  });

  it('按项目口径（字符数/4）估算的 tools 常态 token 不超预算', () => {
    const totalChars = defs.reduce((sum, d) => {
      const desc = d.function.description ?? '';
      const params = JSON.stringify(d.function.parameters ?? {});
      return sum + desc.length + params.length;
    }, 0);
    expect(Math.round(totalChars / 4)).toBeLessThanOrEqual(BUDGET_TOKENS);
  });

  it('每条 description 都非空且不超长度上限', () => {
    for (const d of defs) {
      const desc = d.function.description ?? '';
      expect(desc.length, `${d.function.name} 描述为空`).toBeGreaterThan(0);
      expect(desc.length, `${d.function.name} 描述过长`).toBeLessThanOrEqual(MAX_DESC_CHARS);
    }
  });

  it('每个参数 schema 不超长度上限', () => {
    for (const d of defs) {
      const chars = JSON.stringify(d.function.parameters ?? {}).length;
      expect(chars, `${d.function.name} 参数 schema 过长`).toBeLessThanOrEqual(MAX_PARAM_CHARS);
    }
  });
});

describe('C 档参数契约：fileRead 行范围只有 startLine/endLine', () => {
  it('参数只暴露 path/startLine/endLine/pages/maxBytes/encoding/lineNumbers', () => {
    // toOpenAITools() 会 canonicalize（key 按字典序重排，保前缀缓存），故比较排序后的集合
    expect(Object.keys(paramProps('fileRead')).sort()).toEqual([
      'encoding', 'endLine', 'lineNumbers', 'maxBytes', 'pages', 'path', 'startLine',
    ]);
  });

  it('description 不再出现已移除的 offset/limit 别名', () => {
    const desc = descOf('fileRead');
    expect(desc).not.toContain('offset');
    expect(desc).not.toContain('limit');
    expect(desc).toContain('startLine');
  });
});

describe('视觉工具的取舍规则下沉到 analyzeImage 的 description', () => {
  it('description 用一句话说明三种用法分流（只给 image / 给 question / 给 fields）', () => {
    const desc = descOf('analyzeImage');
    expect(desc).toContain('整体描述');
    expect(desc).toContain('question');
    expect(desc).toContain('fields');
  });

  it('参数契约：image 必填，question/fields 可选', () => {
    const d = defs.find((x) => x.function.name === 'analyzeImage');
    expect(d?.function.parameters?.required).toEqual(['image']);
    expect(Object.keys(paramProps('analyzeImage')).sort()).toEqual(['fields', 'image', 'question']);
  });
});
