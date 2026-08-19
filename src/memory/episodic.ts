// L2 Episodic Memory：按天 Markdown 文件存储的情景记忆
// Phase 1：简单文件内容检索（关键词匹配）+ Session 隔离
// Phase 4：升级为 SQLite FTS5 全文搜索（node:sqlite，零外部依赖）
// Phase 5：可选向量检索（配置 VectorSearchConfig 才启用），混合检索 BM25 + 向量 RRF 融合
import { mkdir, appendFile, readFile, readdir, access, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { MemoryIndex } from './fts.js';
import type { IndexedEntry } from './fts.js';
import { VectorMemory } from './vector.js';
import { rrfMerge } from './hybrid.js';
import type { VectorSearchConfig } from './types.js';
import type { MemorySearchResult } from './types.js';

function fileExists(path: string): boolean {
  return existsSync(path);
}

/** 提取字符串中的中文 bigram 集合（纯中文连续序列按 2-gram 切分，用于模糊召回） */
function extractChineseBigrams(text: string): Set<string> {
  const bigrams = new Set<string>();
  const runs = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of runs) {
    if (run.length === 1) {
      bigrams.add(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        bigrams.add(run.slice(i, i + 2));
      }
    }
  }
  return bigrams;
}

/**
 * 段落相关性匹配（Task-17 8.5）
 * 三级判定：条目包含查询（常规）→ 查询包含条目（短条目）→ 共有中文 bigram（长查询召回短事实）
 * 例：查询"我会打篮球吗？"与条目"我会打篮球"无子串包含关系，但共有 bigram（我会/会打/打篮/篮球）
 */
function sectionMatches(query: string, body: string): boolean {
  const q = query.toLowerCase();
  const b = body.toLowerCase();
  if (!b) return false;
  if (b.includes(q)) return true;
  if (q.includes(b)) return true;
  const qBigrams = extractChineseBigrams(q);
  for (const bg of qBigrams) {
    if (b.includes(bg)) return true;
  }
  return false;
}

/** 记忆条目的作用域 */
export type MemoryScope = 'session' | 'global';

/** 追加写入时的选项 */
export interface AppendOptions {
  /** 会话 ID（用于隔离） */
  sessionId?: string;
  /** 作用域：session=仅当前会话可见, global=所有会话可见 */
  scope?: MemoryScope;
  /** 类别标签 */
  tag?: string;
}

/** 检索时的选项 */
export interface SearchOptions {
  /** 当前会话 ID（用于过滤 session 级条目） */
  sessionId?: string;
  /** 作用域过滤：只返回指定 scope 的条目 */
  scope?: MemoryScope;
}

export class EpisodicMemory {
  private memoryDir: string;
  /** SQLite FTS5 索引（可选；初始化失败或查询报错时自动降级为文件检索） */
  private index: MemoryIndex | null = null;
  /** Phase 5：向量索引（可选；仅配置 vectorSearch 且初始化成功时启用） */
  private vector: VectorMemory | null = null;
  private vectorConfig?: VectorSearchConfig;
  /** 向量索引是否已完成全量构建（避免重复重建） */
  private vectorBuilt = false;

  constructor(memoryDir: string, vectorConfig?: VectorSearchConfig) {
    this.memoryDir = memoryDir;
    this.vectorConfig = vectorConfig;
  }

  /** 初始化：创建 memory 目录 + 尝试建立 FTS 索引 + 向量索引 */
  async init(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    this.initIndex();
    this.initVector();
  }

  /**
   * 初始化 FTS 索引（Phase 4）
   * 索引不可用（无 node:sqlite 或 DB 损坏）时静默降级为文件检索
   * 已有可用索引时复用，避免重复打开连接
   */
  initIndex(): void {
    if (this.index?.isReady()) return;
    // 关闭旧连接（可能是 broken 状态），重新打开
    this.closeIndex();
    try {
      const index = new MemoryIndex(join(this.memoryDir, 'index.sqlite'));
      if (index.init()) {
        this.index = index;
      }
    } catch {
      this.index = null;
    }
  }

