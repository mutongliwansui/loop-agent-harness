// 环境变量配置（向后兼容 deprecated）
// 新代码请使用 src/config/index.ts 的 ConfigLoader
import { configLoader } from './config/index.js';

/**
 * 动态配置对象：每次访问属性时都会从 ConfigLoader 重新加载最新配置
 * 支持运行时修改全局/工作空间配置后立即生效
 * @deprecated 请改为 configLoader.load()
 */
export const config = {
  get openaiApiKey(): string {
    return configLoader.load().config.model.apiKey;
  },
  get openaiBaseUrl(): string {
    return configLoader.load().config.model.baseUrl;
  },
  get modelName(): string {
    return configLoader.load().config.model.name;
  },
  get maxIterations(): number {
    return configLoader.load().config.model.maxIterations;
  },
  get temperature(): number {
    return configLoader.load().config.model.temperature;
  },
  get verbose(): boolean {
    return configLoader.load().config.agent.verbose;
  },
  get debug(): boolean {
    return configLoader.load().config.agent.debug;
  },
  get llmLogEnabled(): boolean {
    return configLoader.load().config.agent.llmLogEnabled;
  },
  get skill() {
    return configLoader.load().config.skill;
  },
};

export default config;
