// 后台任务指示器布局守卫单测（需求 20261113-007）
//
// 为什么用「读源码断言 CSS 规则」：本需求的三个核心约束（展开区限高、+N 在裁切容器
// 之外、窄屏隐藏 chips）都是纯 CSS 布局行为，组件测试不加载真实 CSS，Node vitest 也
// 测不到几何；真实几何另由 CDP 实测覆盖（原型量化验证）。静态断言锁住关键声明，
// 成本低、能防回归——一旦有人把 max-height 删掉或把 +N 塞回 overflow 容器，这里立即红。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  new URL('../webui/src/components/BackgroundDock.vue', import.meta.url),
  'utf8',
);
const CSS = SRC.slice(SRC.indexOf('<style'));

/** 取出指定选择器的规则体（取第一处匹配） */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  return m ? m[1] : '';
}

/** 取出 @media 块内的全部内容 */
function mediaBody(query: string): string {
  const i = CSS.indexOf(`@media (${query})`);
  if (i < 0) return '';
  const start = CSS.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < CSS.length; j++) {
    if (CSS[j] === '{') depth++;
    else if (CSS[j] === '}') {
      depth--;
      if (depth === 0) return CSS.slice(start + 1, j);
    }
  }
  return '';
}

describe('展开区限高：任务再多也不把输入区顶出视口（D1）', () => {
  it('.sad-list 必须有 max-height，且与 DOCK_LIST_MAX_PX 同口径的 min(42vh, 320px)', () => {
    const body = ruleBody('.sad-list');
    expect(body, '.sad-list 规则缺失').not.toBe('');
    expect(body, '展开区没有高度上限，任务多时会把输入坞顶出视口').toMatch(
      /max-height:\s*min\(42vh,\s*320px\)/,
    );
  });

  it('.sad-list 必须内部滚动并阻断滚动链', () => {
    const body = ruleBody('.sad-list');
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body, '缺 overscroll-behavior 会把滚动传给整页').toMatch(
      /overscroll-behavior:\s*contain/,
    );
  });

  it('窄屏（≤720px）展开区降为 240px', () => {
    const body = mediaBody('max-width: 720px');
    expect(body, '窄屏媒体查询缺失').not.toBe('');
    expect(body).toMatch(/max-height:\s*240px/);
  });
});

describe('+N 溢出汇总恒定可见（D4）', () => {
  it('.sad-chips 是裁切容器（overflow:hidden）但负责弹性收缩', () => {
    const body = ruleBody('.sad-chips');
    expect(body, '.sad-chips 规则缺失').not.toBe('');
    expect(body).toMatch(/flex:\s*1/);
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).toMatch(/overflow:\s*hidden/);
  });

  it('.sad-more 必须 flex:none（不被压缩）且不在裁切容器内', () => {
    const body = ruleBody('.sad-more');
    expect(body, '.sad-more 规则缺失').not.toBe('');
    expect(body, '+N 可被压缩就会被裁掉').toMatch(/flex:\s*none/);
  });

  it('模板里 .sad-more 紧随裁切容器结束标签（不在容器内部）', () => {
    // 直接断言「chips 容器闭合 → 紧跟 sad-more」这一段相邻结构，
    // 若有人把 +N 挪回容器内，这个正则立即不成立。
    const sibling = /<span class="sad-chips">[\s\S]*?<\/span>\s*\n\s*<span v-if="overflow > 0" class="sad-more">/;
    expect(SRC, '+N 被放回了 chips 裁切容器内，窄屏会被裁掉').toMatch(sibling);
  });
});

describe('分组与行内信息（D2 / D6 / D7）', () => {
  it('运行中组头常驻 sticky，保证滚动时知道在哪一组', () => {
    const body = ruleBody('.sad-gh');
    expect(body, '.sad-gh 规则缺失').not.toBe('');
    expect(body).toMatch(/position:\s*sticky/);
    expect(body).toMatch(/top:\s*0/);
  });

  it('类型徽标按 data-k 区分命令 / 子任务', () => {
    expect(ruleBody('.sad-kind[data-k=\'subagent\']')).not.toBe('');
  });

  it('行内状态只作用于点位与状态词（五种状态均有样式落点）', () => {
    // running / done / failed 各有一条独立规则
    for (const s of ['running', 'done', 'failed']) {
      expect(ruleBody(`.sad-row[data-s='${s}'] .sad-dot`), `${s} 状态点规则缺失`).not.toBe('');
    }
    // aborted 与 interrupted 共用一条并列选择器规则（逗号连接，ruleBody 不适用）
    const pair = /\.sad-row\[data-s='aborted'\]\s\.sad-dot,\s*\n?\s*\.sad-row\[data-s='interrupted'\]\s\.sad-dot\s*\{[^}]*background/;
    expect(CSS, 'aborted / interrupted 状态点规则缺失').toMatch(pair);
  });

  it('标题两行截断、错误摘要一行截断，撑不宽行内主区', () => {
    const task = ruleBody('.sad-task');
    expect(task).toMatch(/-webkit-line-clamp:\s*2/);
    expect(task).toMatch(/-webkit-box-orient:\s*vertical/);
    const err = ruleBody('.sad-err');
    expect(err).toMatch(/-webkit-line-clamp:\s*1/);
    expect(err).toMatch(/word-break:\s*break-word/);
  });

  it('任务 ID 按钮限制横向宽度，不与标题抢空间', () => {
    const body = ruleBody('.sad-id span');
    expect(body, '.sad-id span 规则缺失').not.toBe('');
    expect(body).toMatch(/max-width:\s*\d+px/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(body).toMatch(/white-space:\s*nowrap/);
  });
});

describe('窄屏收敛（D9）', () => {
  it('≤720px 隐藏 chips 与 +N，保留计数 / 聚合耗时 / chevron', () => {
    const body = mediaBody('max-width: 720px');
    expect(body).toMatch(/\.sad-chips,\s*\n?\s*\.sad-more\s*\{\s*display:\s*none/);
    expect(body).toMatch(/\.sad-total\s*\{\s*margin-left:\s*auto/);
  });

  it('≤480px 再隐藏单任务短名', () => {
    expect(mediaBody('max-width: 480px')).toMatch(/\.sad-short\s*\{\s*display:\s*none/);
  });
});

describe('可访问性与动效（现状保持）', () => {
  it('头部与组头都是 button，并带 aria-expanded', () => {
    expect(SRC).toMatch(/:aria-expanded="expanded"/);
    expect(SRC).toMatch(/:aria-expanded="doneOpen"/);
  });

  it('prefers-reduced-motion 下关闭呼吸动画', () => {
    const body = mediaBody('prefers-reduced-motion: reduce');
    expect(body, 'reduced-motion 查询缺失').not.toBe('');
    expect(body).toMatch(/animation:\s*none/);
  });
});
