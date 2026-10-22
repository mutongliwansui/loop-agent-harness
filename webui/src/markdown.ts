// markdown.ts：marked + DOMPurify 统一渲染 + highlight.js 代码高亮后处理
//
// renderMarkdown(text) → 安全 HTML（marked.parse + DOMPurify.sanitize）
// highlightIn(root)    → 对 root 下 <pre><code class="language-*"> 代码块做 hljs 高亮；
//                        跳过 language-mermaid / language-echarts（分别由 ../mermaid.ts、
//                        ../echarts.ts 后处理渲染接管）与已高亮块；
//                        单块失败静默保留原样，不影响其余块。配色见 style.css 的 .hljs-* 规则。
//
// 数学公式：marked-katex-extension 编译期把 $..$ / $$..$$ 渲染为 KaTeX HTML+MathML 片段，
// throwOnError:false 时语法错误输出红色错误片段不阻断整段；经 DOMPurify 消毒（默认
// HTML+SVG+MathML profile 兼容 KaTeX 输出）。样式见 katex.min.css（main.ts 引入）。

import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';

// 公式扩展模块级注册一次；nonStandard 保持默认关闭：$ 需规范定界，避免「$5 与 $10」误判为公式
marked.use(markedKatex({ throwOnError: false }));

export function renderMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  // D2 实测（headless Edge）：默认 profile 保留 span.katex/math/.katex-html 视觉层与 aria 属性，
  // 但裁剪 MathML 语义层 semantics/annotation → 白名单补齐（不影响消毒基线）
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    ADD_TAGS: ['semantics', 'annotation'],
    ADD_ATTR: ['encoding'],
  });
}

export function highlightIn(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    if (code.classList.contains('hljs')) continue; // 已高亮
    if (code.classList.contains('language-mermaid')) continue; // mermaid 专门后处理
    if (code.classList.contains('language-echarts')) continue; // echarts 专门后处理
    try {
      hljs.highlightElement(code);
    } catch {
      // 未知/异常语言：保留代码块原样
    }
  }
}
