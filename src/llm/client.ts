// LLM 客户端封装：基于 OpenAI SDK，兼容任意 OpenAI 协议服务商
import OpenAI from 'openai';
import { config } from '../config.js';
import { debug } from '../debug.js';
import { llmLogger, beginLLMCall } from '../llm-logger.js';
import type { ChatMessage, LLMResponse, OpenAIToolDef, StreamChunk, ToolCall, VisionMessage } from '../types.js';

export interface ChatOptions {
  /** 采样温度，默认 0 */
  temperature?: number;
  /** 模型名，默认 config.modelName */
  model?: string;
  /** 最大 token 数 */
  maxTokens?: number;
}

/** 视觉调用选项（Task-20261010-001）：三元组由调用方从 cfg.vision 解析回退后传入 */
export interface VisionChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 尝试 JSON 模式（response_format），服务商不支持时自动降级重试一次 */
  jsonMode?: boolean;
}

/** 视觉调用结果 */
export interface VisionChatResult {
  content: string;
  usage?: LLMResponse['usage'];
  elapsedMs: number;
}

/**
 * LLM 客户端
 *
 * 设计要点：
 * - 从 config 动态读取 apiKey / baseURL，支持运行时配置变更
 * - chat() 统一返回 LLMResponse，屏蔽 SDK 内部结构差异
 * - chatStream() 流式输出，完整支持 content 与 tool_calls 分片拼接
 * - 对网络错误与 429 速率限制自动重试（指数退避）
 * - 对 401/404 等 4xx 错误抛出明确中文提示，不重试
 */
export class LLMClient {
  private client: OpenAI | null = null;
  private _lastApiKey = '';
  private _lastBaseUrl = '';

  // 视觉客户端独立缓存（与主 client 并列，各自的 apiKey/baseUrl 变化时重建）
  private visionClient: OpenAI | null = null;
  private _lastVisionKey = '';
  private _lastVisionUrl = '';

  constructor() {}

  /**
   * 获取当前配置对应的 OpenAI 客户端
   * 如果配置（apiKey/baseUrl）发生变化，自动重新创建客户端
   */
  private getClient(): OpenAI {
    const apiKey = config.openaiApiKey;
    const baseURL = config.openaiBaseUrl;

    if (!this.client || apiKey !== this._lastApiKey || baseURL !== this._lastBaseUrl) {
      // 显式注入 Node 原生 fetch：SDK 默认使用内置 node-fetch@2，在 Node 24 下读取
      // 服务端「chunked + gzip」的长连接响应会抛 ERR_STREAM_PREMATURE_CLOSE（Premature close）
      this.client = new OpenAI({ apiKey, baseURL, fetch: globalThis.fetch });
      this._lastApiKey = apiKey;
      this._lastBaseUrl = baseURL;
    }

    return this.client;
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

    // 独立 LLM 调用日志（输入参数 + 消息列表，用于排查缓存命中率等）
    const callId = beginLLMCall();
    llmLogger.request({
      id: callId,
      model,
      temperature,
      toolsCount: tools?.length ?? 0,
      maxTokens: options.maxTokens,
      messages,
    });

    debug.llmRequest(model, messages.length, tools?.length ?? 0);

    const startMs = Date.now();
    return this.retry(async () => {
      const client = this.getClient();
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

      const resp = await client.chat.completions.create(params);
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

      const response: LLMResponse = {
        content: msg.content ?? null,
        tool_calls: toolCalls,
        finish_reason: choice.finish_reason ?? 'stop',
        usage: resp.usage ? {
          prompt_tokens: resp.usage.prompt_tokens ?? 0,
          prompt_cache_hit_tokens: (resp.usage as unknown as Record<string, unknown>).prompt_cache_hit_tokens as number | undefined,
          prompt_cache_miss_tokens: (resp.usage as unknown as Record<string, unknown>).prompt_cache_miss_tokens as number | undefined,
          completion_tokens: resp.usage.completion_tokens ?? 0,
          total_tokens: resp.usage.total_tokens ?? 0,
        } : undefined,
      };

      debug.llmResponse(
        response.content,
        response.tool_calls?.map((tc) => ({ name: tc.function.name, arguments: tc.function.arguments })),
        Date.now() - startMs,
        response.usage,
      );
      llmLogger.response({ id: callId, response, elapsedMs: Date.now() - startMs });

      return response;
    });
  }

