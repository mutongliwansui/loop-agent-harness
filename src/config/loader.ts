// 配置加载器：分层合并（CLI > 工作空间 > 全局 > .env > 默认值）
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_CONFIG,
  type AgentConfig,
  type ConfigSource,
  type PartialAgentConfig,
  type ResolvedConfig,
} from './schema.js';
import { deepMerge } from './merge.js';
import { getCliOverrides } from './cli-overrides.js';

/**
 * 从 .env 文件加载配置到 process.env（如果文件存在）。
 * 无需用户手动带 --env-file 参数，兼容 dotenv 行为（但为了避免引入 dotenv，这里做最小解析）。
 */
function loadDotEnvToProcessEnv(): void {
  // 仅当 process.env 中未标记过已加载时加载，避免重复读取
  // 应用自身资源：.env 读取锚定启动目录（非工作空间资源，切换空间不改变）
  const paths = [join(process.cwd(), '.env')];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf-8');
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        let key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (process.env[key] !== undefined) continue; // 不覆盖已有环境变量（如命令行传入的）
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
    } catch {
      // 忽略 parse 错误
    }
  }
}

export class ConfigLoader {
  private workspacePath: string;
  private globalDir: string;

  // 共享默认值：CLI 单空间时不传参数，即以启动目录为空间根；serve 侧由 runtime 构造时显式传根（D7）
  constructor(workspacePath = process.cwd(), globalDir = join(homedir(), '.loop-agent')) {
    this.workspacePath = workspacePath;
    this.globalDir = globalDir;
    // 构造时读取 .env 文件到 process.env（幂等，不覆盖已有环境变量）
    loadDotEnvToProcessEnv();
  }

  get workspaceConfigPath(): string {
    // Task：workspace 配置统一存放于 {workspace}/.loop-agent/.agent-config.json
    return join(this.workspacePath, '.loop-agent', '.agent-config.json');
  }

  /**
   * 切换工作空间后更新工作空间根目录（load 的 workspace 层随之指向新空间；全局层不变）
   * @deprecated Task-20261021-010-03 起 serve 侧每个 runtime 构造期定根，不再原地改写；
   * 保留仅为兼容外部调用与既有单测，P2（task-04）删除。
   */
  setWorkspacePath(path: string): void {
    this.workspacePath = path;
  }

  get globalConfigPath(): string {
    return join(this.globalDir, 'config.json');
  }

  /**
   * 加载并合并所有层级的配置
   * 优先级：cli > workspace > global > env > default
   */
  load(cliOverrides: PartialAgentConfig = {}): ResolvedConfig {
    // 每次加载前确保 .env 文件已读取到 process.env（幂等，不覆盖已有环境变量）
    loadDotEnvToProcessEnv();

    const defaults = DEFAULT_CONFIG;
    const env = this.loadFromEnv();
    const global = this.loadGlobalSync();
    const workspace = this.loadWorkspaceSync();
    // 进程级启动参数（--port 等）优先级最高，且对所有 ConfigLoader 实例生效
    const cli = deepMerge<PartialAgentConfig>(getCliOverrides(), cliOverrides);

    // 深合并：后者覆盖前者
    const merged = deepMerge<AgentConfig>(
      defaults,
      env as Partial<AgentConfig>,
      global as Partial<AgentConfig>,
      workspace as Partial<AgentConfig>,
      cli as Partial<AgentConfig>,
    );

    const sources = this.resolveSources({
      defaults,
      env,
      global,
      workspace,
      cli,
    });

    return { config: merged, sources };
  }

  /** 异步加载版本 */
  async loadAsync(cliOverrides: PartialAgentConfig = {}): Promise<ResolvedConfig> {
    // 每次加载前确保 .env 文件已读取到 process.env
    loadDotEnvToProcessEnv();

    const defaults = DEFAULT_CONFIG;
    const env = this.loadFromEnv();
    const global = await this.loadGlobal();
    const workspace = await this.loadWorkspace();
    // 进程级启动参数（--port 等）优先级最高，且对所有 ConfigLoader 实例生效
    const cli = deepMerge<PartialAgentConfig>(getCliOverrides(), cliOverrides);

    const merged = deepMerge<AgentConfig>(
      defaults,
      env as Partial<AgentConfig>,
      global as Partial<AgentConfig>,
      workspace as Partial<AgentConfig>,
      cli as Partial<AgentConfig>,
    );

    const sources = this.resolveSources({
      defaults,
      env,
      global,
      workspace,
      cli,
    });

    return { config: merged, sources };
  }

  /** 读工作空间配置（异步） */
  async loadWorkspace(): Promise<PartialAgentConfig> {
    return readJsonSafe<PartialAgentConfig>(this.workspaceConfigPath);
  }

  /** 读全局配置（异步） */
  async loadGlobal(): Promise<PartialAgentConfig> {
    return readJsonSafe<PartialAgentConfig>(this.globalConfigPath);
  }

  loadWorkspaceSync(): PartialAgentConfig {
    return readJsonSafeSync<PartialAgentConfig>(this.workspaceConfigPath);
  }

