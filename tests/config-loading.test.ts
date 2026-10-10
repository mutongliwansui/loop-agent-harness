/**
 * agent.loading 配置默认值测试（Task-20260930-001 P1 4.5）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { configLoader } from '../src/config/loader.js';

describe('agent.loading（P1 4.5）', () => {
  it('默认开启 loading 指示器', () => {
    expect(DEFAULT_CONFIG.agent.loading).toBe(true);
  });

  it('字段存在于 agent 配置结构', () => {
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG.agent, 'loading')).toBe(true);
  });
});

describe('VISION_* 环境变量（Task-20261010-001）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('VISION_API_KEY 生效并自动启用视觉功能', () => {
    vi.stubEnv('VISION_BASE_URL', '');
    vi.stubEnv('VISION_MODEL', '');
    vi.stubEnv('VISION_API_KEY', 'sk-vision-test');
    const cfg = configLoader.loadFromEnv();
    expect(cfg.vision).toEqual({ apiKey: 'sk-vision-test', enabled: true });
  });

  it('VISION_MODEL 生效并自动启用视觉功能', () => {
    vi.stubEnv('VISION_API_KEY', '');
    vi.stubEnv('VISION_BASE_URL', '');
    vi.stubEnv('VISION_MODEL', 'glm-4v');
    const cfg = configLoader.loadFromEnv();
    expect(cfg.vision).toEqual({ model: 'glm-4v', enabled: true });
  });

  it('VISION_BASE_URL 只设置 baseUrl，不自动启用', () => {
    vi.stubEnv('VISION_API_KEY', '');
    vi.stubEnv('VISION_MODEL', '');
    vi.stubEnv('VISION_BASE_URL', 'https://vision.example.com/v1');
    const cfg = configLoader.loadFromEnv();
    expect(cfg.vision).toEqual({ baseUrl: 'https://vision.example.com/v1' });
  });

  it('三者都未设置时不产生 vision 配置层', () => {
    vi.stubEnv('VISION_API_KEY', '');
    vi.stubEnv('VISION_BASE_URL', '');
    vi.stubEnv('VISION_MODEL', '');
    const cfg = configLoader.loadFromEnv();
    expect(cfg.vision).toBeUndefined();
  });
});
