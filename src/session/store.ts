import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  mkdir,
  readFile,
  writeFile,
  access,
  readdir,
  unlink,
  rm,
} from 'node:fs/promises';
import type { ChatMessage } from '../types.js';
import type { SessionMeta, SessionData, WorkspaceMeta, WorkspaceSummary } from './types.js';
import { stripMemorySection } from '../memory/memory-section.js';
import { encrypt, decrypt } from './crypto.js';
import { keychain } from './keychain.js';

/** 检查文件是否存在 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 生成工作空间 ID（路径 SHA-256 前 16 位） */
export function workspaceId(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

/** 格式化日期为文件名安全格式 */
function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 摘要占位消息的固定前缀（buildCompactedView 注入；落盘为总结消息时剥离） */
const SUMMARY_PLACEHOLDER_PREFIX = '[历史摘要]';

/** 判断一条已落盘消息是否为「压缩总结消息」（role 非 system 且 is_show===false） */
function isSummaryMessage(m: ChatMessage): boolean {
  return m.role !== 'system' && m.is_show === false;
}

/** 会话数据文件缺失（索引有条目但落盘文件不存在，如存储被清理/跨扩展名切换） */
export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`会话不存在或已被删除: ${id}`);
    this.name = 'SessionNotFoundError';
  }
}

/** 规范化一条运行时消息为可落盘形式：重算 is_compact/is_show/show_content */
function toStoredMessage(
  m: ChatMessage,
  opts: { isCompact: boolean; isSummary?: boolean },
): ChatMessage {
  const out = { ...m } as ChatMessage;
  out.is_compact = m.role === 'system' ? false : opts.isCompact;
  out.is_show = m.role === 'system' ? false : opts.isSummary !== true;
  if (m.role === 'user' && typeof m.content === 'string') {
    // content 保存 LLM 可见原文（可能含记忆前缀）；展示内容单独存 show_content
    const stripped = stripMemorySection(m.content);
    if (stripped !== m.content) out.show_content = stripped;
  }
  return out;
}

/** 从摘要占位/总结消息里取纯净摘要文本（去掉 [历史摘要] 前缀） */
function extractSummaryText(placeholder: ChatMessage): string {
  const text = typeof placeholder.content === 'string' ? placeholder.content : '';
  return text.startsWith(SUMMARY_PLACEHOLDER_PREFIX)
    ? text.slice(SUMMARY_PLACEHOLDER_PREFIX.length).trim()
    : text.trim();
}

// 检查两条消息是否重复（考虑所有关键字段）
function isSameMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.content !== b.content) return false;
  if (a.role === 'assistant' && b.role === 'assistant') {
    const aCalls = a.tool_calls ?? [];
    const bCalls = b.tool_calls ?? [];
    if (aCalls.length !== bCalls.length) return false;
    return aCalls.every((ac, i) => {
      const bc = bCalls[i];
      return ac.id === bc.id && ac.function.name === bc.function.name && ac.function.arguments === bc.function.arguments;
    });
  }
  if (a.role === 'tool' && b.role === 'tool') {
    return a.tool_call_id === b.tool_call_id;
  }
  return true;
}

export class SessionStore {
  private workspacePath: string;
  private workspaceId: string;
  private workspaceDir: string;
  private readonly userDir: string;
  private currentSessionId: string | null = null;
  /** 是否启用加密存储 */
  private readonly encryptionEnabled: boolean;

  constructor(
    workspacePath: string = process.cwd(),
    encryptionEnabled = true,
    userDir: string = join(homedir(), '.loop-agent'),
  ) {
    this.userDir = userDir;
    this.workspacePath = workspacePath;
    this.workspaceId = workspaceId(workspacePath);
    this.workspaceDir = join(userDir, 'sessions', this.workspaceId);
    this.encryptionEnabled = encryptionEnabled;
  }

  /** 当前会话 ID */
  get currentId(): string | null {
    return this.currentSessionId;
  }

  /** 当前工作空间 ID */
  get id(): string {
    return this.workspaceId;
  }

  /** 是否启用加密存储 */
  get isEncrypted(): boolean {
    return this.encryptionEnabled;
  }

  /** 当前工作空间路径 */
  get path(): string {
    return this.workspacePath;
  }