  /**
   * 获取视觉调用对应的 OpenAI 客户端（独立于主 client，配置变化时重建）
   */
  private getVisionClient(apiKey: string, baseURL: string): OpenAI {
    if (!this.visionClient || apiKey !== this._lastVisionKey || baseURL !== this._lastVisionUrl) {
      // 同 getClient()：注入原生 fetch，规避 node-fetch 的 Premature close
      this.visionClient = new OpenAI({ apiKey, baseURL, fetch: globalThis.fetch });
      this._lastVisionKey = apiKey;
      this._lastVisionUrl = baseURL;
    }
    return this.visionClient;
  }

  /**
   * 视觉模型调用（Task-20261010-001，非流式）
   *
   * 设计要点：
   * - messages 可含多模态 content 数组（VisionMessage），仅在请求参数中出现，不进入 ChatMessage 历史
   * - jsonMode=true 时首次带 response_format: json_object；服务商不支持（400 类错误）时自动降级重试一次
   * - 复用 retry()（网络/429/5xx 重试）与 llmLogger/debug 可观测性
   * - 错误消息重写为视觉语境（避免误导用户去改主模型配置）
   */
  async chatVision(messages: VisionMessage[], options: VisionChatOptions): Promise<VisionChatResult> {
    const model = options.model;
    const temperature = options.temperature ?? 0;
    const startMs = Date.now();

    const callId = beginLLMCall();
    llmLogger.request({
      id: callId,
      model,
      temperature,
      toolsCount: 0,
      maxTokens: options.maxTokens,
      messages: messages as unknown as ChatMessage[],
    });
    debug.llmRequest(model, messages.length, 0);

    const buildParams = (jsonMode: boolean): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming => {
      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model,
        messages: messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
        temperature,
      };
      if (options.maxTokens !== undefined) {
        params.max_tokens = options.maxTokens;
      }
      if (jsonMode) {
        params.response_format = { type: 'json_object' };
      }
      return params;
    };

    const invoke = async (jsonMode: boolean): Promise<LLMResponse> => {
      const client = this.getVisionClient(options.apiKey, options.baseUrl);
      const resp = await client.chat.completions.create(buildParams(jsonMode));
      const choice = resp.choices[0];
      if (!choice) {
        throw new Error('视觉模型返回为空：choices 为空数组');
      }
      return {
        content: choice.message.content ?? null,
        finish_reason: choice.finish_reason ?? 'stop',
        usage: resp.usage ? {
          prompt_tokens: resp.usage.prompt_tokens ?? 0,
          completion_tokens: resp.usage.completion_tokens ?? 0,
          total_tokens: resp.usage.total_tokens ?? 0,
        } : undefined,
      };
    };

    let response: LLMResponse;
    try {
      response = await this.retry(() => invoke(options.jsonMode === true));
    } catch (firstErr) {
      if (options.jsonMode !== true) throw this.rewriteVisionError(firstErr, model);
      debug.log(`JSON 模式调用失败，降级为普通模式重试: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}`);
      try {
        response = await this.retry(() => invoke(false));
      } catch (secondErr) {
        throw this.rewriteVisionError(secondErr, model);
      }
    }

    debug.llmResponse(
      response.content,
      [],
      Date.now() - startMs,
      response.usage,
    );
    llmLogger.response({ id: callId, response, elapsedMs: Date.now() - startMs });

