/**
 * E2E 验证启动器（需求 20261027-003「模型性能指标测试」）
 *
 * 起两件事：
 * 1. 本地假 LLM（OpenAI 兼容 POST /v1/chat/completions，真 SSE 流）——按 model 名切换节奏：
 *    mock-fast（默认，首 token 40ms、16 块 × 18ms）/ mock-slow（首 token 350ms、14 块 × 45ms）
 *    mock-buffer（憋 350ms 后一次性吐完 → 触发「疑似被网关缓冲」）/ mock-fail（401）
 * 2. 真 API 服务（createApiServer + webui/dist 静态托管 + 临时 benchRoot），
 *    4 个模型档案全部指向假 LLM —— 这样测速链路（引擎 → SSE → 落盘 → WebUI）是真跑，只是不出网。
 *
 * 由 webui/verify-bench-ui.mjs 以 `npx tsx` 拉起，就绪后在 stdout 打印一行：
 *   E2E_READY {"apiPort":...,"mockPort":...,"benchRoot":"..."}
 *
 * 手动调试也可直接用：npx tsx webui/verify-bench-ui.server.ts
 */
import http from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createApiServer } from '../src/api/server.js';
import { SessionStore } from '../src/session/store.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';

const ROOT = process.cwd();
const E2E_DIR = join(ROOT, 'temp', 'verify-bench-ui');
const BENCH_ROOT = join(E2E_DIR, 'home');
const WORKSPACE = join(E2E_DIR, 'workspace');
const SESSION_DIR = join(E2E_DIR, 'sessions');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 假 LLM：真 SSE 流，节奏由请求体里的 model 名决定 */
function createMockLlm(): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: { model?: string; max_tokens?: number } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as typeof body;
      } catch {
        /* 保持空体 */
      }
      const model = body.model ?? 'mock-fast';

      if (model.includes('fail')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }));
        return;
      }

      const slow = model.includes('slow');
      const burst = model.includes('buffer');
      const ttft = slow ? 350 : 40;
      const gap = slow ? 45 : 18;
      const pieces = slow ? 14 : 16;

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let closed = false;
      res.on('close', () => {
        closed = true;
      });
      const write = (data: unknown): void => {
        if (!closed) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      void (async () => {
        // 首个空 role 块（对齐真服务商，验证「空 delta 不算首 token」）
        write({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
        await sleep(ttft);
        if (closed) return;
        if (burst) {
          // 一次性吐完所有块（间隔≈0）→ 引擎应判定「疑似被网关缓冲」
          for (let i = 0; i < 8; i++) {
            write({ choices: [{ index: 0, delta: { content: `缓冲块${i}` } }] });
          }
        } else {
          for (let i = 0; i < pieces; i++) {
            if (closed) return;
            write({ choices: [{ index: 0, delta: { content: `片段${i} ` } }] });
            await sleep(gap);
          }
        }
        if (closed) return;
        write({
          choices: [],
          usage: { prompt_tokens: 64, completion_tokens: 72, total_tokens: 136, prompt_cache_hit_tokens: 0 },
        });
        res.write('data: [DONE]\n\n');
        res.end();
      })();
    });
  });
}

function makeConfig(): AgentConfig {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api = { ...cfg.api, port: 0, authToken: '', webRoot: '' };
  const mk = (name: string) => ({ name, baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'sk-mock' });
  cfg.models = {
    active: 'fast',
    profiles: {
      fast: mk('mock-fast'),
      slow: mk('mock-slow'),
      buffer: mk('mock-buffer'),
      fail: mk('mock-fail'),
    },
  };
  // 关掉一堆与本次验证无关的自动行为，避免噪音
  cfg.memory = { ...cfg.memory, enabled: false };
  return cfg;
}

let mockPort = 0;

async function main(): Promise<void> {
  // 每次验证都从干净的 bench 历史 / 会话目录开始（否则「首次进入=空态」等断言会被上一轮残留污染）
  for (const dir of [BENCH_ROOT, SESSION_DIR, WORKSPACE]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(E2E_DIR, { recursive: true });
  mkdirSync(WORKSPACE, { recursive: true });

  const mock = createMockLlm();
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', () => resolve()));
  mockPort = (mock.address() as { port: number }).port;

  const store = new SessionStore(WORKSPACE, false, SESSION_DIR);
  await store.init();
  const config = makeConfig();

  const server = createApiServer({
    runAgent: async () => {
      throw new Error('E2E：本验证只走测速端点，不跑会话');
    },
    sessionStore: store,
    getConfig: () => config,
    version: 'e2e',
    runtime: {
      configLoader: { load: () => ({ config }) } as never,
      benchRoot: BENCH_ROOT,
    },
  });
  const { port } = await server.start();

  console.log(`E2E_READY ${JSON.stringify({ apiPort: port, mockPort, benchRoot: BENCH_ROOT, base: `http://127.0.0.1:${port}` })}`);

  const shutdown = async (): Promise<void> => {
    await server.close().catch(() => {});
    await new Promise<void>((r) => mock.close(() => r()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
