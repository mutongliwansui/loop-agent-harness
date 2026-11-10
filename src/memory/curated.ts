// L3 Curated Core Memory：精炼常驻文件
// SOUL.md (Agent 人格) / USER.md (用户画像) / MEMORY.md (精炼事实)
// 启动时注入 system prompt，由 Dreaming 晋升写入
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { CuratedFileKey } from './types.js';
import type { MergeDecision } from './curated-dedupe.js';

/** Curated 文件溢出处理（行数超限时自动压缩） */
export interface CuratedOverflowOptions {
  /** 行数上限，0 表示不限制 */
  maxLines: number;
  /** 压缩文件内容（输入含新追加的事实）；返回精简后内容，null 表示放弃压缩走原追加 */
  compress: (content: string, key: CuratedFileKey) => Promise<string | null>;
}

function fileExists(path: string): boolean {
  return existsSync(path);
}

const FILE_MAP: Record<CuratedFileKey, string> = {
  soul: 'SOUL.md',
  user: 'USER.md',
  memory: 'MEMORY.md',
};

/** 归属全局用户目录的文件（SOUL/USER 跨项目共享），其余（MEMORY）归属项目目录 */
const GLOBAL_KEYS: CuratedFileKey[] = ['soul', 'user'];

/**
 * 注入 system prompt 时各文件的字符上限（需求 20261110-002 层 2 B 方案）。
 * 超过上限时保留末尾部分（最新条目），而非全量塞入。这样既能把 CURATED 段
 * 压到可控 token 数，又不打散前缀缓存——截断规则固定、截断后的 section 固定。
 * 注：磁盘上的文件仍全量保存，截断只发生在 system prompt 注入时。
 */
const SYSTEM_MAX_CHARS: Record<CuratedFileKey, number> = {
  soul: 300,   // SOUL 固定人格，几乎不会膨胀
  user: 800,   // USER.md 约 15 条 60 字事实
  memory: 3000,// MEMORY.md 约 50 条 60 字事实
};

/** 截断 marker：加在被截断的 section 末尾，告诉模型「前面省略了较早条目」 */
const TRUNCATION_NOTE = '\n…（较早内容因 token 预算已省略，以上为最新条目）';

const DEFAULT_CONTENT: Record<CuratedFileKey, string> = {
  soul: `# SOUL - Agent 人格

## 核心身份
你是一个基于 ReAct 框架的智能 Agent，擅长通过工具调用解决复杂问题。

## 沟通风格
- 使用中文回答
- 回答简洁清晰，结构化表达
`,
  user: `# USER - 用户画像

## 基本信息

## 偏好

## 约束
`,
  memory: `# MEMORY - 精炼事实

## 项目知识

## 关键决策

## 已知问题
`,
};

export class CuratedMemory {
  private workspaceDir: string;
  /** 全局用户目录（SOUL/USER 所在；未提供时回退到 workspaceDir，保持旧行为） */
  private globalDir: string | null;
  private overflow: CuratedOverflowOptions | null = null;
  /**
   * 20261021-008 R2：buildSystemPromptCached 的 section 缓存。
   * key → { mtimeMs, size, hash, section }；stat 未变化直接复用 section。
   * hash 字段保留内容指纹位（当前以长度近似，后续可换 djb2/FNV）。
   */
  private sectionCache: Map<
    CuratedFileKey,
    { mtimeMs: number; size: number; hash: number; section: string }
  > | null = null;
  constructor(
    workspaceDir: string,
    overflow?: CuratedOverflowOptions | null,
    globalDir?: string | null,
  ) {
    this.workspaceDir = workspaceDir;
    this.overflow = overflow ?? null;
    this.globalDir = globalDir ?? null;
  }

  /** 文件实际所在目录：全局文件走 globalDir，其余走 workspaceDir */
  private dirFor(key: CuratedFileKey): string {
    return this.globalDir && GLOBAL_KEYS.includes(key) ? this.globalDir : this.workspaceDir;
  }

  private filepathFor(key: CuratedFileKey): string {
    return join(this.dirFor(key), FILE_MAP[key]);
  }

  /** 初始化：创建文件（如不存在），并把旧版 workspace 下的 SOUL/USER 迁移到全局目录 */
  async init(): Promise<void> {
    await mkdir(this.workspaceDir, { recursive: true });
    if (this.globalDir) {
      await mkdir(this.globalDir, { recursive: true });
    }
    // 先迁移旧文件，再补建缺失文件（否则全局目标总存在，迁移被跳过）
    await this.migrateLegacyFiles();
    for (const key of Object.keys(FILE_MAP) as CuratedFileKey[]) {
      const filepath = this.filepathFor(key);
      if (!fileExists(filepath)) {
        await writeFile(filepath, DEFAULT_CONTENT[key], 'utf-8');
      }
    }
  }

