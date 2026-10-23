/**
 * 流式文本切分纯逻辑测试（Task-20261023-002 D10）
 *
 * 覆盖 stream-blocks.ts：
 * - 顶层围栏（```mermaid / ```echarts）闭合 → chart 块，源码原样保留
 * - 未闭合围栏 + streaming/isTail → pending 占位；否则回退为 md 块（流结束后可见源码）
 * - 多图表按序切分；缩进/引用内围栏不切分（D2，按普通代码块渲染）
 * - 块 key 内容指纹稳定：内容不变 → key 不变（Vue 复用 DOM 的前提，D1）
 * - md HTML 缓存（D8）：相同内容只解析一次
 * DOM 渲染与交互（槽位 append、源码切换、节流触发）列入任务文档 6.4 人工验证清单。
 */
import { describe, it, expect } from 'vitest';
import {
  splitStreamBlocks,
  countChartBlocks,
  contentKey,
  clearMdCache,
} from '../webui/src/stream-blocks.js';

/** 注入假 render，避免触碰 DOMPurify / marked（纯逻辑测试不依赖 DOM） */
const fakeRender = (md: string): string => `<p>${md.replace(/</g, '&lt;')}</p>`;

function split(text: string, streaming = false, isTail = true) {
  return splitStreamBlocks(text, { streaming, isTail, render: fakeRender });
}

describe('splitStreamBlocks：围栏切分', () => {
  it('无围栏纯文本 → 单个 md 块', () => {
    const blocks = split('hello\n\nworld');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'md', text: 'hello\n\nworld' });
  });

  it('空文本 → 空数组（模板不渲染空块）', () => {
    expect(split('')).toEqual([]);
    expect(split('   \n\n  ')).toEqual([]);
  });

  it('闭合的 mermaid 围栏 → md + chart + md 三块，源码原样保留', () => {
    const text = '前文\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n后文';
    const blocks = split(text);
    expect(blocks.map((b) => b.kind)).toEqual(['md', 'chart', 'md']);
    const chart = blocks[1] as { lang: string; src: string };
    expect(chart.lang).toBe('mermaid');
    expect(chart.src).toBe('graph TD\n  A-->B');
  });

  it('echarts 围栏同样切分（JSON 源码保留换行）', () => {
    const src = '{\n  "series": [{ "type": "line" }]\n}';
    const blocks = split(`说明\n\`\`\`echarts\n${src}\n\`\`\``);
    expect(blocks.map((b) => b.kind)).toEqual(['md', 'chart']);
    expect((blocks[1] as { lang: string; src: string }).lang).toBe('echarts');
    expect((blocks[1] as { src: string }).src).toBe(src);
  });

  it('一条消息多个图表按序切分，各自独立', () => {
    const text = [
      'A',
      '```mermaid',
      'graph TD',
      '```',
      'B',
      '```echarts',
      '{"x":1}',
      '```',
      'C',
    ].join('\n');
    const blocks = split(text);
    expect(blocks.map((b) => b.kind)).toEqual(['md', 'chart', 'md', 'chart', 'md']);
    expect(countChartBlocks(text, { render: fakeRender })).toBe(2);
  });

  it('CRLF 换行同样识别围栏', () => {
    const blocks = split('```mermaid\r\ngraph TD\r\n```\r\n');
    expect(blocks.map((b) => b.kind)).toEqual(['chart']);
    expect((blocks[0] as { src: string }).src).toBe('graph TD');
  });

  it('缩进围栏不切分（D2：列表/引用内的代码块按普通代码块）', () => {
    const text = '- 列表项\n  ```mermaid\n  graph TD\n  ```';
    const blocks = split(text);
    expect(blocks.map((b) => b.kind)).toEqual(['md']);
    expect(countChartBlocks(text, { render: fakeRender })).toBe(0);
  });

  it('带额外 info string 的围栏不切分（保守边界，演进项）', () => {
    const blocks = split('```mermaid extra\ngraph TD\n```');
    expect(blocks.map((b) => b.kind)).toEqual(['md']);
  });

  it('闭合围栏短于起始围栏时不闭合（CommonMark 规则）', () => {
    const text = '````mermaid\ngraph TD\n```\n仍在内';
    const blocks = split(text, true, true);
    expect(blocks[blocks.length - 1].kind).toBe('pending');
  });
});

