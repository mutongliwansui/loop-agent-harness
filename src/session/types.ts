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

/** 完整会话数据（加密存储的内容） - 改造后支持分层存储 */
export interface SessionData {
  id: string;
  /** 创建时间 ISO */
  createdAt: string;
  /** 更新时间 ISO */
  updatedAt: string;
  
  // 原有字段（兼容旧格式，逐步迁移到分层结构）
  /** @deprecated 使用 recentMessages 替代 */
  messages?: ChatMessage[];
  /** @deprecated 保留兼容 */
  steps?: AgentStep[];
  
  // 分层存储字段（新格式）
  /** L1 压缩产物：上次会话摘要，注入系统提示词 */
  lastSummary?: string;
  /** 最近 N 轮对话（L1 工作集），恢复时加载到 _chatHistory */
  recentMessages?: ChatMessage[];
  /** 归档消息（可选，不参与上下文） */
  archivedMessages?: ChatMessage[];
  /** 归档消息数（用于显示） */
  archivedCount?: number;
  /** 保存时的最近轮数配置 */
  recentTurns?: number;
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
