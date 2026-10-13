// 连通性校验：用候选三元组直接发起一次极小请求，验证模型可连通
// 供配置向导（bootstrap/wizard.ts）与 /model 命令共享
// （Task-20261011-002 从 wizard.ts 抽出，行为不变）
import OpenAI from 'openai';

/** 候选三元组（服务地址 / apiKey / 模型名） */
export interface ModelCandidate {
  baseUrl: string;
  apiKey: string;
  name: string;
}

export interface ConnectivityResult {
  ok: boolean;
  error?: string;
  elapsedMs?: number;
}

export type CheckConnectivityFn = (candidate: ModelCandidate) => Promise<ConnectivityResult>;

/** 连通性校验超时（ms），SDK 层生效 */
const CHECK_TIMEOUT_MS = 15_000;

/** 默认连通性校验：直接用候选三元组发一次极小请求（15s 超时；瞬时网络抖动自动重试一次，4xx/超时不重试） */
export const defaultCheckConnectivity: CheckConnectivityFn = async (candidate) => {
  const started = Date.now();
  const attempt = async (): Promise<void> => {
    const client = new OpenAI({
      apiKey: candidate.apiKey,
      baseURL: candidate.baseUrl,
      timeout: CHECK_TIMEOUT_MS,
      maxRetries: 0,
    });
    const stream = await client.chat.completions.create({
      model: candidate.name,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
      stream: true,
    });
    // 流式探测：真实对话走流式路径，部分网关（如 DeepSeek）的非流式响应会触发
    // undici「Premature close」（对话正常但非流式校验必败）；校验与对话保持同一
    // 传输路径，收到首个响应块（或流正常结束）即判定连通，随即中止请求
    await stream[Symbol.asyncIterator]().next();
    stream.controller.abort();
  };
  try {
    await attempt();
    return { ok: true, elapsedMs: Date.now() - started };
  } catch (err) {
    // 瞬时传输层错误（连接被服务端/中间设备提前断开等，无 HTTP 状态码）自动重试一次；
    // 401/404 等带状态码的确定性失败与超时（重试会成倍拖慢交互）不重试
    if (!isTransientTransportError(err)) {
      return { ok: false, error: describeCheckError(err) };
    }
    try {
      await attempt();
      return { ok: true, elapsedMs: Date.now() - started };
    } catch (retryErr) {
      return { ok: false, error: describeCheckError(retryErr) };
    }
  }
};

/** 瞬时传输层错误判定：无 HTTP 状态码且报文特征为连接中断/网络抖动（超时除外） */
function isTransientTransportError(err: unknown): boolean {
  if ((err as { status?: number } | null)?.status) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|aborted/i.test(msg)) return false;
  return /premature|closed|reset|terminated|fetch failed|network|socket|econn/i.test(msg);
}

/** 校验错误分类（401/404/网络/超时给出明确提示） */
function describeCheckError(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return 'apiKey 无效或无权限';
  if (status === 404) return '模型名或服务地址可能有误';
  if (status === 429) return '请求过于频繁（429），请稍后重试';
  if (status && status >= 400) return `服务返回错误（${status}）`;
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|aborted/i.test(msg)) return `校验超时（${CHECK_TIMEOUT_MS / 1000}s），请检查网络或代理设置`;
  if (/premature|terminated/i.test(msg)) return '连接被提前断开（网络抖动或服务端临时异常），请重试';
  return `无法连接到服务地址：${msg}`;
}
