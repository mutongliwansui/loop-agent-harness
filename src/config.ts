// 全局配置：从 .env 读取
import 'dotenv/config';

/**
 * 读取必填环境变量，缺失时抛出明确错误
 */
function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(`环境变量 ${key} 未设置，请检查 .env 文件`);
  }
  return v;
}

/**
 * 读取数字型环境变量，支持默认值
 */
function number(key: string, defaultValue: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultValue;
  const n = Number(v);
  if (Number.isNaN(n)) {
    throw new Error(`环境变量 ${key} 不是合法数字: ${v}`);
  }
  return n;
}

export const config = {
  /** OpenAI API Key */
  openaiApiKey: required('OPENAI_API_KEY'),
  /** OpenAI 协议 Base URL，默认官方地址 */
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  /** 默认模型名 */
  modelName: process.env.MODEL_NAME ?? 'gpt-4o-mini',
  /** Agent 最大迭代次数，默认 10 */
  maxIterations: number('MAX_ITERATIONS', 10),
} as const;

export type Config = typeof config;
