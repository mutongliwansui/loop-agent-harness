// Phase 5：VectorMemory — 向量索引（零向量数据库依赖）
//
// 设计要点：
// - 向量以 Float32 BLOB 存储于独立 SQLite 文件（node:sqlite），自己算余弦相似度
// - 文件仍是真相源，向量只做语义召回（与 MemoryIndex 一致的降级哲学）
// - 任一操作失败 → markBroken() 释放句柄，上层降级为 BM25/文件检索
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { EmbeddingClient } from './embedding.js';
import type { VectorSearchConfig } from './types.js';

const nodeRequire = createRequire(resolve(process.cwd(), 'package.json'));
let DatabaseSyncCtor: typeof DatabaseSync | undefined;
try {
  DatabaseSyncCtor = nodeRequire('node:sqlite').DatabaseSync;
} catch {
  DatabaseSyncCtor = undefined;
}

export interface VectorEntry {
  day: string;
  content: string;
  /** 余弦相似度分数 */
  score?: number;
}

/** 余弦相似度（维度不一致时返回 0） */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

const VECTOR_CREATE_SQL = `CREATE TABLE IF NOT EXISTS memory_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL
)`;

export class VectorMemory {
  private db: DatabaseSync | null = null;
  private dbPath: string;
  private client: EmbeddingClient;
  private dimension: number;
  private broken = false;

  constructor(dbPath: string, config: VectorSearchConfig) {
    this.dbPath = dbPath;
    this.client = new EmbeddingClient(config);
    this.dimension = config.dimension;
  }

  init(): boolean {
    if (!DatabaseSyncCtor) return false;
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new DatabaseSyncCtor(this.dbPath);
      this.db.exec(VECTOR_CREATE_SQL);
      this.broken = false;
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  /** 向量索引是否可用 */
  isReady(): boolean {
    return this.db !== null && !this.broken;
  }

  /** 当前向量条数 */
  count(): number {
    if (!this.db || this.broken) return 0;
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS c FROM memory_embeddings').get() as { c: number };
      return row.c;
    } catch {
      this.markBroken();
      return 0;
    }
  }

  /**
   * 从 Markdown 文件全量重建向量索引（首次使用 / 重建时调用）
   * 按 FTS 相同的段落切分规则，分批 embedding 后写入。
   * 返回写入条数；失败降级（markBroken）。
   */
  async rebuildAll(memoryDir: string): Promise<number> {
    if (!this.db || this.broken) return 0;
    try {
      this.clear();
      const entries = await readdir(memoryDir, { withFileTypes: true });
      const mdFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => join(memoryDir, e.name))
        .sort();

      const batches: Array<{ day: string; content: string }> = [];
      for (const file of mdFiles) {
        const day = basename(file, '.md');
        const content = await readFile(file, 'utf-8');
        const sections = content.split(/^## /m);
        for (const section of sections) {
          const trimmed = section.trim();
          if (!trimmed) continue;
          batches.push({ day, content: `## ${trimmed}` });
        }
      }

      // embedding（client 内部按 batchSize 分批）+ 写入
      const vecs = await this.client.embed(batches.map((b) => b.content));
      batches.forEach((b, j) => this.insert(b.day, b.content, vecs[j]));
      return batches.length;
    } catch {
      this.markBroken();
      return 0;
    }
  }

  /** 增量追加一条（append 时同步嵌入，失败静默降级） */
  async addEntry(day: string, content: string): Promise<void> {
    if (!this.db || this.broken) return;
    try {
      const [vec] = await this.client.embed([content]);
      this.insert(day, content, vec);
    } catch {
      this.markBroken();
    }
  }

  /** 语义检索：embedding 查询向量后按余弦相似度取 TopK */
  async search(query: string, topK: number): Promise<VectorEntry[]> {
    if (!this.db || this.broken) return [];
    try {
      const [qvec] = await this.client.embed([query]);
      if (!qvec) return [];

      const rows = this.db
        .prepare('SELECT day, content, embedding FROM memory_embeddings')
        .all() as Array<{ day: string; content: string; embedding: Uint8Array }>;

      const scored = rows
        .map((r) => {
          const arr = new Uint8Array(r.embedding);
          const vec = new Float32Array(arr.buffer, arr.byteOffset, arr.byteLength / 4);
          return {
            day: r.day,
            content: r.content,
            score: cosine(qvec, Array.from(vec)),
          };
        })
        .filter((r) => r.score > 0.5) // 相似度阈值，过滤无关条目
        .sort((a, b) => b.score - a.score);

      return scored.slice(0, topK).map(({ day, content, score }) => ({ day, content, score }));
    } catch {
      this.markBroken();
      return [];
    }
  }

  private insert(day: string, content: string, vec: number[]): void {
    if (!this.db) return;
    if (vec.length !== this.dimension) {
      throw new Error(`embedding 维度不匹配：期望 ${this.dimension}，实际 ${vec.length}`);
    }
    const buf = Buffer.from(new Float32Array(vec).buffer);
    this.db
      .prepare('INSERT INTO memory_embeddings (day, content, embedding) VALUES (?, ?, ?)')
      .run(day, content, buf);
  }

  private clear(): void {
    if (!this.db || this.broken) return;
    try {
      this.db.exec('DELETE FROM memory_embeddings');
    } catch {
      this.markBroken();
    }
  }

  /** 标记不可用并释放句柄（后续操作降级） */
  private markBroken(): void {
    this.broken = true;
    this.close();
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // 忽略关闭错误
    }
    this.db = null;
  }
}
