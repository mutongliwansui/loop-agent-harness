/**
 * agent.loading 配置默认值测试（Task-20260930-001 P1 4.5）
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/schema.js';

describe('agent.loading（P1 4.5）', () => {
  it('默认开启 loading 指示器', () => {
    expect(DEFAULT_CONFIG.agent.loading).toBe(true);
  });

  it('字段存在于 agent 配置结构', () => {
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG.agent, 'loading')).toBe(true);
  });
});
