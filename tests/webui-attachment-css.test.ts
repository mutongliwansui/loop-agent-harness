// 附件超长文件名布局守卫单测（需求 20261113-006 补正）
//
// 为什么用「读源码断言 CSS 规则」而不是 DOM 几何断言：仓库没有针对 ChatView 的
// 浏览器级渲染测试（组件测试不加载真实 CSS 布局），而这次的问题恰好是纯 CSS
// 布局缺陷（grid 项默认 min-width:auto 按 min-content 撑开），只有在真实排版下
// 才暴露。用静态断言锁住关键声明，成本低且能防回归；真实几何另由 CDP 实测覆盖。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(new URL('../webui/src/views/ChatView.vue', import.meta.url), 'utf8');

/** 取出指定选择器的规则体（取第一处匹配，够用且不受后续覆盖干扰） */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`).exec(SRC);
  return m ? m[1] : '';
}

describe('气泡内附件容器：超长文件名不得溢出气泡', () => {
  // 根因：.msg-files 是 display:grid，.att-imgs/.att-docs 是它的直接网格项。
  // 网格项默认 min-width:auto → 按 min-content 参与定宽，长文件名（尤其中文无
  // 断点、或英文无空格长串）会把整行撑到远超气泡可用宽度（实测 642.8px 塞进 550px）。
  it('.att-docs 与 .att-imgs 都必须显式 min-width: 0', () => {
    for (const sel of ['.att-docs', '.att-imgs']) {
      const body = ruleBody(sel);
      expect(body, `${sel} 规则缺失`).not.toBe('');
      expect(body, `${sel} 缺少 min-width: 0，长文件名会撑出气泡`).toMatch(/min-width:\s*0/);
    }
  });

  it('.att-docs 需可换行，避免多个胶囊挤成一行溢出', () => {
    expect(ruleBody('.att-docs')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('.s-doc 胶囊本身也要 min-width: 0 才能被压缩', () => {
    const body = ruleBody('.s-doc');
    expect(body, '.s-doc 规则缺失').not.toBe('');
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).toMatch(/max-width:\s*100%/);
  });

  it('.msg-files 必须是 grid（分组两行，D9）', () => {
    expect(ruleBody('.msg-files')).toMatch(/display:\s*grid/);
  });
});

describe('文件名省略：长名截断而非撑宽', () => {
  it('气泡内 .sd-name 省略号三件套齐全', () => {
    const body = ruleBody('.s-doc .sd-name');
    expect(body, '.sd-name 规则缺失').not.toBe('');
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(body).toMatch(/white-space:\s*nowrap/);
  });

  it('待发送区 .ad-name 同样保留省略号三件套', () => {
    const body = ruleBody('.att-doc .ad-name');
    expect(body, '.ad-name 规则缺失').not.toBe('');
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(body).toMatch(/white-space:\s*nowrap/);
  });

  it('待发送区文档卡必须有最大宽度上限', () => {
    const body = ruleBody('.att-doc');
    expect(body, '.att-doc 规则缺失').not.toBe('');
    // 上限需与容器宽取小（min(...)），纯 px 在极窄输入坞下仍会顶出边界
    expect(body).toMatch(/max-width:\s*min\(/);
    expect(body).toMatch(/min-width:\s*0/);
  });
});

describe('长名全文可查看（title 兜底）', () => {
  it('气泡内附件标题包含完整文件名', () => {
    // 省略号截断后必须能看全文，否则用户无法确认是哪个文件
    expect(SRC).toMatch(/sd-name[\s\S]{0,400}?fileName/);
    expect(SRC).toMatch(/:title="`\$\{e\.att\.fileName\}/);
  });
});
