// tool-meta 单测（Task-20261022-001 建立；Task-20261024-001 重设计后同步）
// 映射层纯函数无 DOM 依赖，可在 Node vitest 下直测
import { describe, expect, it } from 'vitest';
import {
  compactJson,
  groupToolSegs,
  prettyJson,
  RESULT_PREVIEW_CHARS,
  RESULT_PREVIEW_LINES,
  resultLines,
  resultMetaText,
  resultNeedsExpand,
  stripAnsi,
  TOOL_GROUP_MIN,
  TOOL_ICON_PATHS,
  toolDisplay,
  toolFailReason,
  toolIconSvg,
  toolParamRows,
  toolResultLooksFailed,
  toolSummary,
  type RenderItem,
  type ToolCardVM,
  type ToolSegLike,
} from '../webui/src/tool-meta.js';

describe('toolDisplay：工具名 → 图标 key + 中文名（D2：不再是 emoji）', () => {
  it('已知工具返回中文映射', () => {
    expect(toolDisplay('fileRead')).toEqual({ icon: 'book', name: '读取文件', known: true });
    expect(toolDisplay('commandRun')).toEqual({ icon: 'terminal', name: '执行命令', known: true });
    expect(toolDisplay('ocr_image')).toEqual({ icon: 'text', name: '文字识别', known: true });
  });

  it('未知工具 / MCP 工具回退英文名 + 齿轮图标（D2 / D10）', () => {
    expect(toolDisplay('someFutureTool')).toEqual({
      icon: 'gear',
      name: 'someFutureTool',
      known: false,
    });
    expect(toolDisplay('atlasGraphMcp__cypher_query')).toEqual({
      icon: 'gear',
      name: 'atlasGraphMcp__cypher_query',
      known: false,
    });
  });

  // 防回归：映射表键必须是工具的真实 name（曾把 activate_skill 误写成驼峰
  // activateSkill → 精确查找落空，UI 静默回退英文名，且当时测试也用错键所以没暴露）
  it('全部内置工具名都命中中文映射（键须与 src/tools 的 name 逐字一致）', () => {
    const BUILTIN_TOOLS = [
      'fileRead',
      'fileWrite',
      'editFile',
      'grep',
      'commandRun',
      'commandStatus',
      'commandLogs',
      'commandStop',
      'activate_skill',
      'describe_image',
      'ask_image',
      'extract_json',
      'ocr_image',
    ];
    const missed = BUILTIN_TOOLS.filter((t) => !toolDisplay(t).known);
    expect(missed).toEqual([]);
  });
});

describe('toolIconSvg / TOOL_ICON_PATHS：16×16 线性 SVG（D2）', () => {
  it('14 个 icon key 全有路径，无空值', () => {
    const keys = Object.keys(TOOL_ICON_PATHS);
    expect(keys).toHaveLength(14);
    for (const k of keys) {
      expect(TOOL_ICON_PATHS[k as keyof typeof TOOL_ICON_PATHS].length).toBeGreaterThan(10);
    }
  });

  it('输出完整 svg 串：viewBox 16×16 + currentColor 描边', () => {
    const svg = toolIconSvg('fileRead');
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain(TOOL_ICON_PATHS.book);
    // 未知工具回退齿轮
    expect(toolIconSvg('mcp__x')).toContain(TOOL_ICON_PATHS.gear);
  });
});

describe('toolFailReason：失败原因一句话（卡片副标题直写）', () => {
  it('commandRun：剥掉 [exit=N] 标记取原因', () => {
    expect(toolFailReason('some output\n[exit=1] Error: command failed', 'commandRun')).toBe(
      'Error: command failed',
    );
    // 纯标记行 → 继续找下一行
    expect(toolFailReason('[exit=1]\nError: spawn failed', 'commandRun')).toBe('Error: spawn failed');
    // 只有标记行 → 无原因可提炼
    expect(toolFailReason('[exit=1]', 'commandRun')).toBe('');
  });

  it('其他工具不剥 [exit=N]（正文可能含该字面量）', () => {
    expect(toolFailReason('[exit=1] 某文档正文', 'fileRead')).toBe('[exit=1] 某文档正文');
  });

  it('剥掉后端错误前缀，副标题只留真正原因', () => {
    // ToolRunner 统一前缀
    expect(toolFailReason('工具执行失败: 未找到文本（首个差异行 118）', 'editFile')).toBe(
      '未找到文本（首个差异行 118）',
    );
    expect(toolFailReason('工具执行失败：  ENOENT: no such file', 'fileRead')).toBe('ENOENT: no such file');
    // react-agent 前置校验前缀
    expect(toolFailReason('工具 fileRead 缺少必需参数: path，请补充后重试', 'fileRead')).toBe(
      '缺少必需参数: path，请补充后重试',
    );
    expect(toolFailReason('工具 foo 未注册，无法执行', 'foo')).toBe('未注册，无法执行');
    // 只有前缀、无正文 → 空串（调用方兜底「执行失败」）
    expect(toolFailReason('工具执行失败: ', 'editFile')).toBe('');
  });

  it('取首个非空行、剥 ANSI、截断 60 字；空结果返回空串', () => {
    expect(toolFailReason('\n\n  Error: ENOENT  \n第二行')).toBe('Error: ENOENT');
    expect(toolFailReason('\x1b[31mError: 未找到文本\x1b[39m')).toBe('Error: 未找到文本');
    const long = toolFailReason(`Error: ${'x'.repeat(120)}`);
    expect(long.length).toBe(61); // 60 字符 + 省略号
    expect(long.endsWith('…')).toBe(true);
    expect(toolFailReason('')).toBe('');
    expect(toolFailReason('   \n  ')).toBe('');
  });
});

