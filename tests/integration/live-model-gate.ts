/**
 * 真实模型集成用例门禁（a/b/c/d/f/g 六个用例专用）
 *
 * 背景：`tests/integration/` 下这六个用例直接 `agent.run(...)` 走真实 LLM。而
 * `tests/setup/test-home.ts` 把 `LOOP_AGENT_HOME` 指向一次性临时目录，`config.json`
 * 不存在 → apiKey 为空、baseUrl 回落 `https://api.openai.com/v1`，于是全量回归里这六例
 * 必然失败：外网不通报 `UND_ERR_CONNECT_TIMEOUT`，外网通则报 `401`。每次回归都挂六例，
 * 会淹没真正的回归信号。
 *
 * 门禁策略（默认跳过，显式开启）：
 * 1. 必须设置 `LOOP_AGENT_LIVE_MODEL`（1/true/yes/on）——默认不跑，避免在有网机器上
 *    静默产生真实调用与费用；
 * 2. 且必须能解析到可用凭据：优先 `process.env.OPENAI_API_KEY`，缺失时回落到**真实**
 *    用户目录 `~/.loop-agent/config.json` 的 `model.apiKey`（注意不能用 `loopAgentHome()`，
 *    它已被 setup 改写为临时目录）；
 * 3. 任一条件不满足即跳过，并把原因拼进用例名，避免「静默没跑」被误读为「已通过」。
 *
 * 用法：`describeLiveModel('用例 A：无工具直接回答', () => { ... })`。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'vitest';

const TRUTHY = ['1', 'true', 'TRUE', 'yes', 'on'];

/** 门禁开关是否打开（只看环境变量，不做 IO） */
function flagOn(): boolean {
  const v = process.env.LOOP_AGENT_LIVE_MODEL?.trim();
  return v !== undefined && TRUTHY.includes(v);
}

/** 读真实用户目录下的全局配置（绕过被测试 setup 改写的 LOOP_AGENT_HOME） */
function realHomeModel(): { apiKey?: string; baseUrl?: string; name?: string } {
  try {
    const path = join(homedir(), '.loop-agent', 'config.json');
    const raw = JSON.parse(readFileSync(path, 'utf-8').replace(/^\uFEFF/, '')) as {
      model?: { apiKey?: string; baseUrl?: string; name?: string };
    };
    return raw.model ?? {};
  } catch {
    return {};
  }
}

/**
 * 解析并回填凭据到 process.env。
 *
 * 为什么必须回填：`src/config/loader.ts` 的 `loadFromEnv()` 只认
 * `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `MODEL_NAME` 三个变量，而本轮测试的
 * `config.json` 位于临时目录（不可见），所以从真实配置读到的值只能通过环境变量喂进去。
 * 已存在的环境变量不覆盖（保持「显式传参优先」）。
 */
function resolveCredentials(): boolean {
  if (process.env.OPENAI_API_KEY?.trim()) return true;

  const m = realHomeModel();
  if (!m.apiKey?.trim()) return false;

  process.env.OPENAI_API_KEY = m.apiKey.trim();
  if (m.baseUrl?.trim() && !process.env.OPENAI_BASE_URL?.trim()) {
    process.env.OPENAI_BASE_URL = m.baseUrl.trim();
  }
  if (m.name?.trim() && !process.env.MODEL_NAME?.trim()) {
    process.env.MODEL_NAME = m.name.trim();
  }
  return true;
}

const flag = flagOn();
// 只在开关打开时才读盘/回填，日常回归不产生任何环境副作用
const hasCredentials = flag ? resolveCredentials() : false;

/** 真实模型用例是否应执行 */
export const LIVE_MODEL_ENABLED = flag && hasCredentials;

/** 跳过原因（仅在 LIVE_MODEL_ENABLED 为 false 时有意义） */
export const LIVE_MODEL_SKIP_REASON = !flag
  ? '未设置 LOOP_AGENT_LIVE_MODEL=1'
  : '未找到真实模型凭据（OPENAI_API_KEY 或 ~/.loop-agent/config.json 的 model.apiKey）';

/**
 * 声明一组需要真实模型的用例：未开启门禁时整组跳过，并在标题后标注原因。
 * 用例名后缀让 `npm run test:full` 的输出直接可读，不必翻源码才知道为什么 skipped。
 *
 * @param timeout 组级超时毫秒，与原 `describe(name, fn, timeout)` 的第三个参数等价（透传不改变断言语义）
 */
export function describeLiveModel(name: string, fn: () => void, timeout?: number): void {
  const title = LIVE_MODEL_ENABLED
    ? name
    : `${name}【已跳过：${LIVE_MODEL_SKIP_REASON}】`;
  const register = describe.skipIf(!LIVE_MODEL_ENABLED);
  if (timeout === undefined) register(title, fn);
  else register(title, fn, timeout);
}
