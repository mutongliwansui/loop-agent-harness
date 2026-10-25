/**
 * 文件目录面板纯逻辑测试（Task-20261026-001）
 *
 * 覆盖 webui/src/fs-tree.ts：
 * - flattenRows：展开/未展开/空树/四层嵌套的 depth 与 guides 位图
 * - groupHits：按文件分组、组顺序、组内行号升序、根级文件 dir 为空
 * - highlightParts：大小写不敏感、多次命中、正则元字符、空关键词
 * - crumbOf：未选中、根级文件、多层路径
 * - fmtBytes：B / KB / MB 三档
 * 容器 DOM 交互（拖拽浮层、容器查询、hover 操作按钮）列入任务文档人工验证清单。
 */
import { describe, it, expect } from 'vitest';
import {
  crumbOf,
  flattenRows,
  fmtBytes,
  groupHits,
  highlightParts,
  type FsNode,
  type SearchResult,
} from '../webui/src/fs-tree.js';

/** 造一个目录节点 */
function dir(name: string, children?: FsNode[]): FsNode {
  return { name, path: name, type: 'dir', children };
}
/** 造一个文件节点 */
function file(name: string, size = 10): FsNode {
  return { name, path: name, type: 'file', size };
}

/* ===================== flattenRows ===================== */
describe('flattenRows', () => {
  it('空树返回空数组', () => {
    expect(flattenRows([], new Set())).toEqual([]);
  });

  it('未展开目录只出自身一行，不递归', () => {
    const tree = [dir('a', [file('a/x.ts')])];
    const rows = flattenRows(tree, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].node.name).toBe('a');
    expect(rows[0].depth).toBe(0);
    expect(rows[0].guides).toEqual([]);
  });

  it('展开目录后子项 depth=1，guides 长度等于 depth', () => {
    const tree = [dir('a', [file('a/x.ts')])];
    const rows = flattenRows(tree, new Set(['a']));
    expect(rows).toHaveLength(2);
    expect(rows[1].depth).toBe(1);
    expect(rows[1].guides).toHaveLength(1);
  });

  it('guides[k] 表示第 k 层祖先是否还有后续兄弟', () => {
    // 根层 a、b；a 已展开，a 不是根层最后一个 → guides[0] = true
    const tree = [dir('a', [file('a/x.ts')]), dir('b')];
    const rows = flattenRows(tree, new Set(['a']));
    const child = rows.find((r) => r.node.name === 'a/x.ts');
    expect(child?.guides).toEqual([true]);
  });

  it('最后一个兄弟的子项不画引导线', () => {
    const tree = [dir('a'), dir('b', [file('b/y.ts')])];
    const rows = flattenRows(tree, new Set(['b']));
    const child = rows.find((r) => r.node.name === 'b/y.ts');
    expect(child?.guides).toEqual([false]);
  });

  it('四层嵌套：depth 与 guides 逐层闭合', () => {
    const leaf = file('l1/l2/l3/l4/z.ts');
    const l4 = { name: 'l4', path: 'l1/l2/l3/l4', type: 'dir', children: [leaf] } as FsNode;
    const l3 = { name: 'l3', path: 'l1/l2/l3', type: 'dir', children: [l4] } as FsNode;
    const l2 = { name: 'l2', path: 'l1/l2', type: 'dir', children: [l3] } as FsNode;
    const l1 = { name: 'l1', path: 'l1', type: 'dir', children: [l2] } as FsNode;
    const rows = flattenRows([l1], new Set(['l1', 'l1/l2', 'l1/l2/l3', 'l1/l2/l3/l4']));
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 4]);
    // 每一层都是独子，故各层祖先均无后续兄弟
    expect(rows[4].guides).toEqual([false, false, false, false]);
  });

  it('目录已展开但 children 未拉取（undefined）时不抛错', () => {
    const rows = flattenRows([dir('a')], new Set(['a']));
    expect(rows).toHaveLength(1);
  });

  it('文件节点即使出现在展开集合内也不递归', () => {
    const tree = [file('a.ts')];
    const rows = flattenRows(tree, new Set(['a.ts']));
    expect(rows).toHaveLength(1);
  });

  it('保持父节点先于子节点的顺序', () => {
    const tree = [dir('a', [file('a/1.ts'), file('a/2.ts')]), file('b.ts')];
    const rows = flattenRows(tree, new Set(['a']));
    expect(rows.map((r) => r.node.name)).toEqual(['a', 'a/1.ts', 'a/2.ts', 'b.ts']);
  });
});

/* ===================== groupHits ===================== */
const hit = (path: string, line: number, text = 'x'): SearchResult => {
  const i = path.lastIndexOf('/');
  return { path, name: i >= 0 ? path.slice(i + 1) : path, line, text };
};

