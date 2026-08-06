import { createHash } from 'node:crypto';
import { join } from 'node:path';
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
import type { ChatMessage, AgentStep } from '../types.js';
import type { SessionMeta, SessionData, WorkspaceMeta } from './types.js';
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

export class SessionStore {
  private workspaceId: string;
  private workspaceDir: string;
  private currentSessionId: string | null = null;

  constructor(workspacePath: string = process.cwd()) {
    this.workspaceId = workspaceId(workspacePath);
    this.workspaceDir = join(homedir(), '.loop-agent', 'sessions', this.workspaceId);
  }

  /** 当前会话 ID */
  get currentId(): string | null {
    return this.currentSessionId;
  }

  /** 当前工作空间 ID */
  get id(): string {
    return this.workspaceId;
  }

  /**
   * 初始化：确保密钥已加载，创建目录
   */
  async init(): Promise<void> {
    keychain.ensureUnlocked();
    await mkdir(this.workspaceDir, { recursive: true });
    await this.touchWorkspaceMeta();
  }

  /**
   * 创建新会话
   */
  async createSession(
    firstMessage: string,
    messages: ChatMessage[],
    steps: AgentStep[],
  ): Promise<SessionMeta> {
    const id = `sess_${formatDate(new Date())}`;
    const now = new Date().toISOString();
    const data: SessionData = {
      id,
      messages,
      steps,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeSession(data);
    const meta = this.toMeta(data, firstMessage);
    await this.appendIndex(meta);
    this.currentSessionId = id;
    return meta;
  }

  /**
   * 更新会话（追加新消息）
   */
  async updateSession(
    id: string,
    messages: ChatMessage[],
    steps: AgentStep[],
  ): Promise<void> {
    const data = await this.readSession(id);
    data.messages = messages;
    data.steps = steps;
    data.updatedAt = new Date().toISOString();
    await this.writeSession(data);
    await this.updateIndex(id, {
      messageCount: messages.length,
      updatedAt: data.updatedAt,
    });
  }

  /**
   * 加载会话
   */
  async loadSession(id: string): Promise<SessionData> {
    const data = await this.readSession(id);
    this.currentSessionId = id;
    return data;
  }

  /**
   * 列出当前工作空间的所有会话
   */
  async listSessions(): Promise<SessionMeta[]> {
    return this.readIndex();
  }

  /**
   * 删除会话
   */
  async deleteSession(id: string): Promise<void> {
    const encFile = join(this.workspaceDir, `${id}.enc`);
    if (await fileExists(encFile)) {
      await unlink(encFile);
    }
    await this.removeFromIndex(id);
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

  private async writeSession(data: SessionData): Promise<void> {
    const key = keychain.getKey();
    if (!key) {
      throw new Error('密钥未加载，无法保存会话');
    }
    const encrypted = encrypt(data, key);
    await writeFile(join(this.workspaceDir, `${data.id}.enc`), encrypted, 'utf-8');
  }

  private async readSession(id: string): Promise<SessionData> {
    const key = keychain.getKey();
    if (!key) {
      throw new Error('密钥未加载，无法读取会话');
    }
    const encrypted = await readFile(join(this.workspaceDir, `${id}.enc`), 'utf-8');
    return decrypt<SessionData>(encrypted, key);
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
    updates: Partial<Pick<SessionMeta, 'messageCount' | 'updatedAt'>>,
  ): Promise<void> {
    const sessions = await this.readIndex();
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx >= 0) {
      sessions[idx] = { ...sessions[idx], ...updates };
      await this.writeIndex(sessions);
    }
  }

  private async removeFromIndex(id: string): Promise<void> {
    const sessions = await this.readIndex();
    const filtered = sessions.filter((s) => s.id !== id);
    await this.writeIndex(filtered);
  }

  private toMeta(data: SessionData, firstMessage: string): SessionMeta {
    const title = firstMessage.slice(0, 50);
    return {
      id: data.id,
      title,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messageCount: data.messages.length,
      file: `${data.id}.enc`,
    };
  }

  private async touchWorkspaceMeta(): Promise<void> {
    const metaFile = join(this.workspaceDir, 'meta.json');
    let meta: WorkspaceMeta;
    if (await fileExists(metaFile)) {
      const content = await readFile(metaFile, 'utf-8');
      meta = JSON.parse(content) as WorkspaceMeta;
      meta.lastAccessedAt = new Date().toISOString();
    } else {
      meta = {
        workspacePath: process.cwd(),
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      };
    }
    await writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
  }
}
