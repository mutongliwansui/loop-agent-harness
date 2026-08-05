// LLM 客户端封装：基于 OpenAI SDK，兼容任意 OpenAI 协议服务商
import OpenAI from 'openai';
import { config } from '../config.js';
import type { ChatMessage, LLMResponse, OpenAIToolDef, StreamChunk, ToolCall } from '../types.js';

export interface ChatOptions {
  /** 采样温度，默认 0 */
  temperature?: number;
  /** 模型名，默认 config.modelName */
  model?: string;
  /** 最大 token 数 */
  maxTokens?: number;
}

/**
 * LLM 客户端
 *
 * 设计要点：
 * - 从 config 读取 apiKey / baseURL，构造时即创建 SDK 实例
 * - chat() 统一返回 LLMResponse，屏蔽 SDK 内部结构差异
 * - chatStream() 流式输出，完整支持 content 与 tool_calls 分片拼接
 * - 对网络错误与 429 速率限制自动重试（指数退避）
 * - 对 401/404 等 4xx 错误抛出明确中文提示，不重试
 */
export class LLMClient {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
    });
  }

  /**
   * 非流式对话调用
   * @param messages 消息历史
   * @param tools 可选，OpenAI function calling 工具定义
   * @param options 可选，温度/模型/maxTokens
   */
  async chat(
    messages: ChatMessage[],
    tools?: OpenAIToolDef[],
    options: ChatOptions = {},
  ): Promise<LLMResponse> {
    const model = options.model ?? config.modelName;
    const temperature = options.temperature ?? 0;

    return this.retry(async () => {
      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        temperature,
      };
      if (tools && tools.length > 0) {
        params.tools = tools as OpenAI.Chat.ChatCompletionTool[];
        params.tool_choice = 'auto';
      }
      if (options.maxTokens !== undefined) {
        params.max_tokens = options.maxTokens;
      }

      const resp = await this.client.chat.completions.create(params);
      const choice = resp.choices[0];
      if (!choice) {
        throw new Error('LLM 返回为空：choices 为空数组');
      }

      const msg = choice.message;
      const toolCalls = msg.tool_calls?.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));

      return {
        content: msg.content ?? null,
        tool_calls: toolCalls,
        finish_reason: choice.finish_reason ?? 'stop',
      } satisfies LLMResponse;
    });
  }

  /**
   * 流式对话调用，完整支持 content 与 tool_calls 分片拼接
   *
   * 产出 StreamChunk 序列：
   * - delta：文本片段（Thought/最终答案的逐 token 产出）
   * - toolCallStart：某个 tool_call 首次出现（带 id 与 name）
   * - toolCallDelta：tool_call 的 arguments 增量片段
   * - done：流结束，携带累积完成的 LLMResponse
   *
   * 注意：SDK 在流式模式下会把 tool_call.arguments 拆成多个 chunk，
   * 需按 tool_call.index 累积，最后一个 done chunk 给出可 JSON.parse 的完整字符串。
   */
  async *chatStream(
    messages: ChatMessage[],
    tools?: OpenAIToolDef[],
    options: ChatOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const model = options.model ?? config.modelName;
    const temperature = options.temperature ?? 0;

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature,
      stream: true,
    };
    if (tools && tools.length > 0) {
      params.tools = tools as OpenAI.Chat.ChatCompletionTool[];
      params.tool_choice = 'auto';
    }
    if (options.maxTokens !== undefined) {
      params.max_tokens = options.maxTokens;
    }

    const stream = await this.client.chat.completions.create(params);

    // 累积器：按 index 聚合 tool_calls，最后组装成完整 LLMResponse
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
    let contentBuf = '';
    let finishReason: LLMResponse['finish_reason'] = 'stop';

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      // 1. 文本片段
      if (delta.content) {
        contentBuf += delta.content;
        yield { type: 'delta', content: delta.content };
      }

      // 2. tool_calls 分片：按 index 累积
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          const existing = toolCallMap.get(idx);
          if (!existing) {
            // 新 tool_call 首次出现
            const id = tc.id ?? `call_${idx}`;
            const name = tc.function?.name ?? '';
            toolCallMap.set(idx, { id, name, arguments: tc.function?.arguments ?? '' });
            yield { type: 'toolCallStart', index: idx, toolCallId: id, name };
          } else {
            // 已存在 index，累加 arguments 片段
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
              yield { type: 'toolCallDelta', index: idx, argumentsDelta: tc.function.arguments };
            }
            // id/name 可能在后续 chunk 补全（部分服务商会分片返回）
            if (tc.id && !existing.id) existing.id = tc.id;
            if (tc.function?.name && !existing.name) existing.name = tc.function.name;
          }
        }
      }

      // 3. finish_reason
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    // 组装最终 LLMResponse
    const toolCalls: ToolCall[] | undefined =
      toolCallMap.size > 0
        ? [...toolCallMap.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, v]) => ({
              id: v.id,
              type: 'function' as const,
              function: { name: v.name, arguments: v.arguments },
            }))
        : undefined;

    const response: LLMResponse = {
      content: contentBuf || null,
      tool_calls: toolCalls,
      finish_reason: toolCalls ? 'tool_calls' : finishReason,
    };

    yield { type: 'done', response };
  }

  /**
   * 重试机制：仅对网络错误与 429 速率限制重试，指数退避
   * 401/403/404 等 4xx 错误不重试，直接抛出
   */
  private async retry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const shouldRetry = this.isRetryable(e);
        if (!shouldRetry || attempt === retries) {
          throw this.wrapError(e);
        }
        // 指数退避：1s, 2s
        await this.sleep(1000 * (attempt + 1));
      }
    }
    throw this.wrapError(lastErr);
  }

  /** 判断错误是否可重试（网络错误或 429） */
  private isRetryable(e: unknown): boolean {
    if (e instanceof OpenAI.APIError) {
      // 429 速率限制可重试
      if (e.status === 429) return true;
      // 5xx 服务端错误可重试
      if (e.status && e.status >= 500) return true;
      return false;
    }
    // 非 APIError（如网络断开、连接超时）可重试
    return true;
  }

  /** 将 SDK 错误包装为明确的中文提示 */
  private wrapError(e: unknown): Error {
    if (e instanceof OpenAI.APIError) {
      switch (e.status) {
        case 401:
          return new Error('API Key 无效或已过期，请检查 .env 中的 OPENAI_API_KEY');
        case 403:
          return new Error('访问被拒绝（403），请检查 API Key 权限');
        case 404:
          return new Error(`模型不存在（404），请检查 .env 中的 MODEL_NAME（当前: ${config.modelName}）`);
        case 429:
          return new Error('请求过于频繁（429），请稍后重试或降低调用频率');
        default:
          return new Error(`LLM 调用失败（${e.status}）: ${e.message}`);
      }
    }
    if (e instanceof Error) return e;
    return new Error(`LLM 调用失败: ${String(e)}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

/** 全局单例 */
export const llm = new LLMClient();