  /** 迁移旧版：workspace 根目录下遗留的 SOUL.md / USER.md 搬到全局目录（目标已存在则跳过） */
  private async migrateLegacyFiles(): Promise<void> {
    if (!this.globalDir) return;
    for (const key of GLOBAL_KEYS) {
      const legacyPath = join(this.workspaceDir, FILE_MAP[key]);
      const targetPath = join(this.globalDir, FILE_MAP[key]);
      if (!fileExists(legacyPath) || fileExists(targetPath)) continue;
      try {
        await rename(legacyPath, targetPath);
      } catch {
        // 跨盘符时 rename 失败，回退为复制后删除
        try {
          const content = await readFile(legacyPath, 'utf-8');
          await writeFile(targetPath, content, 'utf-8');
          await rm(legacyPath, { force: true });
        } catch {
          // 迁移失败不影响启动
        }
      }
    }
  }

  /** 读取指定文件内容 */
  async read(key: CuratedFileKey): Promise<string> {
    const filepath = this.filepathFor(key);
    if (!fileExists(filepath)) return '';
    return readFile(filepath, 'utf-8');
  }

  /** 按文件名读取（用于 /memory read 命令） */
  async readByFilename(filename: string): Promise<string> {
    const key = (Object.keys(FILE_MAP) as CuratedFileKey[]).find(
      (k) => FILE_MAP[k] === filename,
    );
    if (!key) return '';
    return this.read(key);
  }

  /** 读取全部 Curated 文件，返回 system prompt 片段（注入时做软上限截断） */
  async buildSystemPrompt(): Promise<string> {
    const sections: string[] = [];
    for (const key of Object.keys(FILE_MAP) as CuratedFileKey[]) {
      const content = await this.read(key);
      if (content && content.trim()) {
        const title = FILE_MAP[key].replace('.md', '');
        sections.push(`# ${title}\n${this.clipForSystem(content.trim(), key)}`);
      }
    }
    return sections.join('\n\n');
  }

  /**
   * 把文件内容裁剪到 SYSTEM_MAX_CHARS 上限（需求 20261110-002 层 2 B 方案）。
   * 保留末尾部分（最新条目），前面加上截断 marker。
   * 纯函数，方便单测。
   */
  clipForSystem(content: string, key: CuratedFileKey): string {
    const max = SYSTEM_MAX_CHARS[key];
    if (content.length <= max) return content;
    // 截断时在「- 」起始处断，避免把一条事实切在中间
    const tailStart = Math.max(0, content.length - max);
    let cutIndex = content.indexOf('\n- ', tailStart);
    if (cutIndex === -1 || cutIndex < tailStart) {
      cutIndex = tailStart;
    } else {
      cutIndex += 1; // 跳过开头的 \n
    }
    const clipped = content.slice(cutIndex).replace(/^[^\n]*\n-/, '-');
    return `${TRUNCATION_NOTE}\n${clipped}`;
  }