  /** 从 Markdown 文件重建索引（索引损坏时使用），返回重建条目数 */
  async rebuildIndex(): Promise<number> {
    // 重新打开索引（覆盖可能损坏的状态）
    this.initIndex();
    if (!this.index) return 0;
    return this.index.rebuildFromFiles(this.memoryDir);
  }

  /** FTS 索引是否可用 */
  isIndexReady(): boolean {
    return this.index?.isReady() ?? false;
  }

  /**
   * 初始化向量索引（Phase 5）
   * 未配置 vectorSearch（或 enabled=false / endpoint/model 为空）时保持禁用，
   * 不影响任何现有功能。初始化失败静默降级。
   */
  initVector(): void {
    const cfg = this.vectorConfig;
    if (!cfg?.enabled || !cfg.endpoint || !cfg.model) return;
    if (this.vector?.isReady()) return;
    this.vector?.close();
    this.vector = null;
    this.vectorBuilt = false;
    try {
      const vector = new VectorMemory(join(this.memoryDir, 'vectors.sqlite'), cfg);
      if (vector.init()) this.vector = vector;
    } catch {
      this.vector = null;
    }
  }

  /** 向量索引是否可用（未配置时为 false） */
  isVectorReady(): boolean {
    return this.vector?.isReady() ?? false;
  }

  /** 从 Markdown 文件全量重建向量索引（返回写入条数，失败降级返回 0） */
  async rebuildVectorIndex(): Promise<number> {
    this.initVector();
    if (!this.vector?.isReady()) return 0;
    const count = await this.vector.rebuildAll(this.memoryDir);
    this.vectorBuilt = this.vector.isReady();
    return count;
  }

  /** 关闭 FTS 索引 + 向量索引连接（释放 sqlite 文件句柄） */
  closeIndex(): void {
    this.index?.close();
    this.index = null;
    this.vector?.close();
    this.vector = null;
    this.vectorBuilt = false;
  }

  /**
   * 追加写入指定日期的文件
   * 格式：每个条目包含元数据 header + 内容
   * ```
   * ## {timestamp} [sessionId: xxx] [scope: session] [tag: tool]
   * {content}
   * ```
   * 同时同步更新 FTS 索引。
   */
  async append(day: string, content: string, options: AppendOptions = {}): Promise<void> {
    await this.init();
    const filepath = join(this.memoryDir, `${day}.md`);
    const timestamp = new Date().toISOString();

    // 构建元数据 header
    const metaParts = [timestamp];
    if (options.sessionId) metaParts.push(`sessionId: ${options.sessionId}`);
    if (options.scope) metaParts.push(`scope: ${options.scope}`);
    if (options.tag) metaParts.push(`tag: ${options.tag}`);

    const header = metaParts.map((p) => `[${p}]`).join(' ');
    const entry = `\n## ${header}\n${content.trim()}\n`;

    // 1. 文件是真相源：先写文件
    await appendFile(filepath, entry, 'utf-8');

    // 2. 同步更新索引（失败不影响文件写入）
    this.index?.add(day, entry.trim());

    // 3. Phase 5：向量增量嵌入（失败内部降级，不影响文件写入）
    await this.vector?.addEntry(day, entry.trim());
  }

  /** 快捷方法：写今天 */
  async appendToday(content: string, options: AppendOptions = {}): Promise<void> {
    const day = new Date().toISOString().split('T')[0];
    await this.append(day, content, options);
  }

  /** 读取某天完整内容 */
  async readDay(day: string): Promise<string> {
    const filepath = join(this.memoryDir, `${day}.md`);
    if (!fileExists(filepath)) return '';
    return readFile(filepath, 'utf-8');
  }

