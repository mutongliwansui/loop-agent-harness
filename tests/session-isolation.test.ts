/**
 * Session 恢复和隔离功能测试
 * 
 * 测试内容：
 * 1. Session 分层存储（recentMessages / lastSummary / archivedMessages）
 * 2. Session 分层恢复（只加载 recentMessages，lastSummary 注入）
 * 3. L2 Episodic Memory Session 隔离（scope: session 只在当前会话可见）
 * 4. L2 Episodic Memory 全局共享（scope: global 跨会话可见）
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { SessionStore } from '../src/session/store.js';
import { EpisodicMemory } from '../src/memory/episodic.js';
import { keychain } from '../src/session/keychain.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

const TEST_DIR = join(homedir(), '.loop-agent', 'test-session-isolation');
const MEMORY_DIR = join(process.cwd(), 'memory');

describe('Session 分层存储和恢复', () => {
  let store: SessionStore;
  let episodic: EpisodicMemory;
  const testWorkspaceId = 'test_isolation_workspace';

  beforeAll(async () => {
    // 清理测试数据
    const sessionsDir = join(homedir(), '.loop-agent', 'sessions