  /**
   * 原地重绑到新工作空间路径（切换空间）：更新空间三元组并重新初始化（建目录 + 写 meta）。
   * 需配合 process.chdir(path) 使用，使 agent / skills 等 cwd 依赖跟随新空间。
   */
  async rebindWorkspace(path: string): Promise<void> {
    this.workspacePath = path;
    this.workspaceId = workspaceId(path);
    this.workspaceDir = join(this.userDir, 'sessions', this.workspaceId);
    this.currentSessionId = null;
    await this.init();
  }

  /**
   * 初始化：加密模式下确保密钥已加载，创建目录
   */
  async init(): Promise<void> {
    if (this.encryptionEnabled) {
      keychain.ensureUnlocked();
    }
    await mkdir(this.workspaceDir, { recursive: true });
    await this.touchWorkspaceMeta();
  }

  /**
   * 创建新会话：messages 直接落盘（含 system），标记规范化后写入索引。
   * 与 updateSession 压缩分支对齐：传入消息含摘要占位（is_show=false 的 user 消息，
   * 首轮即触发 L1 压缩）时，占位原位转写为总结消息（剥离 [历史摘要] 前缀），避免摘要丢失。
   */
  async createSession(
    firstMessage: string,
    messages: ChatMessage[],
  ): Promise<SessionMeta> {
    const id = `sess_${formatDate(new Date())}`;
    const now = new Date().toISOString();

    const stored: ChatMessage[] = [];
    for (const m of messages) {
      if (isSummaryMessage(m)) {
        stored.push(
          toStoredMessage(
            { role: 'user', content: extractSummaryText(m) },
            { isCompact: false, isSummary: true },
          ),
        );
      } else {
        stored.push(toStoredMessage(m, { isCompact: false }));
      }
    }

    const data: SessionData = {
      id,
      createdAt: now,
      updatedAt: now,
      messages: stored,
    };

    await this.writeSession(data);
    const meta = this.toMeta(data, firstMessage);
    await this.appendIndex(meta);
    this.currentSessionId = id;
    return meta;
  }