  /**
   * 20261021-008 R2：buildSystemPrompt 的缓存版。
   * 按 key 记录 mtime+size+hash，stat 未变化时直接复用上次拼接结果，
   * 避免 assemble 每轮重读文件（读盘本身无缓存问题，风险在于文件变化后
   * system 段字节变化 → 其后全部消息前缀缓存 miss）。
   * 供 ContextAssembler 注入使用；buildSystemPrompt 原方法保留（CLI/命令直读场景）。
   */
  async buildSystemPromptCached(): Promise<string> {
    const keys = Object.keys(FILE_MAP) as CuratedFileKey[];
    // 全部文件 stat 短路检查
    const allUnchanged = this.sectionCache !== null
      && (await Promise.all(
        keys.map(async (key) => {
          const cached = this.sectionCache!.get(key);
          if (!cached) return false;
          try {
            const st = await stat(this.filepathFor(key));
            return st.mtimeMs === cached.mtimeMs && st.size === cached.size;
          } catch {
            return false; // 文件消失视为变化
          }
        }),
      )).every(Boolean);
    if (allUnchanged && this.sectionCache !== null) {
      return keys
        .map((key) => this.sectionCache!.get(key)?.section ?? '')
        .filter((s) => s !== '')
        .join('\n\n');
    }

    // 有变化：重读全部、重算 section 与 hash
    const newCache = new Map<CuratedFileKey, { mtimeMs: number; size: number; hash: number; section: string }>();
    const sections: string[] = [];
    for (const key of keys) {
      const filepath = this.filepathFor(key);
      let section = '';
      try {
        const content = (await readFile(filepath, 'utf-8')).trim();
        if (content) {
          const title = FILE_MAP[key].replace('.md', '');
          // 需求 20261110-002 层 2：注入 system 时做软上限截断，
          // 磁盘文件仍全量保存，截断只发生在注入环节
          section = `# ${title}\n${this.clipForSystem(content, key)}`;
          sections.push(section);
        }
      } catch {
        section = ''; // 读失败视同空文件（与 buildSystemPrompt 的容错语义一致）
      }
      let mtimeMs = 0;
      let size = 0;
      try {
        const st = await stat(filepath);
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {
        // 文件不存在：mtime/size 保持 0
      }
      newCache.set(key, { mtimeMs, size, hash: section.length, section });
    }
    this.sectionCache = newCache;
    return sections.join('\n\n');
  }

  /** 向指定文件追加一条事实 */
  async append(key: CuratedFileKey, fact: string): Promise<void> {
    const filepath = this.filepathFor(key);
    const current = fileExists(filepath)
      ? await readFile(filepath, 'utf-8')
      : DEFAULT_CONTENT[key];
    const newLine = `- ${fact}\n`;
    if (current.includes(newLine.trim())) return;
    const next = current + newLine;

    // 行数超限：自动触发 LLM 压缩（压缩输入含新事实，保证不丢）
    if (this.overflow && this.overflow.maxLines > 0) {
      const lineCount = next.split('\n').length;
      if (lineCount > this.overflow.maxLines) {
        try {
          const compressed = await this.overflow.compress(next, key);
          if (compressed && compressed.trim()) {
            await writeFile(filepath, compressed, 'utf-8');
            return;
          }
        } catch {
          // 压缩失败回退到直接追加，绝不丢事实
        }
      }
    }
    await writeFile(filepath, next, 'utf-8');
  }

  /** 根据文件名追加事实（供 Dreaming 调用） */
  async appendByFilename(filename: string, fact: string): Promise<void> {
    const key = (Object.keys(FILE_MAP) as CuratedFileKey[]).find(
      (k) => FILE_MAP[k] === filename,
    );
    if (!key) return;
    await this.append(key, fact);
  }

  /**
   * 按 LLM 归并决策批量应用写入（Dreaming 去重使用）
   * - merge：替换指定行号（从后往前，避免行号偏移）
   * - append：追加到文件末尾（沿用整行去重兜底）
   * - skip：跳过
   */
  async applyDecisions(
    key: CuratedFileKey,
    decisions: MergeDecision[],
    candidates: string[],
  ): Promise<{ appended: number; merged: number; skipped: number }> {
    const filepath = this.filepathFor(key);
    const lines = (await readFile(filepath, 'utf-8')).split('\n');

    // merge 先应用，按行号从大到小替换避免偏移
    const merges = decisions
      .filter((d) => d.action === 'merge' && typeof d.line === 'number' && d.newText)
      .sort((a, b) => (b.line ?? 0) - (a.line ?? 0));
    for (const d of merges) {
      if (d.line! >= 1 && d.line! <= lines.length) {
        lines[d.line! - 1] = `- ${d.newText}`;
      }
    }

    // append 追加到末尾
    const appended: MergeDecision[] = [];
    for (const d of decisions) {
      if (d.action !== 'append') continue;
      const fact = candidates[d.index]?.trim();
      if (!fact) continue;
      const line = `- ${fact}`;
      if (!lines.includes(line)) {
        lines.push(line);
        appended.push(d);
      }
    }

    await writeFile(filepath, lines.join('\n'), 'utf-8');
    return {
      appended: appended.length,
      merged: merges.length,
      skipped: decisions.length - appended.length - merges.length,
    };
  }

  /** 获取工作空间目录 */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  /** 获取所有 Curated 文件的完整路径列表 */
  getFilePaths(): Record<CuratedFileKey, string> {
    const result = {} as Record<CuratedFileKey, string>;
    for (const key of Object.keys(FILE_MAP) as CuratedFileKey[]) {
      result[key] = this.filepathFor(key);
    }
    return result;
  }
}