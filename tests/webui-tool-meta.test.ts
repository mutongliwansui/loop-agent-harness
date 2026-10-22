// tool-meta 单测（Task-20261022-001）：映射层纯函数无 DOM 依赖，可在 Node vitest 下直测
import { describe, expect, it } from 'vitest';
import {
  compactJson,
  prettyJson,
  RESULT_EXPAND_THRESHOLD,
  stripAnsi,
  toolDisplay,
  toolParamRows,
  toolResultLooksFailed,
  toolSummary,
} from '../webui/src/tool-meta.js';

describe('toolDisplay：工具名 → 图标 + 中文名', () => {
  it('已知工具返回中文映射', () => {
    expect(toolDisplay('fileRead')).toEqual({ icon: '📖', name: '读取文件', known: true });
    expect(toolDisplay('commandRun')).toEqual({ icon: '⚡', name: '执行命令', known: true });
    expect(toolDisplay('ocr_image')).toEqual({ icon: '🔤', name: '文字识别', known: true });
  });

  it('未知工具 / MCP 工具回退英文名（D2）', () => {
    expect(toolDisplay('someFutureTool')).toEqual({
      icon: '⚙️',
      name: 'someFutureTool',
      known: false,
    });
    expect(toolDisplay('atlasGraphMcp__cypher_query')).toEqual({
      icon: '⚙️',
      name: 'atlasGraphMcp__cypher_query',
      known: false,
    });
  });
});

describe('toolSummary：摘要短语', () => {
  it('fileRead：行范围 / 全文', () => {
    const range = JSON.stringify({ path: 'src/agent/react-agent.ts', startLine: 430, endLine: 500 });
    expect(toolSummary('fileRead', range)).toBe('react-agent.ts（430-500 行）');
    const full = JSON.stringify({ path: 'D:\\x\\dict.txt' });
    expect(toolSummary('fileRead', full)).toBe('dict.txt（全文）');
  });

  it('fileWrite：区分写入/追加并统计行数', () => {
    const args = JSON.stringify({ path: 'a.txt', content: 'l1\nl2\nl3' });
    expect(toolSummary('fileWrite', args)).toBe('a.txt（写入 3 行）');
    expect(toolSummary('fileWrite', JSON.stringify({ path: 'a.txt', content: 'x', mode: 'append' }))).toBe(
      'a.txt（追加 1 行）',
    );
  });

  it('editFile：标注正则/全部替换', () => {
    const args = JSON.stringify({ path: 'p.json', regex: true, replaceAll: true });
    expect(toolSummary('editFile', args)).toBe('p.json（正则替换·全部）');
    expect(toolSummary('editFile', JSON.stringify({ path: 'p.json' }))).toBe('p.json（替换）');
  });

  it('grep / commandRun / activateSkill', () => {
    expect(toolSummary('grep', JSON.stringify({ pattern: 'dict\\.txt', path: 'webui/src' }))).toBe(
      '在 webui/src 中检索 dict\\.txt',
    );
    expect(toolSummary('commandRun', JSON.stringify({ command: 'npm run build' }))).toBe('npm run build');
    expect(toolSummary('activateSkill', JSON.stringify({ name: 'task-driven-development' }))).toBe(
      'task-driven-development',
    );
  });

  it('视觉工具：图片名 + 问题/字段', () => {
    expect(toolSummary('ask_image', JSON.stringify({ image: 'C:\\a\\error.png', question: '报错码是什么？' }))).toBe(
      'error.png →「报错码是什么？」',
    );
    expect(
      toolSummary('extract_json', JSON.stringify({ image: 'invoice.png', fields: ['标题', '金额'] })),
    ).toBe('invoice.png → 标题、金额');
    expect(toolSummary('describe_image', JSON.stringify({ image: '/tmp/x.jpg' }))).toBe('x.jpg');
    expect(toolSummary('ocr_image', JSON.stringify({ image: 'shot.png' }))).toBe('shot.png');
  });

  it('未知工具回退紧凑 JSON（截断 80）', () => {
    const args = JSON.stringify({ cypher: 'MATCH (n) RETURN n', limit: 5 });
    expect(toolSummary('mcp__q', args)).toBe(args);
    const long = JSON.stringify({ a: 'x'.repeat(200) });
    const out = toolSummary('mcp__q', long);
    expect(out.length).toBe(81); // clip 语义：80 字符内容 + 省略号
    expect(out.endsWith('…')).toBe(true);
  });

  it('无效 JSON / 空参数不抛错', () => {
    expect(() => toolSummary('fileRead', '{oops')).not.toThrow();
    expect(toolSummary('fileRead', '{oops')).toBe('{oops');
    expect(toolSummary('fileRead', JSON.stringify({}))).toBe('{}');
    expect(toolSummary('fileRead', '')).toBe('');
  });
});

