// L2 Episodic Memory：按天 Markdown 文件存储的情景记忆
// Phase 1：简单文件内容检索（关键词匹配）+ Session 隔离
// Phase 4：升级为 SQLite FTS5 全文搜索
import { mkdir, appendFile, readFile, readdir, access, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import type { MemorySearchResult } from './types.js';

function fileExists(path: string): boolean {
  return existsSync(path);
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

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
  }

  /** 初始化：创建 memory 目录 */
  async init(): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
  }

  /**
   * 追加写入指定日期的文件
   * 格式：每个条目包含元数据 header + 内容
   * ```
   * ## {timestamp} [sessionId: xxx] [scope: session] [tag: tool]
   * {content}
   * ```
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
    await appendFile(filepath, entry, 'utf-8');
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
   * Phase 1 简单关键词匹配检索（支持 session 隔离）
   * Phase 4 升级为 SQLite FTS5 全文搜索
   *
   * 检索规则：
   * - 如果指定 sessionId，返回 scope=global 的条目 + scope=session 且属于当前 session 的条目
   * - 如果指定 scope，则只返回该 scope 的条目
   */
  async search(query: string, topK = 5, options: SearchOptions = {}): Promise<MemorySearchResult[]> {
    const days = await this.listDays();
    const results: MemorySearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    for (const day of days) {
      const content = await this.readDay(day);
      if (!content) continue;

      const lowerContent = content.toLowerCase();
      if (!lowerContent.includes(lowerQuery)) continue;

      // 按段落匹配，找到包含关键词的段落
      const sections = content.split(/^## /m);
      for (const section of sections) {
        const lines = section.split('\n');
        const sectionHeader = lines[0] ?? '';
        const sectionBody = lines.slice(1).join('\n').trim();

        if (!sectionBody.toLowerCase().includes(lowerQuery)) continue;

        // === Session 隔离过滤 ===
        if (!this.isSectionVisible(sectionHeader, options)) continue;

        results.push({
          day,
          content: `## ${sectionHeader}${sectionBody}`,
          score: 1, // Phase 1 统一分数
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
    await this.init();
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