describe('groupHits', () => {
  it('空结果返回空数组', () => {
    expect(groupHits([])).toEqual([]);
  });

  it('同一文件的多行命中合并为一组', () => {
    const groups = groupHits([hit('a.md', 3), hit('a.md', 9)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].hits).toHaveLength(2);
  });

  it('组内按行号升序，即便输入乱序', () => {
    const groups = groupHits([hit('a.md', 9), hit('a.md', 3), hit('a.md', 6)]);
    expect(groups[0].hits.map((h) => h.line)).toEqual([3, 6, 9]);
  });

  it('组顺序取 path 首次出现顺序', () => {
    const groups = groupHits([hit('b.md', 1), hit('a.md', 1), hit('b.md', 2)]);
    expect(groups.map((g) => g.path)).toEqual(['b.md', 'a.md']);
  });

  it('dir 含尾斜杠，name 为最后一段', () => {
    const [g] = groupHits([hit('docs/tasks/a.md', 1)]);
    expect(g.dir).toBe('docs/tasks/');
    expect(g.name).toBe('a.md');
  });

  it('根级文件 dir 为空字符串', () => {
    const [g] = groupHits([hit('README.md', 1)]);
    expect(g.dir).toBe('');
    expect(g.name).toBe('README.md');
  });

  it('重复 path+line 不去重（后端可能同文本多行命中）', () => {
    const groups = groupHits([hit('a.md', 2), hit('a.md', 2)]);
    expect(groups[0].hits).toHaveLength(2);
  });
});

/* ===================== highlightParts ===================== */
describe('highlightParts', () => {
  it('空关键词返回整段非命中', () => {
    expect(highlightParts('hello', '')).toEqual([{ t: 'hello', hit: false }]);
  });

  it('全空白关键词等价于空关键词', () => {
    expect(highlightParts('hello', '   ')).toEqual([{ t: 'hello', hit: false }]);
  });

  it('大小写不敏感命中，保留原文大小写', () => {
    const parts = highlightParts('Hello World', 'world');
    expect(parts).toEqual([
      { t: 'Hello ', hit: false },
      { t: 'World', hit: true },
    ]);
  });

  it('多次命中全部切开', () => {
    const parts = highlightParts('a-b-a-b', 'a');
    expect(parts.filter((p) => p.hit)).toHaveLength(2);
    expect(parts.map((p) => p.t).join('')).toBe('a-b-a-b');
  });

  it('关键词含正则元字符不抛错（indexOf 实现）', () => {
    expect(() => highlightParts('f(a*b).ts', '(a*b)')).not.toThrow();
    const parts = highlightParts('f(a*b).ts', '(a*b)');
    expect(parts.some((p) => p.hit && p.t === '(a*b)')).toBe(true);
  });

  it('关键词长于文本时整体不命中', () => {
    expect(highlightParts('ab', 'abcdef')).toEqual([{ t: 'ab', hit: false }]);
  });

  it('切片拼接后与原文完全一致', () => {
    const text = 'const a = 1; const b = 2;';
    const parts = highlightParts(text, 'const');
    expect(parts.map((p) => p.t).join('')).toBe(text);
  });

  it('空文本返回空数组', () => {
    expect(highlightParts('', 'x')).toEqual([]);
  });
});

/* ===================== crumbOf ===================== */
describe('crumbOf', () => {
  it('未选中文件只返回根段', () => {
    expect(crumbOf('', 'root')).toEqual([{ label: 'root', path: '' }]);
  });

  it('根级文件（无斜杠）只返回根段', () => {
    expect(crumbOf('README.md', 'root')).toEqual([{ label: 'root', path: '' }]);
  });

  it('多层路径逐段返回，每段带可点击相对路径', () => {
    expect(crumbOf('docs/tasks/a.md', 'ws')).toEqual([
      { label: 'ws', path: '' },
      { label: 'docs', path: 'docs' },
      { label: 'tasks', path: 'docs/tasks' },
    ]);
  });

  it('文件名本身不进面包屑', () => {
    const crumbs = crumbOf('docs/a.md', 'ws');
    expect(crumbs.some((c) => c.label === 'a.md')).toBe(false);
  });

  it('根标签可由调用方传入（工作空间目录名）', () => {
    expect(crumbOf('a/b.ts', 'loop-agent-command')[0].label).toBe('loop-agent-command');
  });
});

/* ===================== fmtBytes ===================== */
describe('fmtBytes', () => {
  it('小于 1KB 用 B', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(1023)).toBe('1023 B');
  });

  it('1KB ~ 1MB 用整数 KB', () => {
    expect(fmtBytes(1024)).toBe('1 KB');
    expect(fmtBytes(1536)).toBe('2 KB');
  });

  it('1MB 以上用 1 位小数 MB', () => {
    expect(fmtBytes(1048576)).toBe('1.0 MB');
    expect(fmtBytes(1572864)).toBe('1.5 MB');
  });
});