describe('toolParamRows：中文参数表', () => {
  it('按登记键序输出，英文键名附注', () => {
    const rows = toolParamRows(
      'fileRead',
      JSON.stringify({ lineNumbers: true, path: 'a.ts', startLine: 1, endLine: 9 }),
    );
    expect(rows.map((r) => r.key)).toEqual(['path', 'startLine', 'endLine', 'lineNumbers']);
    expect(rows[0]).toEqual({ key: 'path', zh: '文件路径', text: 'a.ts' });
  });

  it('未登记参数追加在末尾（zh 回退英文键名）', () => {
    const rows = toolParamRows('fileRead', JSON.stringify({ path: 'a.ts', custom: 1 }));
    expect(rows[1]).toEqual({ key: 'custom', zh: 'custom', text: '1' });
  });

  it('MCP 未知工具输出全部参数', () => {
    const rows = toolParamRows('mcp__q', JSON.stringify({ cypher: 'X', limit: 5 }));
    expect(rows.map((r) => r.key)).toEqual(['cypher', 'limit']);
  });

  it('无效 JSON → 空数组；超长值截断 200；对象序列化', () => {
    expect(toolParamRows('fileRead', 'bad')).toEqual([]);
    const long = 'x'.repeat(300);
    const [row] = toolParamRows('commandRun', JSON.stringify({ command: long }));
    expect(row.text.length).toBe(201);
    expect(row.text.endsWith('…')).toBe(true);
    const [obj] = toolParamRows('grep', JSON.stringify({ pattern: { nested: [1, 2] } }));
    expect(obj.text).toBe('{"nested":[1,2]}');
  });
});

describe('toolResultLooksFailed：失败启发式（D5）', () => {
  it('[exit=N] 仅 commandRun 命中且行首锚定；其他工具读到该字面量不误判（20261022 第二次用户反馈）', () => {
    // commandRun 真实输出形态（commandRun.ts:40）：标记行首、后跟错误消息，整段收尾
    expect(toolResultLooksFailed('some output\n[exit=1] Error: command failed', 'commandRun')).toBe(true);
    expect(toolResultLooksFailed('[exit=0] done', 'commandRun')).toBe(false);
    // 真实输出中标记总是行首（parts 以 \n 拼接）；行中间的标记视为正文内容
    expect(toolResultLooksFailed('x [exit= 2 ]', 'commandRun')).toBe(false);
    // 未传工具名时保持旧行为（兜底调用方）
    expect(toolResultLooksFailed('some output\n[exit=1] Error: command failed')).toBe(true);
    // fileRead 读到测试/文档正文中的 [exit=1] 字面量 → 不再误判（本次反馈场景）
    expect(
      toolResultLooksFailed("126:     expect(toolResultLooksFailed('some output\\n[exit=1]')).toBe(true);", 'fileRead'),
    ).toBe(false);
  });

  it('Error / 中文错误词 / Traceback / 超时', () => {
    expect(toolResultLooksFailed('Error: ENOENT')).toBe(true);
    expect(toolResultLooksFailed('error: bad')).toBe(true);
    expect(toolResultLooksFailed('错误：参数缺失')).toBe(true);
    expect(toolResultLooksFailed('异常：堆栈如下')).toBe(true);
    expect(toolResultLooksFailed('缺少必需参数 path')).toBe(true);
    // Traceback 仅开头锚定：第二行才出现视为正文引用（真崩溃走 [exit=非0] 主判定）
    expect(toolResultLooksFailed('Traceback (most recent call last):')).toBe(true);
    expect(toolResultLooksFailed('工具执行超时（30000ms）')).toBe(true);
  });

  it('正常结果不误判', () => {
    expect(toolResultLooksFailed('未在目录中找到匹配内容（递归）')).toBe(false);
    expect(toolResultLooksFailed('1: AT&T 3 nz\n2: B超 3 n')).toBe(false);
    expect(toolResultLooksFailed('错误处理示例代码：try/catch')).toBe(false);
    expect(toolResultLooksFailed('')).toBe(false);
  });
});

describe('compactJson / prettyJson', () => {
  it('compactJson 压缩单行并截断', () => {
    expect(compactJson('{ "a": 1 }')).toBe('{"a":1}');
    expect(compactJson('', 10)).toBe('');
    expect(compactJson('not json', 4)).toBe('not …'); // 截断 4 字符 + 省略号（slice 含尾空格）
  });

  it('prettyJson 缩进格式化，无效原样返回', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('bad')).toBe('bad');
    expect(prettyJson('')).toBe('');
  });
});

