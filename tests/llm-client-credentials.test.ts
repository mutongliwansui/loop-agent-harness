/**
 * LLM 客户端按凭据缓存（task-20261025-002 D5）
 *
 * 覆盖验收项：
 * - 未传凭据 → 走全局单槽，行为与改动前一致
 * - 同 (apiKey, baseUrl) 二次调用命中缓存，不重建客户端
 * - 换 key 或换 baseUrl 均产生新客户端
 * - 只传一个（key 或 baseUrl）视为无效，回落全局
 * - 缓存上限 8，超限淘汰最旧
 *
 * 手法：mock `openai` 只为「记录实例构造」并让构造永不联网/不校验 key；
 * 直接调用私有 getClientFor 观测引用同一性，避免走真实 HTTP。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('openai', () => {
  class FakeOpenAI {
    static instances: FakeOpenAI[] = [];
    options: { apiKey?: string; baseURL?: string; fetch?: unknown };
    constructor(options: { apiKey?: string; baseURL?: string; fetch?: unknown }) {
      this.options = options;
      FakeOpenAI.instances.push(this);
    }
  }
  return { default: FakeOpenAI };
});

async function makeClient(): Promise<{
  getClientFor: (apiKey?: string, baseURL?: string) => unknown;
  getClient: () => unknown;
  instances: { options: { apiKey?: string; baseURL?: string } }[];
}> {
  const OpenAI = (await import('openai')).default as unknown as {
    instances: { options: { apiKey?: string; baseURL?: string } }[];
  };
  OpenAI.instances.length = 0;
  const { LLMClient } = await import('../src/llm/client.js');
  const c = new LLMClient() as unknown as {
    getClientFor: (apiKey?: string, baseURL?: string) => unknown;
    getClient: () => unknown;
  };
  return { getClientFor: c.getClientFor.bind(c), getClient: c.getClient.bind(c), instances: OpenAI.instances };
}

describe('getClientFor：按 (apiKey, baseUrl) 键控缓存', () => {
  it('同一凭据二次调用复用同一客户端实例，不重复构造', async () => {
    const { getClientFor, instances } = await makeClient();
    const first = getClientFor('key-a', 'https://a.example/v1');
    const second = getClientFor('key-a', 'https://a.example/v1');
    expect(second).toBe(first);
    expect(instances).toHaveLength(1);
    expect(instances[0].options.apiKey).toBe('key-a');
    expect(instances[0].options.baseURL).toBe('https://a.example/v1');
  });

  it('换 apiKey 产生新客户端（不同供应商 key 不串用）', async () => {
    const { getClientFor, instances } = await makeClient();
    const a = getClientFor('key-a', 'https://a.example/v1');
    const b = getClientFor('key-b', 'https://a.example/v1');
    expect(b).not.toBe(a);
    expect(instances).toHaveLength(2);
  });

  it('同 key 换 baseUrl 也产生新客户端（这是 D5 修好的核心）', async () => {
    const { getClientFor, instances } = await makeClient();
    const a = getClientFor('key-a', 'https://a.example/v1');
    const b = getClientFor('key-a', 'https://b.example/v1');
    expect(b).not.toBe(a);
    expect(instances).toHaveLength(2);
    expect(instances[1].options.baseURL).toBe('https://b.example/v1');
  });

  it('只传 apiKey 或只传 baseUrl 视为无效，回落全局单槽', async () => {
    const { getClientFor, getClient, instances } = await makeClient();
    const globalClient = getClient();
    expect(getClientFor('only-key', undefined)).toBe(globalClient);
    expect(getClientFor(undefined, 'https://only-url.example/v1')).toBe(globalClient);
    // 回落路径不应额外构造缓存客户端（全局那一个除外）
    expect(instances).toHaveLength(1);
  });

  it('完全不传凭据时多次调用复用全局单槽', async () => {
    const { getClientFor } = await makeClient();
    expect(getClientFor()).toBe(getClientFor());
  });

  it('超过上限 8 时淘汰最旧，缓存规模不无界增长', async () => {
    const { getClientFor } = await makeClient();
    const made: unknown[] = [];
    for (let i = 0; i < 10; i++) made.push(getClientFor(`key-${i}`, `https://h${i}.example/v1`));
    // 最近一个仍在缓存（命中同一实例）
    expect(getClientFor('key-9', 'https://h9.example/v1')).toBe(made[9]);
    // 最早的已被淘汰 → 重建出新实例
    expect(getClientFor('key-0', 'https://h0.example/v1')).not.toBe(made[0]);
  });
});