  /**
   * 更新会话：以已有全量历史为底，去重追加本次消息。
   * - 未压缩轮次：直接追加（保留已有条目的标记）
   * - 本轮发生 L1 压缩（messages 中出现摘要占位：is_show=false 的 user 消息）：重建标记——
   *   边界之前的消息标记 is_compact=true（折叠进摘要），写入新的总结消息（is_show=false、role=user），
   *   边界之后（压缩后保留的最近轮次）标记 is_compact=false
   * @param firstUserMessage 调用方持有的本次原始用户输入（可选）。会话标题缺失时优先用它生成——
   *   messages 可能已被 L1 压缩重写（首问被摘要替换），从消息推断不可靠。
   * @returns 归一化后的会话消息（全量历史，含 system 及 is_compact/is_show/show_content 标记），
   *   调用方可直接用作下一轮基线（摘要占位已转写为总结消息）
   */
  async updateSession(
    id: string,
    messages: ChatMessage[],
    firstUserMessage?: string,
  ): Promise<ChatMessage[]> {
    const data = await this.readSession(id);
    const prev = data.messages ?? [];

    const system = messages.find((m) => m.role === 'system') ?? prev.find((m) => m.role === 'system');
    const prevNonSystem = prev.filter((m) => m.role !== 'system');
    // 本次传入的非 system 真实消息（去掉摘要占位）
    const incomingKept = messages.filter((m) => m.role !== 'system' && !isSummaryMessage(m));
    // 本轮是否发生压缩：由 compact() 注入的摘要占位（is_show=false 的 user 消息）标识
    const summaryPlaceholder = messages.find((m) => isSummaryMessage(m));

    let nextNonSystem: ChatMessage[];
    if (summaryPlaceholder) {
      // 压缩轮次：丢弃旧总结消息（被新总结取代），以全量历史重建压缩边界
      const base = prevNonSystem.filter((m) => !isSummaryMessage(m));
      const kept = incomingKept.filter((m) => !isSummaryMessage(m));
      const full: ChatMessage[] = [...base];
      for (const m of kept) {
        if (!full.some((x) => isSameMessage(x, m))) full.push(m);
      }
      // 边界 = 压缩后保留的最近轮次（kept 首条）在全量历史中的位置
      const firstKept = kept[0];
      let boundary = firstKept ? full.findIndex((x) => isSameMessage(x, firstKept)) : full.length;
      if (boundary < 0) boundary = full.length;

      const compacted = full.slice(0, boundary).map((m) => toStoredMessage(m, { isCompact: true }));
      const recent = full.slice(boundary).map((m) => toStoredMessage(m, { isCompact: false }));
      const summaryMsg = toStoredMessage(
        { role: 'user', content: extractSummaryText(summaryPlaceholder) },
        { isCompact: false, isSummary: true },
      );
      nextNonSystem = [...compacted, summaryMsg, ...recent];
    } else {
      // 未压缩轮次：保留已有条目（含其标记），仅去重追加新消息
      nextNonSystem = [...prevNonSystem];
      for (const m of incomingKept) {
        if (!nextNonSystem.some((x) => isSameMessage(x, m))) {
          nextNonSystem.push(toStoredMessage(m, { isCompact: false }));
        }
      }
      // 防膨胀：极端情况封顶
      if (nextNonSystem.length > 4000) nextNonSystem = nextNonSystem.slice(-4000);
    }

    data.messages = system
      ? [toStoredMessage(system, { isCompact: false }), ...nextNonSystem]
      : nextNonSystem;
    data.updatedAt = new Date().toISOString();

    await this.writeSession(data);
    // 会话标题：WebUI「先建空会话、后发消息」时 createSession 的 title 为空——用首条用户消息补生成（已有 title 不覆盖）
    const updates: Partial<Pick<SessionMeta, 'title' | 'messageCount' | 'updatedAt'>> = {
      messageCount: data.messages.length,
      updatedAt: data.updatedAt,
    };
    const current = (await this.readIndex()).find((m) => m.id === id);
    if (current && !current.title) {
      // 标题来源优先级：调用方显式传入的原始输入 > 消息推断（首条 user 可能带 L2 记忆前缀，需剥离；
      // 且 L1 压缩后首问可能已被摘要替换，故推断仅作 fallback）
      const explicit = firstUserMessage?.trim();
      const firstUser = messages.find((m) => m.role === 'user' && !isSummaryMessage(m));
      const text = explicit || (firstUser && typeof firstUser.content === 'string'
        ? stripMemorySection(firstUser.content).trim()
        : '');
      if (text) updates.title = text.slice(0, 50);
    }
    await this.updateIndex(id, updates);
    return data.messages;
  }

  /**
   * 加载会话（仅支持新结构：单一 messages 数组 + per-message 标记）
   */
  async loadSession(id: string): Promise<SessionData> {
    const data = await this.readSession(id);
    this.currentSessionId = id;
    return data;
  }

  /**
   * 返回会话全量历史（含 system）。messages 已是唯一真源，
   * 展示层自行按 is_show 过滤（system 与压缩总结消息不展示）。
   */
  static getAllAvailableMessages(data: SessionData): ChatMessage[] {
    return data.messages ?? [];
  }

  /**
   * 获取用于恢复对话的消息：system（当前配置重建） + 所有 is_compact!==true 的消息。
   * 被压缩折叠进摘要的历史（is_compact=true）不参与上下文；摘要本身是一条
   * is_show=false、is_compact=false 的 user 消息，会自然进入上下文。
   * 输出不含历史 system（由调用方的 systemPrompt 决定）。
   */
  static getRestoreMessages(
    data: SessionData,
    systemPrompt?: string,
  ): ChatMessage[] {
    const result: ChatMessage[] = [];
    if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
    for (const m of data.messages ?? []) {
      if (m.role === 'system') continue;
      if (m.is_compact === true) continue;
      result.push(m);
    }
    return result;
  }

  /**
   * 列出当前工作空间的所有会话
   */
  async listSessions(): Promise<SessionMeta[]> {
    return this.readIndex();
  }