  /** 读取最近 N 天的内容 */
  async readRecentDays(days: number): Promise<{ day: string; content: string }[]> {
    const results: { day: string; content: string }[] = [];
    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const day = date.toISOString().split('T')[0];
      const content = await this.readDay(day);
      if (content) results.push({ day, content });
    }
    return results;
  }

  /**
   * 检索
   * Phase 5：向量可用时走混合检索（BM25 + 向量 RRF 融合）
   * Phase 4：索引可用时优先 SQLite FTS5（带 BM25 排序）
   * 兜底：降级为文件关键词匹配
   *
   * 检索规则：
   * - 如果指定 sessionId，返回 scope=global 的条目 + scope=session 且属于当前 session 的条目
   * - 如果指定 scope，则只返回该 scope 的条目
   */
  async search(query: string, topK = 5, options: SearchOptions = {}): Promise<MemorySearchResult[]> {
    // 1. 混合检索（向量 + FTS5，两者都可用且向量有结果时启用）
    const hybrid = await this.searchViaHybrid(query, topK, options);
    if (hybrid.length > 0) return hybrid;

    // 2. 优先 FTS5 索引（带 BM25 排序）
    const indexed = this.searchViaIndex(query, topK, options);
    if (indexed.length > 0) return indexed;

    // 3. 索引不可用或无结果 → 降级为文件关键词匹配
    return this.searchViaFiles(query, topK, options);
  }

  /** Phase 5：混合检索（BM25 + 向量 RRF 融合） */
  private async searchViaHybrid(
    query: string,
    topK: number,
    options: SearchOptions,
  ): Promise<MemorySearchResult[]> {
    if (!this.index?.isReady() || !this.vector?.isReady()) return [];

    // 首次使用时惰性全量构建向量索引（失败降级，不影响 BM25）
    await this.ensureVectorBuilt();
    if (!this.vector?.isReady()) return [];

    const expanded = Math.max(topK * 3, 10);
    const [bm25Entries, vecEntries] = await Promise.all([
      Promise.resolve(this.index.search(query, expanded)),
      this.vector.search(query, expanded),
    ]);
    // 向量检索无结果（相似度阈值内无命中）→ 走 FTS5/文件
    if (vecEntries.length === 0) return [];

    // BM25 结果要求原文精确包含关键词（bigram 可能部分命中）；向量结果按语义召回，无需原文匹配
    const bm25Filtered = this.filterEntries(bm25Entries, query, options, true);
    const vecFiltered = this.filterEntries(vecEntries, query, options, false);
    return rrfMerge(bm25Filtered, vecFiltered, 60, topK).map((e) => ({
      day: e.day,
      content: e.content,
      score: 1,
    }));
  }

  /** 确保向量索引已全量构建（懒加载，只构建一次） */
  private async ensureVectorBuilt(): Promise<void> {
    if (this.vectorBuilt || !this.vector?.isReady()) return;
    try {
      if (this.vector.count() === 0) {
        await this.vector.rebuildAll(this.memoryDir);
      }
      this.vectorBuilt = true;
    } catch {
      this.vectorBuilt = true; // 构建失败也标记，避免反复重建
    }
  }

  /** FTS5 索引检索（含 Session 过滤），索引不可用时返回空数组 */
  private searchViaIndex(
    query: string,
    topK: number,
    options: SearchOptions,
  ): MemorySearchResult[] {
    if (!this.index?.isReady()) return [];

    const entries = this.index.search(query, Math.max(topK * 3, 10));
    // FTS 可能按 bigram 部分命中，要求原文精确包含关键词
    return this.filterEntries(entries, query, options, true).slice(0, topK);
  }

  /**
   * 统一候选过滤：解析 section 结构 + Session 隔离
   * @param exact true=要求正文与 query 实质相关（sectionMatches：子串包含或中文 bigram 交集）；false=仅按语义召回（向量结果）
   */
  private filterEntries(
    entries: IndexedEntry[],
    query: string,
    options: SearchOptions,
    exact: boolean,
  ): MemorySearchResult[] {
    const results: MemorySearchResult[] = [];
    for (const entry of entries) {
      // entry.content 形如 "## {header}\n{body}"
      const lines = entry.content.split('\n');
      const sectionHeader = (lines[0] ?? '').replace(/^## /, '');
      const sectionBody = lines.slice(1).join('\n').trim();

      // 精确内容校验（FTS 可能按 bigram 部分命中，需确认实质相关）
      if (exact && !sectionMatches(query, sectionBody)) continue;

      // === Session 隔离过滤 ===
      if (!this.isSectionVisible(sectionHeader, options)) continue;

      results.push({
        day: entry.day,
        content: `## ${sectionHeader}${sectionBody}`,
        score: 1,
      });
    }
    return results;
  }

  /** 文件关键词匹配检索（降级路径） */
  private async searchViaFiles(
    query: string,
    topK: number,
    options: SearchOptions,
  ): Promise<MemorySearchResult[]> {
    const days = await this.listDays();
    const results: MemorySearchResult[] = [];

    for (const day of days) {
      const content = await this.readDay(day);
      if (!content) continue;

      // 按段落匹配（sectionMatches：子串包含或中文 bigram 交集）
      const sections = content.split(/^## /m);
      for (const section of sections) {
        const lines = section.split('\n');
        const sectionHeader = lines[0] ?? '';
        const sectionBody = lines.slice(1).join('\n').trim();

        if (!sectionMatches(query, sectionBody)) continue;

        // === Session 隔离过滤 ===
        if (!this.isSectionVisible(sectionHeader, options)) continue;

        results.push({
          day,
          content: `## ${sectionHeader}${sectionBody}`,
          score: 1, // 文件检索统一分数
        });
      }

      if (results.length >= topK) break;
    }

    return results.slice(0, topK);
  }

  /**
   * 判断条目是否对当前请求可见
   * - scope 过滤
   * - sessionId 过滤
   */
  private isSectionVisible(header: string, options: SearchOptions): boolean {
    // 解析 header 中的元数据
    const scopeMatch = header.match(/\[scope:\s*(\w+)\]/);
    const sessionMatch = header.match(/\[sessionId:\s*([^\]]+)\]/);

    const entryScope = scopeMatch?.[1] as MemoryScope | undefined;
    const entrySessionId = sessionMatch?.[1];

    // 1. 如果指定了 scope 过滤
    if (options.scope) {
      return entryScope === options.scope;
    }

    // 2. 如果指定了 sessionId，应用默认可见性规则
    if (options.sessionId) {
      // global 条目 → 所有会话可见
      if (entryScope === 'global') return true;

      // session 条目 → 仅创建它的会话可见
      if (entryScope === 'session') {
        // Task-17：无 sessionId 的旧条目（会话早期写入）→ 视为可见，避免成为数据黑洞
        if (!entrySessionId) return true;
        return entrySessionId === options.sessionId;
      }

      // 无 scope 标记的旧条目 → 默认可见（向后兼容）
      if (!entryScope) return true;
    }

    // 3. 无过滤条件 → 全部可见
    return true;
  }

  /** 列出所有可用的日期文件（按日期降序） */
  async listDays(): Promise<string[]> {
    // 仅确保目录存在；不初始化索引/向量（避免检索兜底路径反复重开 broken 索引）
    await mkdir(this.memoryDir, { recursive: true });
    const entries = await readdir(this.memoryDir, { withFileTypes: true });
    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name.replace('.md', ''))
      .sort((a, b) => b.localeCompare(a));
    return mdFiles;
  }

  /** 列出所有日期文件的摘要信息 */
  async listDaySummaries(): Promise<Array<{ day: string; entryCount: number; size: number }>> {
    const days = await this.listDays();
    const summaries: Array<{ day: string; entryCount: number; size: number }> = [];

    for (const day of days) {
      const filepath = join(this.memoryDir, `${day}.md`);
      const content = await this.readDay(day);
      const entryCount = (content.match(/^## /gm) ?? []).length;
      summaries.push({
        day,
        entryCount,
        size: content.length,
      });
    }

    return summaries;
  }

  /** 获取 memory 目录路径 */
  getMemoryDir(): string {
    return this.memoryDir;
  }
}