  loadGlobalSync(): PartialAgentConfig {
    return readJsonSafeSync<PartialAgentConfig>(this.globalConfigPath);
  }

  /** 从 .env / process.env 读取配置（向后兼容） */
  loadFromEnv(): PartialAgentConfig {
    const env = process.env;
    const cfg: PartialAgentConfig = {};

    if (env.OPENAI_API_KEY || env.MODEL_NAME || env.OPENAI_BASE_URL) {
      cfg.model = {};
      if (env.OPENAI_API_KEY) cfg.model.apiKey = env.OPENAI_API_KEY;
      if (env.MODEL_NAME) cfg.model.name = env.MODEL_NAME;
      if (env.OPENAI_BASE_URL) cfg.model.baseUrl = env.OPENAI_BASE_URL;
    }

    if (env.MAX_ITERATIONS) {
      const n = Number(env.MAX_ITERATIONS);
      if (!Number.isNaN(n)) (cfg.agent ??= {}).maxIterations = n;
    }

    if (env.VERBOSE !== undefined) {
      cfg.agent = { ...cfg.agent, verbose: ['1', 'true', 'TRUE', 'yes'].includes(env.VERBOSE) };
    }

    if (env.DEBUG !== undefined) {
      if (!cfg.agent) cfg.agent = { verbose: true, debug: false, systemPrompt: null };
      cfg.agent.debug = ['1', 'true', 'TRUE', 'yes'].includes(env.DEBUG);
    }

    // 视觉配置（Task-20261010-001）：设置 VISION_API_KEY 或 VISION_MODEL 时自动启用视觉工具
    if (env.VISION_API_KEY || env.VISION_BASE_URL || env.VISION_MODEL) {
      cfg.vision = {};
      if (env.VISION_API_KEY) {
        cfg.vision.apiKey = env.VISION_API_KEY;
        cfg.vision.enabled = true;
      }
      if (env.VISION_BASE_URL) cfg.vision.baseUrl = env.VISION_BASE_URL;
      if (env.VISION_MODEL) {
        cfg.vision.model = env.VISION_MODEL;
        cfg.vision.enabled = true;
      }
    }

    return cfg;
  }

  /**
   * 解析各字段来源
   * 反向遍历：最后一个定义了该字段的层即为来源
   */
  private resolveSources(layers: {
    defaults: AgentConfig;
    env: PartialAgentConfig;
    global: PartialAgentConfig;
    workspace: PartialAgentConfig;
    cli: PartialAgentConfig;
  }): Record<string, ConfigSource> {
    const sources: Record<string, ConfigSource> = {};

    type Layer = { name: ConfigSource; cfg: PartialAgentConfig };
    const orderedLayers: Layer[] = [
      { name: 'default', cfg: layers.defaults },
      { name: 'env', cfg: layers.env },
      { name: 'global', cfg: layers.global },
      { name: 'workspace', cfg: layers.workspace },
      { name: 'cli', cfg: layers.cli },
    ];

    const walk = (prefix: string, path: string[], remainingLayers: Layer[], fields: unknown) => {
      // fields 是当前合并后的最终值，用于判断字段存在性
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return;

      const obj = fields as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        const pathArr = [...path, key];
        const flatKey = prefix + pathArr.join('.');

        // 反向查找最后定义了该 key 的层
        let found: ConfigSource = 'default';
        for (let i = orderedLayers.length - 1; i >= 0; i--) {
          if (layerHas(orderedLayers[i].cfg, pathArr)) {
            found = orderedLayers[i].name;
            break;
          }
        }
        sources[flatKey] = found;

        const val = obj[key];
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          walk(prefix, pathArr, [], val);
        }
      }
    };

    // 先用合并结果作为字段列表，再通过 layers 反向判断来源
    const merged = deepMerge<AgentConfig>(
      layers.defaults,
      layers.env as Partial<AgentConfig>,
      layers.global as Partial<AgentConfig>,
      layers.workspace as Partial<AgentConfig>,
      layers.cli as Partial<AgentConfig>,
    );
    walk('', [], [], merged);

    return sources;
  }
}

function layerHas(cfg: PartialAgentConfig, path: string[]): boolean {
  let cur: unknown = cfg;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return false;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return false;
    cur = (cur as Record<string, unknown>)[key];
  }
  return true;
}

async function readJsonSafe<T>(path: string): Promise<T> {
  try {
    const content = await readFile(path, 'utf-8');
    // 剥 BOM：部分编辑器（如 PowerShell UTF8、记事本）写入带 \uFEFF，会导致 JSON.parse 失败
    return JSON.parse(content.replace(/^\uFEFF/, '')) as T;
  } catch {
    return {} as T;
  }
}

function readJsonSafeSync<T>(path: string): T {
  try {
    const content = readFileSync(path, 'utf-8') as string;
    return JSON.parse(content.replace(/^\uFEFF/, '')) as T;
  } catch {
    return {} as T;
  }
}

/** 全局单例 */
export const configLoader = new ConfigLoader();
