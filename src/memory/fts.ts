// MemoryIndex：L2 情景记忆的 SQLite FTS5 索引（非真相源，只做加速）
// Phase 4：使用 node:sqlite（Node 22.5+ 内置，零外部依赖）+ FTS5 全文搜索
//
// 设计原则（ADR-1）：文件是真相源，SQLite 只是索引。
// - 写入路径：追加 Markdown 文件 + 同步更新索引
// - 读取路径：优先 FTS5 检索（BM25 排序），失败回退文件关键词匹配
// - 索引损坏：rebuildFromFiles() 从 Markdown 重建
//
// 中文分词：FTS5 unicode61/trigram 对中文短词支持差，
// 采用 bigram 预分词方案（标准中文本地化做法），英文/数字保持原样。
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';

// D16：解析对象是 node:sqlite 内置模块（应用自身资源，与工作空间无关），
// 以本模块 URL 为基准，避免空间目录无 package.json 时崩溃。
const nodeRequire = createRequire(import.meta.url);
let DatabaseSyncCtor: typeof DatabaseSync | undefined;
try {
  DatabaseSyncCtor = nodeRequire('node:sqlite').DatabaseSync;
} catch {
  DatabaseSyncCtor = undefined;
}

/** FTS5 虚拟表：day/content 为 UNINDEXED（原样返回），content_fts 为预分词索引列 */
const FTS_CREATE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  day UNINDEXED,
  content UNINDEXED,
  content_fts,
  tokenize='unicode61'
)`;

/**
 * 中文 bigram 预分词（索引写入用）：
 * - 连续中文字符序列按 2-gram 拆分为空格分隔 token
 * - 英文/数字/空白保持原样（unicode61 可处理）
 */
export function tokenizeForFts(content: string): string {
  const parts = content.split(/([\u4e00-\u9fff]+)/g);
  const tokens: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (/^[\u4e00-\u9fff]+$/.test(part)) {
      if (part.length === 1) {
        tokens.push(part);
      } else {
        for (let i = 0; i < part.length - 1; i++) {
          tokens.push(part.slice(i, i + 2));
        }
      }
    } else {
      tokens.push(part);
    }
  }
  return tokens.join(' ');
}

/**
 * 查询分词：与索引同规则，每个 token 加引号保证精确短语匹配
 * 采用 OR 语义：查询可能包含索引中没有的 bigram（如"篮球吗"），
 * AND 会让整个查询失败；OR 只要任一 bigram 命中即可召回，精度由上层原文校验兜底
 */
export function tokenizeQuery(query: string): string {
  const tokens = tokenizeForFts(query).split(/\s+/).filter(Boolean);
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export interface IndexedEntry {
  day: string;
  content: string;
  /** BM25 相关性分数（FTS5 路径可用；文件检索无此字段） */
  score?: number;
}

export class MemoryIndex {
  private db: DatabaseSync | null = null;
  private dbPath: string;
  /** 索引是否可用（初始化失败或查询报错时为 false，触发降级/重建） */
  private broken = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** 初始化：打开数据库并创建 FTS5 表。失败返回 false（调用方降级为文件检索） */
  init(): boolean {
    if (!DatabaseSyncCtor) return false;
    try {
      const dir = dirname(this.dbPath);
      mkdirSync(dir, { recursive: true });
      this.db = new DatabaseSyncCtor(this.dbPath);
      this.db.exec(FTS_CREATE_SQL);
      this.broken = false;
      return true;
    } catch {
      // 初始化失败：释放句柄，返回 false 触发降级
      try {
        this.db?.close();
      } catch {
        // 忽略关闭错误
      }
      this.db = null;
      this.broken = true;
      return false;
    }
  }

  /** 追加一条记忆到索引 */
  add(day: string, content: string): void {
    if (!this.db || this.broken) return;
    try {
      this.db.prepare(
        'INSERT INTO memory_fts (day, content, content_fts) VALUES (?, ?, ?)',
      ).run(day, content, tokenizeForFts(content));
    } catch {
      this.markBroken();
    }
  }

  /**
   * FTS5 全文搜索（BM25 排序）
   * 返回命中条目。索引不可用时返回空数组（由调用方回退文件检索）。
   */
  search(query: string, topK = 5): IndexedEntry[] {
    if (!this.db || this.broken) return [];
    try {
      const matchQuery = tokenizeQuery(query);
      if (!matchQuery) return [];
      const rows = this.db.prepare(
        `SELECT day, content, bm25(memory_fts) as score
         FROM memory_fts WHERE memory_fts MATCH ?
         ORDER BY score LIMIT ?`,
      ).all(matchQuery, topK) as Array<{ day: string; content: string; score: number }>;
      return rows.map((r) => ({ day: r.day, content: r.content, score: -r.score }));
    } catch {
      this.markBroken();
      return [];
    }
  }

  /** 清空全部索引（重建前调用） */
  clear(): void {
    if (!this.db || this.broken) return;
    try {
      this.db.exec('DELETE FROM memory_fts');
    } catch {
      this.markBroken();
    }
  }

  /**
   * 从 Markdown 文件重建索引（索引损坏时使用）
   * 扫描 memoryDir 下所有 .md 文件，逐条重新索引。
   * 返回重建的条目数。
   */
  async rebuildFromFiles(memoryDir: string): Promise<number> {
    let count = 0;
    try {
      const entries = await readdir(memoryDir, { withFileTypes: true });
      const mdFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => join(memoryDir, e.name))
        .sort();

      this.clear();
      for (const file of mdFiles) {
        const day = basename(file, '.md');
        const content = await readFile(file, 'utf-8');
        // 按段落（## 开头）切分，逐条索引
        const sections = content.split(/^## /m);
        for (const section of sections) {
          const trimmed = section.trim();
          if (!trimmed) continue;
          this.add(day, `## ${trimmed}`);
          count++;
        }
      }
    } catch {
      this.markBroken();
    }
    return count;
  }

  /** 标记索引不可用并释放数据库句柄（后续操作降级为文件检索） */
  private markBroken(): void {
    this.broken = true;
    try {
      this.db?.close();
    } catch {
      // 忽略关闭错误
    }
    this.db = null;
  }

  /** 索引是否可用 */
  isReady(): boolean {
    return this.db !== null && !this.broken;
  }

  /** 关闭数据库连接 */
  close(): void {
    try {
      this.db?.close();
    } catch {
      // 忽略关闭错误
    }
    this.db = null;
  }
}
