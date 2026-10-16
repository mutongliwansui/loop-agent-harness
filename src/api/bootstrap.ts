// src/index.ts --serve 分支的组装入口（真实依赖）：
// 建独立 SessionStore（与 CLI 共用同一存储池，但不注入共享 agent）、起服务、打印服务信息。

import { createRequire } from 'node:module';
import { createApiServer, type ApiServer } from './server.js';

export async function startApiServer(): Promise<ApiServer> {
  const { agent } = await import('../agent/react-agent.js');
  const { configLoader } = await import('../config/index.js');
  const { SessionStore: Store } = await import('../session/index.js');

  const { config: cfg } = configLoader.load();
  const store = new Store(process.cwd(), 3, cfg.session.encryptionEnabled);
  await store.init();

  // 读取 package.json 版本（/health 返回）
  let version = '';
  try {
    const require = createRequire(import.meta.url);
    version = (require('../../package.json') as { version?: string }).version ?? '';
  } catch {
    // 版本读取失败不影响服务
  }

  const server = createApiServer({
    runAgent: (input, options) => agent.run(input, options),
    sessionStore: store,
    getConfig: () => configLoader.load().config,
    version,
    log: (msg) => console.log(msg),
  });

  const { port } = await server.start();
  const api = cfg.api;
  console.log('');
  console.log(`\x1b[1m\x1b[36mHTTP API 服务已启动\x1b[0m`);
  console.log(`  地址:    http://${api.host}:${port}`);
  console.log(`  鉴权:    ${api.token ? 'Bearer Token' : '仅本机（未配置 api.token）'}`);
  console.log(`  端点:    GET /health · POST /sessions · GET|DELETE /sessions/:id · POST /sessions/:id/messages`);
  console.log(`  提示:    Ctrl+C 退出；配置变更需重启生效`);
  console.log('');
  return server;
}