describe('结果区行数口径（D6：190px≈12 行 / 展开 420px）', () => {
  it('resultLines 去 ANSI 后计数', () => {
    expect(resultLines('')).toBe(0);
    expect(resultLines('one')).toBe(1);
    expect(resultLines('a\nb\nc')).toBe(3);
    expect(resultLines('\x1b[32ma\x1b[39m\nb')).toBe(2);
  });

  it('resultNeedsExpand：>12 行或 >1200 字符才需要展开', () => {
    expect(RESULT_PREVIEW_LINES).toBe(12);
    expect(RESULT_PREVIEW_CHARS).toBe(1200);
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
    expect(resultNeedsExpand(lines(12))).toBe(false);
    expect(resultNeedsExpand(lines(13))).toBe(true);
    // 单行超长（会被 190px 裁剪）也要给出展开入口
    expect(resultNeedsExpand('x'.repeat(1201))).toBe(true);
    expect(resultNeedsExpand('x'.repeat(1200))).toBe(false);
    expect(resultNeedsExpand('')).toBe(false);
    expect(resultNeedsExpand('未在目录中找到匹配内容（递归）')).toBe(false);
  });

  it('resultMetaText：行数 · 体积', () => {
    expect(resultMetaText('')).toBe('');
    expect(resultMetaText('a\nb')).toBe('2 行 · 3 B');
    expect(resultMetaText('x'.repeat(2048))).toBe('1 行 · 2.0 KB');
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

  it('grep / commandRun / activate_skill', () => {
    expect(toolSummary('grep', JSON.stringify({ pattern: 'dict\\.txt', path: 'webui/src' }))).toBe(
      '在 webui/src 中检索 dict\\.txt',
    );
    expect(toolSummary('commandRun', JSON.stringify({ command: 'npm run build' }))).toBe('npm run build');
    expect(toolSummary('activate_skill', JSON.stringify({ name: 'task-driven-development' }))).toBe(
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
    // 20261028-006：路径参数注记原始值与分类（可点 chip 数据源）
    expect(rows[0]).toEqual({ key: 'path', zh: '文件路径', text: 'a.ts', path: 'a.ts', kind: 'file' });
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

  it('后端工具层错误前缀（ToolRunner / react-agent 真实输出形态）', () => {
    // ToolRunner 把工具异常统一归一化为 `工具执行失败: <msg>`（src/tools/runner.ts:71）
    expect(toolResultLooksFailed('工具执行失败: 未找到文本（首个差异行 118）', 'editFile')).toBe(true);
    expect(toolResultLooksFailed('工具执行失败: ENOENT: no such file or directory', 'fileRead')).toBe(true);
    // react-agent 的三类前置校验文案（src/agent/react-agent.ts:856-861）
    expect(toolResultLooksFailed('工具 fileRead 缺少必需参数: path，请补充后重试', 'fileRead')).toBe(true);
    expect(toolResultLooksFailed('工具 foo 未注册，无法执行', 'foo')).toBe(true);
    expect(toolResultLooksFailed('工具 grep 参数无效：参数为空或解析失败，请重新调用并提供正确的参数', 'grep')).toBe(true);
    // 非行首出现（正文引用）不判失败
    expect(
      toolResultLooksFailed('第 71 行：return `工具执行失败: ${msg}`;', 'fileRead'),
    ).toBe(false);
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

describe('stripAnsi（20261022-001 补丁；20261024-001 接入渲染路径）', () => {
  it('剥离 CSI/OSC 转义序列（vitest 彩色输出场景）', () => {
    const vitestLine =
      '\x1b[32m✓\x1b[39m tests/memory-kit-cache.test.ts \x1b[2m(\x1b[22m\x1b[2m3 tests\x1b[22m\x1b[2m)\x1b[22m \x1b[32m32\x1b[2mms\x1b[39m';
    expect(stripAnsi(vitestLine)).toBe('✓ tests/memory-kit-cache.test.ts (3 tests) 32ms');
    expect(stripAnsi('\x1b]0;window title\x07plain')).toBe('plain');
    expect(stripAnsi('\x1b[1m\x1b[30m\x1b[46m RUN \x1b[49m\x1b[39m\x1b[22m v4.1.10')).toBe(' RUN  v4.1.10');
    expect(stripAnsi('no escape')).toBe('no escape');
    expect(stripAnsi('')).toBe('');
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
  it('commandStatus/commandLogs/commandStop 中文名、图标 key、参数中文标签', () => {
    expect(toolDisplay('commandStatus')).toEqual({ icon: 'clock', name: '查询后台任务', known: true });
    expect(toolDisplay('commandLogs')).toEqual({ icon: 'lines', name: '读取后台日志', known: true });
    expect(toolDisplay('commandStop')).toEqual({ icon: 'stop', name: '停止后台任务', known: true });

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

describe('groupToolSegs：连续 ≥3 次同工具合并（D5）', () => {
  type Seg =
    | { type: 'tool'; tool: string; args: string; result: string; done: boolean; elapsedMs?: number; aborted?: boolean }
    | { type: 'text'; text: string };

  const tseg = (tool: string, extra: Partial<ToolSegLike> = {}): Seg => ({
    type: 'tool',
    tool,
    args: '{}',
    result: 'ok',
    done: true,
    elapsedMs: 100,
    ...extra,
  });
  const txt = (text: string): Seg => ({ type: 'text', text });
  /** 取所有卡片视图模型 */
  const cards = (items: RenderItem<Seg>[]) =>
    items.filter((it): it is { kind: 'tool'; card: ToolCardVM<Seg> } => it.kind === 'tool').map((it) => it.card);

  it('阈值：连续 3 次合并为组，2 次保持单卡', () => {
    expect(TOOL_GROUP_MIN).toBe(3);
    const three = groupToolSegs<Seg>([tseg('fileRead'), tseg('fileRead'), tseg('fileRead')]);
    expect(three).toHaveLength(1);
    const [g] = cards(three);
    expect(g.kind).toBe('group');
    expect(g.tool).toBe('fileRead');
    expect(g.items.map((i) => i.index)).toEqual([0, 1, 2]);
    expect(g.totalMs).toBe(300);

    const two = groupToolSegs<Seg>([tseg('fileRead'), tseg('fileRead')]);
    expect(two).toHaveLength(2);
    expect(cards(two).map((c) => c.kind)).toEqual(['single', 'single']);
    expect(cards(two).map((c) => c.totalMs)).toEqual([100, 100]);
  });

  it('「连续」约束：中间夹文本段或其他工具都不合并', () => {
    const withText = groupToolSegs<Seg>([tseg('fileRead'), txt('我读一下'), tseg('fileRead'), tseg('fileRead'), tseg('fileRead')]);
    // [单卡] [文本] [组]
    expect(withText.map((it) => it.kind)).toEqual(['tool', 'seg', 'tool']);
    const cs = cards(withText);
    expect(cs[0].kind).toBe('single');
    expect(cs[1].kind).toBe('group');
    expect(withText[1]).toMatchObject({ kind: 'seg', index: 1 });

    const mixed = groupToolSegs<Seg>([tseg('fileRead'), tseg('grep'), tseg('fileRead'), tseg('fileRead')]);
    expect(mixed).toHaveLength(4);
    expect(cards(mixed).every((c) => c.kind === 'single')).toBe(true);
  });

  it('组内含失败 → 不合并，逐个单卡且失败卡可判定', () => {
    const segs: Seg[] = [
      tseg('fileRead'),
      tseg('fileRead'),
      tseg('fileRead', { result: 'Error: 文件不存在' }),
    ];
    const out = groupToolSegs(segs);
    expect(out).toHaveLength(3);
    const cs = cards(out);
    expect(cs.map((c) => c.kind)).toEqual(['single', 'single', 'single']);
    expect(cs.map((c) => c.failed)).toEqual([false, false, true]);
  });

  it('状态派生：running / aborted / failed 优先级', () => {
    const running = cards(groupToolSegs<Seg>([tseg('commandRun', { done: false }), tseg('commandRun', { done: false }), tseg('commandRun', { done: false })]));
    expect(running[0].running).toBe(true);
    expect(running[0].kind).toBe('group');

    const aborted = cards(
      groupToolSegs<Seg>([
        tseg('grep', { done: false, aborted: true }),
        tseg('grep', { done: false, aborted: true }),
        tseg('grep', { done: false, aborted: true }),
      ]),
    );
    expect(aborted[0].aborted).toBe(true);
    expect(aborted[0].running).toBe(false);
    expect(aborted[0].failed).toBe(false);
  });

  it('totalMs：组员耗时不全有值时不给总耗时', () => {
    const out = cards(
      groupToolSegs<Seg>([
        tseg('fileRead', { elapsedMs: 100 }),
        tseg('fileRead', { elapsedMs: undefined }),
        tseg('fileRead', { elapsedMs: 200 }),
      ]),
    );
    expect(out[0].totalMs).toBeUndefined();
  });

  it('空输入与非工具段原样透传（index 保持原下标）', () => {
    expect(groupToolSegs<Seg>([])).toEqual([]);
    const out = groupToolSegs<Seg>([txt('a'), txt('b')]);
    expect(out).toEqual([
      { kind: 'seg', seg: { type: 'text', text: 'a' }, index: 0 },
      { kind: 'seg', seg: { type: 'text', text: 'b' }, index: 1 },
    ]);
  });
});