describe('splitStreamBlocks：未闭合围栏（D5）', () => {
  it('流式中且尾段 → pending 占位（不裸刷源码）', () => {
    const blocks = split('前文\n\n```mermaid\ngraph TD\n  A-->', true, true);
    expect(blocks.map((b) => b.kind)).toEqual(['md', 'pending']);
    const pending = blocks[1] as { lang: string; partial: string; chars: number };
    expect(pending.lang).toBe('mermaid');
    expect(pending.partial).toBe('graph TD\n  A-->');
    expect(pending.chars).toBe(pending.partial.length);
  });

  it('流式中但非尾段 → 并入 md 块（历史段已完整）', () => {
    const blocks = split('```mermaid\ngraph TD', true, false);
    expect(blocks.map((b) => b.kind)).toEqual(['md']);
  });

  it('非流式（结束/停止/失败）→ 回退 md 块，源码可见可复制', () => {
    const blocks = split('```mermaid\ngraph TD\n  A-->', false, true);
    expect(blocks.map((b) => b.kind)).toEqual(['md']);
    expect((blocks[0] as { text: string }).text).toContain('```mermaid');
  });

  it('围栏开头刚出现（正文为空）也进入 pending', () => {
    const blocks = split('```echarts', true, true);
    expect(blocks.map((b) => b.kind)).toEqual(['pending']);
    expect((blocks[0] as { chars: number }).chars).toBe(0);
  });
});

describe('块 key 稳定性（D1：Vue 复用 DOM 的前提）', () => {
  it('相同内容切出相同 key', () => {
    const a = split('前文\n\n```mermaid\ngraph TD\n```');
    const b = split('前文\n\n```mermaid\ngraph TD\n```');
    expect(a.map((x) => x.k)).toEqual(b.map((x) => x.k));
  });

  it('尾部追加内容时，前序块的 key 不变（只重渲尾部）', () => {
    const t1 = '前文\n\n```mermaid\ngraph TD\n```';
    const t2 = `${t1}\n\n后续输出`;
    const b1 = split(t1, true, true);
    const b2 = split(t2, true, true);
    expect(b2.slice(0, b1.length).map((x) => x.k)).toEqual(b1.map((x) => x.k));
  });

  it('图表源码变化 → 该块 key 变化（重建而非复用）', () => {
    const a = split('```mermaid\ngraph TD\n```')[0];
    const b = split('```mermaid\ngraph LR\n```')[0];
    expect(a.k).not.toBe(b.k);
  });

  it('contentKey 含长度，不同内容不误判', () => {
    expect(contentKey('abc')).not.toBe(contentKey('abd'));
    expect(contentKey('')).toContain('-0');
    expect(contentKey('x'.repeat(100))).toContain(`-${(100).toString(36)}`);
  });
});

describe('md HTML 缓存（D8）', () => {
  it('相同 md 内容只调用一次 render', () => {
    clearMdCache();
    let calls = 0;
    const render = (md: string): string => {
      calls++;
      return `<p>${md}</p>`;
    };
    const text = '第一段\n\n```mermaid\ngraph TD\n```\n\n第二段';
    splitStreamBlocks(text, { render });
    const first = calls;
    splitStreamBlocks(text, { render });
    expect(first).toBe(2); // 两个 md 块各解析一次
    expect(calls).toBe(first); // 第二次全部命中缓存
  });

  it('内容变化时重新解析', () => {
    clearMdCache();
    let calls = 0;
    const render = (md: string): string => {
      calls++;
      return md;
    };
    splitStreamBlocks('一段', { render });
    splitStreamBlocks('两段', { render });
    expect(calls).toBe(2);
  });
});

describe('countChartBlocks', () => {
  it('只统计已闭合图表块', () => {
    const text = '```mermaid\na\n```\n\n```echarts\n{}\n```\n\n```mermaid\n未闭合';
    expect(countChartBlocks(text, { render: fakeRender })).toBe(2);
    // 流式尾段：未闭合 → pending，不计数
    expect(countChartBlocks(text, { streaming: true, isTail: true, render: fakeRender })).toBe(2);
  });
});
