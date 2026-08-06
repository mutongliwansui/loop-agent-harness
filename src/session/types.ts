import type { ChatMessage, AgentStep } from '../types.js';

/** 会话元信息（存储在索引中，不含消息内容） */
export interface SessionMeta {
  /** 会话 ID */
  id: string;
  /** 会话标题（首条用户消息前 50 字符） */
  title: string;
  /** 创建时间 ISO */
  createdAt: string;
  /** 更新时间 ISO */
  updatedAt: string;
  /** 消息数量 */
  messageCount: number;
  /** 加密文件名 */
  file: string;
}

/** 完整会话数据（加密存储的内容） */
export interface SessionData {
  id: string;
  messages: ChatMessage[];
  steps: AgentStep[];
  createdAt: string;
  updatedAt: string;
}

/** 工作空间元信息 */
export interface WorkspaceMeta {
  workspacePath: string;
  createdAt: string;
  lastAccessedAt: string;
}

/** 会话存储配置 */
export interface SessionConfig {
  autoSave: boolean;
  autoRestore: boolean;
  encryptionEnabled: boolean;
}

/** 默认会话配置 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  autoSave: true,
  autoRestore: true,
  encryptionEnabled: true,
};
