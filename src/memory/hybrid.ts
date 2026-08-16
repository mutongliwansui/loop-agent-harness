// Phase 5：混合检索 RRF 融合（Reciprocal Rank Fusion）
//
// 将 BM25（FTS5）与向量语义检索两个有序结果集按倒排秩融合：
//   score(doc) = Σ_list 1 / (k + rank(list, doc))
// 默认 k=60（业界常用）。两个来源都命中的文档会获得更高融合分。
import type { IndexedEntry } from './fts.js';

export function rrfMerge(
  bm25: IndexedEntry[],
  vector: IndexedEntry[],
  k = 60,
  topK = 5,
): IndexedEntry[] {
  const scoreMap = new Map<string, number>();
  const entryMap = new Map<string, IndexedEntry>();

  const push = (list: IndexedEntry[]) => {
    list.forEach((entry, idx) => {
      // 以 content 去重（同一段落可能被两个来源命中）
      entryMap.set(entry.content, entry);
      scoreMap.set(entry.content, (scoreMap.get(entry.content) ?? 0) + 1 / (k + idx + 1));
    });
  };

  push(bm25);
  push(vector);

  return [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([content]) => entryMap.get(content)!);
}