    return { content: response.content ?? '', usage: response.usage, elapsedMs: Date.now() - startMs };
  }

  /** 将 retry/wrapError 产生的通用错误消息重写为视觉语境，避免误导用户修改主模型配置 */
  private rewriteVisionError(e: unknown, visionModel: string): Error {
    const msg = e instanceof Error ? e.message : String(e);
    const rewritten = msg
      .replace('请检查 .env 中的 OPENAI_API_KEY', '请检查视觉配置 vision.apiKey（未设置时回退主模型 OPENAI_API_KEY）')
      .replace(/请检查 \.env 中的 MODEL_NAME（当前: [^）]*）/, `请检查视觉配置 vision.model（当前: ${visionModel}）`);
    return rewritten === msg && !msg.startsWith('视觉模型') ? new Error(`视觉模型调用失败: ${msg}`) : new Error(rewritten);
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

    // 独立 LLM 调用日志（输入参数 + 消息列表）
    const callId = beginLLMCall();
    llmLogger.request({
      id: callId,
      model,
      temperature,
      toolsCount: tools?.length ?? 0,
      maxTokens: options.maxTokens,
      messages,
    });

    debug.llmRequest(model, messages.length, tools?.length ?? 0);

    const streamStartMs = Date.now();

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length > 0) {
      params.tools = tools as OpenAI.Chat.ChatCompletionTool[];
      params.tool_choice = 'auto';
    }
    if (options.maxTokens !== undefined) {
      params.max_tokens = options.maxTokens;
    }

    const client = this.getClient();
    const stream = await client.chat.completions.create(params);

    // 累积器：按 index 聚合 tool_calls，最后组装成完整 LLMResponse
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
    let contentBuf = '';
    let finishReason: LLMResponse['finish_reason'] = 'stop';
    let streamError: Error | null = null;
    let streamUsage: LLMResponse['usage'] | undefined;

    try {
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

        // 4. usage：流式模式下通常在最后一个 chunk 返回
        if (chunk.usage) {
          streamUsage = {
            prompt_tokens: chunk.usage.prompt_tokens ?? 0,
            prompt_cache_hit_tokens: (chunk.usage as unknown as Record<string, unknown>).prompt_cache_hit_tokens as number | undefined,
            prompt_cache_miss_tokens: (chunk.usage as unknown as Record<string, unknown>).prompt_cache_miss_tokens as number | undefined,
            completion_tokens: chunk.usage.completion_tokens ?? 0,
            total_tokens: chunk.usage.total_tokens ?? 0,
          };
        }
      }
    } catch (e) {
      // 流连接过早关闭（Premature close 等），保存错误但不丢失已累积的内容
      streamError = e instanceof Error ? e : new Error(String(e));
      debug.log(`流式流连接异常关闭: ${streamError.message}，将返回已累积的内容`);
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
      usage: streamUsage,
    };

    if (streamError) {
      // 流异常关闭但有部分内容时，记录警告并返回已累积的内容
      if (contentBuf || toolCallMap.size > 0) {
        debug.log(`流连接异常关闭，但已累积 ${contentBuf.length} 字符和 ${toolCallMap.size} 个工具调用，继续处理`);
      } else {
        // 没有任何内容，抛出原始错误
        throw streamError;
      }
    }

    debug.llmResponse(
      response.content,
      response.tool_calls?.map((tc) => ({ name: tc.function.name, arguments: tc.function.arguments })),
      Date.now() - streamStartMs,
      response.usage,
    );
    llmLogger.response({ id: callId, response, elapsedMs: Date.now() - streamStartMs });

    yield { type: 'done', response };
  }

  /**
   * 重试机制：仅对网络错误与 429 速率限制重试，指数退避
   * 401/403/404 等 4xx 错误不重试，直接抛出
   */
  private async retry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const startMs = Date.now();
      try {
        const result = await fn();
        if (attempt > 0) {
          debug.log(`重试成功 (第 ${attempt + 1} 次), 耗时 ${Date.now() - startMs}ms`);
        }
        return result;
      } catch (e) {
        lastErr = e;
        const shouldRetry = this.isRetryable(e);
        if (!shouldRetry || attempt === retries) {
          debug.llmError(e, Date.now() - startMs);
          throw this.wrapError(e);
        }
        debug.log(`LLM 调用失败 (第 ${attempt + 1} 次), 重试中: ${e instanceof Error ? e.message : String(e)}`);
        // 指数退避：1s, 2s
        await this.sleep(1000 * (attempt + 1));
      }
    }
    debug.llmError(lastErr, 0);
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