describe('stripAnsi / RESULT_EXPAND_THRESHOLD（20261022-001 补丁）', () => {
  it('剥离 CSI/OSC 转义序列（vitest 彩色输出场景）', () => {
    const vitestLine =
      '\x1b[32m✓\x1b[39m tests/memory-kit-cache.test.ts \x1b[2m(\x1b[22m\x1b[2m3 tests\x1b[22m\x1b[2m)\x1b[22m \x1b[32m32\x1b[2mms\x1b[39m';
    expect(stripAnsi(vitestLine)).toBe('✓ tests/memory-kit-cache.test.ts (3 tests) 32ms');
    expect(stripAnsi('\x1b]0;window title\x07plain')).toBe('plain');
    expect(stripAnsi('\x1b[1m\x1b[30m\x1b[46m RUN \x1b[49m\x1b[39m\x1b[22m v4.1.10')).toBe(' RUN  v4.1.10');
    expect(stripAnsi('no escape')).toBe('no escape');
    expect(stripAnsi('')).toBe('');
  });

  it('阈值语义：去 ANSI 后 >400 才截断（584 字节日志可展开，短结果完整显示）', () => {
    expect('x'.repeat(584).length > RESULT_EXPAND_THRESHOLD).toBe(true);
    expect('未在目录中找到匹配内容'.length > RESULT_EXPAND_THRESHOLD).toBe(false);
  });
});

describe('失败启发式回归：正文包含错误词不误判（用户截图反馈 20261022）', () => {
  it('fileRead 读到含「工具执行超时」的文档正文（优化建议 20261021-006 场景）→ 不误判', () => {
    const doc =
      '1: | 20261021-006 | commandRun 后台运行命令机制（长任务不阻塞、不被超时误杀） | …30s 被杀… | 2026-10-21 | 否 |  |\n' +
      '2: 要么在 30s 被杀，要么长时间阻塞整个 ReAct 循环（工具执行超时）';
    expect(toolResultLooksFailed(doc)).toBe(false);
  });

  it('fileRead 读到中间含 Traceback 的文档/日志行 → 不误判；真超时（开头）→ 判失败', () => {
    expect(toolResultLooksFailed('12:   File "x.py", line 1\nTraceback (most recent call last):')).toBe(false);
    expect(toolResultLooksFailed('grep 命中: 3:Traceback (most recent call last):')).toBe(false);
    // runner.ts 真实输出形态：以工具执行超时开头
    expect(toolResultLooksFailed('工具执行超时 (30000ms)')).toBe(true);
    expect(toolResultLooksFailed('Error: 工具执行超时 (30000ms)')).toBe(true);
  });
});

describe('后台任务三工具映射（Task-20261022-002）', () => {
  it('commandStatus/commandLogs/commandStop 中文名、图标、参数中文标签', () => {
    expect(toolDisplay('commandStatus')).toEqual({ icon: '⏱️', name: '查询后台任务', known: true });
    expect(toolDisplay('commandLogs')).toEqual({ icon: '📜', name: '读取后台日志', known: true });
    expect(toolDisplay('commandStop')).toEqual({ icon: '⏹️', name: '停止后台任务', known: true });

    const st = toolParamRows('commandStatus', JSON.stringify({ taskId: 'bg_a_1' }));
    expect(st.map((r) => r.key)).toEqual(['taskId']);
    expect(st[0].zh).toBe('任务 ID');

    const lg = toolParamRows('commandLogs', JSON.stringify({ taskId: 'bg_a_1', tail: true }));
    expect(lg.map((r) => r.key)).toEqual(['taskId', 'tail']);
    expect(lg[1].zh).toBe('只看尾部');
  });

  it('commandRun 后台模式摘要带「后台启动」前缀；管理工具摘要短语', () => {
    expect(toolSummary('commandRun', JSON.stringify({ command: 'npm run dev', background: true }))).toBe(
      '后台启动 npm run dev',
    );
    expect(toolSummary('commandRun', JSON.stringify({ command: 'dir' }))).toBe('dir');
    expect(toolSummary('commandStatus', JSON.stringify({ taskId: 'bg_a_1' }))).toBe('查询 bg_a_1');
    expect(toolSummary('commandStatus', JSON.stringify({}))).toBe('查询最近后台任务');
    expect(toolSummary('commandLogs', JSON.stringify({ taskId: 'bg_a_1', tail: true }))).toBe('查看 bg_a_1 最新输出');
    expect(toolSummary('commandLogs', JSON.stringify({ taskId: 'bg_a_1', sinceOffset: 1024 }))).toBe(
      '续读 bg_a_1（自 1024 字节起）',
    );
    expect(toolSummary('commandStop', JSON.stringify({ taskId: 'bg_a_1' }))).toBe('终止 bg_a_1');
  });
});