  /**
   * 聚合所有工作空间：扫描 <userDir>/sessions/* 下的 meta.json 与 sessions.json
   * （两者均为明文索引，无需解密）；按空间首次使用时间（createdAt）升序——顺序稳定，
   * 切换当前空间不影响排列，仅「当前」标记随空间移动。
   * 旧 meta.json 无 workspaceName 时回退为工作路径目录名。
   */
  async listAllWorkspaces(): Promise<WorkspaceSummary[]> {
    const root = dirname(this.workspaceDir);
    let dirs: string[];
    try {
      dirs = (await readdir(root, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return []; // sessions 根目录不存在
    }
    const result: WorkspaceSummary[] = [];
    for (const dir of dirs) {
      const wsDir = join(root, dir);
      let meta: WorkspaceMeta;
      try {
        meta = JSON.parse(await readFile(join(wsDir, 'meta.json'), 'utf-8')) as WorkspaceMeta;
      } catch {
        continue; // meta.json 缺失或损坏：无归属信息，不展示
      }
      let sessions: SessionMeta[] = [];
      try {
        sessions = JSON.parse(await readFile(join(wsDir, 'sessions.json'), 'utf-8')) as SessionMeta[];
      } catch {
        // 索引缺失/损坏：展示空间本身，会话数为 0
      }
      result.push({
        id: dir,
        name: meta.workspaceName || basename(meta.workspacePath) || dir,
        path: meta.workspacePath,
        current: dir === this.workspaceId,
        createdAt: meta.createdAt,
        lastAccessedAt: meta.lastAccessedAt,
        sessions: sessions.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
      });
    }
    // 顺序稳定：按空间首次使用时间升序（新空间追加在末尾），切换不改变排列
    return result.sort(
      (a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
    );
  }

  /**
   * 删除会话
   */
  async deleteSession(id: string): Promise<void> {
    const found = await this.findSessionFile(id);
    if (found) {
      // 同目录下两种扩展名一并清理（加密开关切换可能留下另一扩展名的残留）
      for (const name of [`${id}.enc`, `${id}.json`]) {
        const filePath = join(found.dir, name);
        if (await fileExists(filePath)) {
          await unlink(filePath);
        }
      }
      await this.removeFromIndex(id, found.dir);
    } else {
      // 落盘文件已缺失：仍清理索引，避免僵尸条目
      await this.removeFromIndex(id);
    }
    if (this.currentSessionId === id) {
      this.currentSessionId = null;
    }
  }

  /**
   * 删除当前工作空间的全部会话
   */
  async deleteAllSessions(): Promise<void> {
    const sessions = await this.listSessions();
    for (const s of sessions) {
      await this.deleteSession(s.id);
    }
  }

  /**
   * 获取最近的会话（按 updatedAt 排序）
   */
  async getLatestSession(): Promise<SessionMeta | null> {
    const sessions = await this.listSessions();
    if (sessions.length === 0) return null;
    return sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )[0];
  }

  // ===== 私有方法 =====

  private get sessionFileExt(): string {
    return this.encryptionEnabled ? '.enc' : '.json';
  }

  /**
   * 解析会话文件所在的工作空间目录：先查当前空间，未命中则扫描兄弟空间
   * （跨工作空间读取/删除用）；都未命中回退当前空间（新会话写入当前空间）。
   */
  private async resolveWorkspaceDir(id: string): Promise<string> {
    if (await fileExists(join(this.workspaceDir, `${id}${this.sessionFileExt}`))) {
      return this.workspaceDir;
    }
    const root = dirname(this.workspaceDir);
    try {
      for (const d of await readdir(root, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === this.workspaceId) continue;
        const candidate = join(root, d.name);
        if (await fileExists(join(candidate, `${id}${this.sessionFileExt}`))) {
          return candidate;
        }
      }
    } catch {
      // 根目录不可读：回退当前空间
    }
    return this.workspaceDir;
  }

  /**
   * 定位会话落盘文件：当前空间优先，其次兄弟空间（跨工作空间读取/删除用）。
   * 同时兼容 .enc/.json 两种扩展名——加密开关切换后旧会话仍可读。
   * 找不到返回 null（writeSession 落新盘时改走 resolveWorkspaceDir 回退当前空间）。
   */
  private async findSessionFile(
    id: string,
  ): Promise<{ dir: string; file: string; encrypted: boolean } | null> {
    const root = dirname(this.workspaceDir);
    const dirs = [this.workspaceDir];
    try {
      for (const d of await readdir(root, { withFileTypes: true })) {
        if (d.isDirectory() && d.name !== this.workspaceId) dirs.push(join(root, d.name));
      }
    } catch {
      // 根目录不可读：仅查当前空间
    }
    for (const dir of dirs) {
      for (const [name, encrypted] of [
        [`${id}.enc`, true],
        [`${id}.json`, false],
      ] as const) {
        const file = join(dir, name);
        if (await fileExists(file)) return { dir, file, encrypted };
      }
    }
    return null;
  }

  private async writeSession(data: SessionData): Promise<void> {
    const dir = await this.resolveWorkspaceDir(data.id);
    const filePath = join(dir, `${data.id}${this.sessionFileExt}`);
    if (this.encryptionEnabled) {
      const key = keychain.getKey();
      if (!key) {
        throw new Error('密钥未加载，无法保存会话');
      }
      const encrypted = encrypt(data, key);
      await writeFile(filePath, encrypted, 'utf-8');
    } else {
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    }
  }

  private async readSession(id: string): Promise<SessionData> {
    const found = await this.findSessionFile(id);
    if (!found) {
      throw new SessionNotFoundError(id);
    }
    const raw = await readFile(found.file, 'utf-8');
    if (found.encrypted) {
      const key = keychain.getKey();
      if (!key) {
        throw new Error('密钥未加载，无法读取会话');
      }
      return decrypt<SessionData>(raw, key);
    }
    return JSON.parse(raw) as SessionData;
  }

  private async readIndex(): Promise<SessionMeta[]> {
    const indexFile = join(this.workspaceDir, 'sessions.json');
    if (!(await fileExists(indexFile))) {
      return [];
    }
    const content = await readFile(indexFile, 'utf-8');
    return JSON.parse(content) as SessionMeta[];
  }

  private async writeIndex(sessions: SessionMeta[]): Promise<void> {
    const indexFile = join(this.workspaceDir, 'sessions.json');
    await writeFile(indexFile, JSON.stringify(sessions, null, 2), 'utf-8');
  }

  private async appendIndex(meta: SessionMeta): Promise<void> {
    const sessions = await this.readIndex();
    sessions.push(meta);
    await this.writeIndex(sessions);
  }

  private async updateIndex(
    id: string,
    updates: Partial<Pick<SessionMeta, 'title' | 'messageCount' | 'updatedAt'>>,
    dir: string = this.workspaceDir,
  ): Promise<void> {
    const indexFile = join(dir, 'sessions.json');
    const sessions = (await fileExists(indexFile))
      ? (JSON.parse(await readFile(indexFile, 'utf-8')) as SessionMeta[])
      : [];
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx >= 0) {
      sessions[idx] = { ...sessions[idx], ...updates };
      await writeFile(indexFile, JSON.stringify(sessions, null, 2), 'utf-8');
    }
  }

  private async removeFromIndex(id: string, dir: string = this.workspaceDir): Promise<void> {
    const indexFile = join(dir, 'sessions.json');
    if (!(await fileExists(indexFile))) return;
    const sessions = JSON.parse(await readFile(indexFile, 'utf-8')) as SessionMeta[];
    const filtered = sessions.filter((s) => s.id !== id);
    await writeFile(indexFile, JSON.stringify(filtered, null, 2), 'utf-8');
  }

  private toMeta(data: SessionData, firstMessage: string): SessionMeta {
    const title = firstMessage.slice(0, 50);
    return {
      id: data.id,
      title,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messageCount: data.messages?.length ?? 0,
      file: `${data.id}${this.sessionFileExt}`,
    };
  }

  private async touchWorkspaceMeta(): Promise<void> {
    const metaFile = join(this.workspaceDir, 'meta.json');
    const workspaceName = basename(this.workspacePath);
    let meta: WorkspaceMeta;
    if (await fileExists(metaFile)) {
      const content = await readFile(metaFile, 'utf-8');
      meta = JSON.parse(content) as WorkspaceMeta;
      meta.lastAccessedAt = new Date().toISOString();
      meta.workspaceName = workspaceName;
    } else {
      meta = {
        workspacePath: this.workspacePath,
        workspaceName,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      };
    }
    await writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
  }
}
