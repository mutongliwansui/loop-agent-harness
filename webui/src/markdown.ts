// markdown.ts：marked + DOMPurify 统一渲染 + highlight.js 代码高亮后处理
//
// renderMarkdown(text) → 安全 HTML（marked.parse + DOMPurify.sanitize）
// highlightIn(root)    → 对 root 下 <pre><code class="language-*"> 代码块做 hljs 高亮；
//                        跳过 language-mermaid（由 ChatView mermaid 后处理接管）与已高亮块；
//                        单块失败静默保留原样，不影响其余块。配色见 style.css 的 .hljs-* 规则。

import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { marked } from 'marked';

export function renderMarkdown(text: string | null | undefined): string {
  if (!text) return '';
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

export function highlightIn(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')) {
    if (code.classList.contains('hljs')) continue; // 已高亮
    if (code.classList.contains('language-mermaid')) continue; // mermaid 专门后处理
    try {
      hljs.highlightElement(code);
    } catch {
      // 未知/异常语言：保留代码块原样
    }
  }
}
