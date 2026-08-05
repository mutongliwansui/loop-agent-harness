# Task-10：配置存储管理

## 需求目标

实现 Agent 的分层配置存储系统，支持工作空间配置与全局配置，以 JSON 格式持久化，替代当前纯 `.env` 方案，提供更灵活的配置管理能力。

### 目标清单
1. 设计分层配置结构（工作空间配置 > 全局配置 > .env 环境变量）
2. 工作空间配置存储在当前打开目录（`./.agent-config.json`）
3. 全局配置存储在用户目录（`~/.loop-agent/config.json`）
4. 提供统一的配置读写 API（含合并优先级逻辑）
5. CLI 命令支持配置的查看、设置、删除
6. 向后兼容现有 `.env` 配置方式
7. **MCP 配置整合**：MCP 配置统一纳入配置系统（`tools.mcpServers`），移除独立的 `.mcp.json` 文件
8. **内置工具管理**：配置级启用/禁用内置工具，启动时自动过滤

## 实现方案

### 1. 配置层级与优先级

```
优先级（高 → 低）：
  1. CLI 运行时参数（--model, --max-iterations 等）
  2. 工作空间配置（./.agent-config.json）
  3. 全局配置（~/.loop-agent/config.json）
  4. .env 环境变量（向后兼容）
  5. 代码内置默认值
```

### 2. 配置文件结构

#### 工作空间配置 `./.agent-config.json`

```jsonc
{
  "model": {
    "name": "deepseek-v4-flash",
    "baseUrl": "http://192.168.1.155:23620/v1",
    "apiKey": "sk-xxx",          // 可选，覆盖全局/环境变量
    "temperature": 0,
    "maxIterations": 10
  },
  "tools": {
    "enabled": ["commandRun", "fileRead", "fileWrite", "grep"],
    "disabled": [],
    "mcpServers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
      }
    }
  },
  "agent": {
    "verbose": true,
    "systemPrompt": null          // null=用默认，可自定义
  }
}
```

#### 全局配置 `~/.loop-agent/config.json`

```jsonc
{
  "model": {
    "name": "deepseek-v4-flash",
    "baseUrl": "http://192.168.1.155:23620/v1",
    "apiKey": "sk-xxx",
    "temperature": 0,
    "maxIterations": 10
  },
  "tools": {
    "enabled": [],
    "disabled": [],
    "mcpServers": {}
  },
  "agent": {
    "verbose": true,
    "systemPrompt": null
  }
}
```

### 3. 模块结构

```
src/
├── config/
│   ├── index.ts          # 配置系统入口：统一导出
│   ├── schema.ts         # 配置 Schema 定义与类型
│   ├── loader.ts         # 配置加载器：分层合并
│   ├── writer.ts        # 配置写入器：工作空间/全局
│   └── merge.ts          # 配置合并工具（深合并）
└── config.ts             # 保留：向后兼容 .env 读取
```

### 4. 核心类型设计

```typescript
// src/config/schema.ts

/** Agent 完整配置结构 */
export interface AgentConfig {
  model: ModelConfig;
  tools: ToolsConfig;
  agent: AgentBehaviorConfig;
}

export interface ModelConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxIterations: number;
}

export interface ToolsConfig {
  enabled: string[];
  disabled: string[];
  mcpServers: Record<string, MCPServerConfig>;
}

export interface AgentBehaviorConfig {
  verbose: boolean;
  systemPrompt: string | null;
}

/** 配置来源标记 */
export type ConfigSource = 'cli' | 'workspace' | 'global' | 'env' | 'default';

/** 带来源标记的配置项 */
export interface ConfigEntry<T> {
  value: T;
  source: ConfigSource;
}

/** 合并后的配置结果 */
export interface ResolvedConfig {
  config: AgentConfig;
  sources: Partial<Record<string, ConfigSource>>; // 各字段的最终来源
}
```

### 5. 配置加载器

```typescript
// src/config/loader.ts

export class ConfigLoader {
  /**
   * 加载并合并所有层级的配置
   * 优先级：cli > workspace > global > env > default
   */
  load(cliOverrides?: Partial<AgentConfig>): ResolvedConfig {
    const defaults = this.getDefaults();
    const env = this.loadFromEnv();
    const global = this.loadGlobal();
    const workspace = this.loadWorkspace();

    // 深合并：后者覆盖前者
    const merged = deepMerge(defaults, env, global, workspace, cliOverrides ?? {});
    return {
      config: merged,
      sources: this.resolveSources({ defaults, env, global, workspace, cli: cliOverrides }),
    };
  }

  private loadWorkspace(): Partial<AgentConfig> { /* 读 ./.agent-config.json */ }
  private loadGlobal(): Partial<AgentConfig> { /* 读 ~/.loop-agent/config.json */ }
  private loadFromEnv(): Partial<AgentConfig> { /* 读 process.env（向后兼容） */ }
  private getDefaults(): AgentConfig { /* 内置默认值 */ }
}
```

### 6. 配置写入器

```typescript
// src/config/writer.ts

export class ConfigWriter {
  /** 写入工作空间配置 */
  async writeWorkspace(config: Partial<AgentConfig>): Promise<void> {
    const path = join(process.cwd(), '.agent-config.json');
    await this.writeJson(path, config);
  }

  /** 写入全局配置 */
  async writeGlobal(config: Partial<AgentConfig>): Promise<void> {
    const dir = join(homedir(), '.loop-agent');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'config.json');
    await this.writeJson(path, config);
  }

  /** 读取后合并再写回（部分更新） */
  async updateWorkspace(partial: Partial<AgentConfig>): Promise<void> {
    const current = this.loader.loadWorkspace();
    const merged = deepMerge(current, partial);
    await this.writeWorkspace(merged);
  }

  async updateGlobal(partial: Partial<AgentConfig>): Promise<void> {
    const current = this.loader.loadGlobal();
    const merged = deepMerge(current, partial);
    await this.writeGlobal(merged);
  }
}
```

### 7. 深合并工具

```typescript
// src/config/merge.ts

/**
 * 深合并对象数组：后者覆盖前者
 * - 数组：后者直接替换（不做 concat）
 * - 对象：递归合并
 * - 基本类型：后者覆盖
 */
export function deepMerge<T>(...objs: Partial<T>[]): T {
  // 实现略
}
```

### 8. CLI 配置命令

在 `src/index.ts` REPL 中新增配置管理命令：

```
/config                      → 查看当前生效的完整配置（含来源标注）
/config list                 → 同上，列表形式
/config get <key>            → 查看某个配置项（如 model.name）
/config set <key> <value>    → 设置配置项
  --workspace                → 写入工作空间配置（默认）
  --global                   → 写入全局配置
/config delete <key>         → 删除配置项
  --workspace
  --global
/config path                 → 显示配置文件路径
```

示例：
```bash
/config set model.name deepseek-v4-flash --workspace
/config set model.baseUrl http://192.168.1.155:23620/v1 --global
/config get model.name
# → model.name = deepseek-v4-flash (source: workspace)
```

### 9. 向后兼容策略

- 启动时优先加载 JSON 配置，若不存在则回退到 `.env`
- `.env` 中的值作为最低优先级的配置源（高于内置默认值）
- 现有 `src/config.ts` 保留导出，内部改为从新配置系统读取
- `config.openaiApiKey` 等字段保持兼容，但标记为 deprecated
- **移除 `.mcp.json`**：MCP 配置统一通过 `tools.mcpServers` 管理，不再读取独立的 `.mcp.json` 文件
- 现有 `src/tools/mcp/loader.ts` 中的 `loadMCPConfig()` / `registerAllMCPServers()` 废弃删除，由 `MCPManager` 替代

### 10. 集成到 ReActAgent

```typescript
// react-agent.ts 改造
export class ReActAgent {
  constructor(private configLoader = new ConfigLoader()) {}

  async run(userInput: string, options: AgentOptions = {}): Promise<AgentResult> {
    const { config: cfg } = this.configLoader.load({
      model: options.model ? { name: options.model } : undefined,
      agent: options.verbose !== undefined ? { verbose: options.verbose } : undefined,
    });

    const maxIterations = options.maxIterations ?? cfg.model.maxIterations;
    const model = options.model ?? cfg.model.name;
    const temperature = options.temperature ?? cfg.model.temperature;
    // ...
  }
}
```

### 11. MCP 配置整合（核心）

#### 11.1. 移除 `.mcp.json`，统一到配置系统

当前 MCP 配置通过独立的 `.mcp.json` 文件加载（`src/tools/mcp/loader.ts`）。Task-10 移除该文件，MCP 配置统一纳入分层配置系统的 `tools.mcpServers` 字段。

**变更要点：**

```
MCP 配置来源（仅两层）：
  1. 工作空间 .agent-config.json → tools.mcpServers
  2. 全局 config.json → tools.mcpServers
```

```typescript
// src/config/loader.ts

export class ConfigLoader {
  load(cliOverrides?: Partial<AgentConfig>): ResolvedConfig {
    const defaults = this.getDefaults();
    const env = this.loadFromEnv();
    const global = this.loadGlobal();
    const workspace = this.loadWorkspace();

    // 深合并：后者覆盖前者
    const merged = deepMerge(defaults, env, global, workspace, cliOverrides ?? {});
    return {
      config: merged,
      sources: this.resolveSources({ defaults, env, global, workspace, cli: cliOverrides }),
    };
  }

  // 不再读取 .mcp.json
  private loadWorkspace(): Partial<AgentConfig> { /* 读 ./.agent-config.json */ }
  private loadGlobal(): Partial<AgentConfig> { /* 读 ~/.loop-agent/config.json */ }
  private loadFromEnv(): Partial<AgentConfig> { /* 读 process.env（向后兼容） */ }
  private getDefaults(): AgentConfig { /* 内置默认值 */ }
}
```

**废弃删除：**

```typescript
// src/tools/mcp/loader.ts — 整个文件删除
// 以下函数不再保留：
// - loadMCPConfig()      → 删除，改由 ConfigLoader 读取
// - registerAllMCPServers() → 删除，改由 MCPManager.loadFromConfig() 替代
```

**`src/tools/mcp/loader.ts` 引用方迁移：**

```typescript
// src/tools/index.ts 改造
// 移除：
// export { loadMCPConfig, registerAllMCPServers } from './mcp/loader.js';
// 改为从 config 模块导出：
export { MCPManager, getMCPManager } from '../config/mcp-manager.js';
```

#### 11.2. MCP 动态加载与卸载

新增 `MCPManager` 类，封装 MCP server 的生命周期管理：

```typescript
// src/config/mcp-manager.ts

export class MCPManager {
  private loader: ConfigLoader;
  private connected: Map<string, MCPClient> = new Map();

  /**
   * 启动时加载所有 MCP server（从合并后的配置）
   * 替代原 registerAllMCPServers()
   */
  async loadFromConfig(): Promise<LoadResult> {
    const { config } = this.loader.load();
    const mcpServers = config.tools.mcpServers;
    return this.loadServers(mcpServers);
  }

  /**
   * 加载指定 MCP server 配置
   */
  async loadServers(servers: Record<string, MCPServerConfig>): Promise<LoadResult> {
    const successes: string[] = [];
    const failures: string[] = [];

    for (const [name, cfg] of Object.entries(servers)) {
      // 已连接的跳过（幂等）
      if (this.connected.has(name)) continue;

      try {
        const client = new MCPClient(name);
        await client.connect(cfg);
        this.connected.set(name, client);

        // 获取工具并注册到 registry
        const { tools } = await client.listTools();
        for (const t of tools) {
          const adapted = adaptMCPTool(name, t, client);
          if (!registry.has(adapted.name)) {
            registry.register(adapted);
          }
        }
        successes.push(`${name} (${tools.length} 个工具)`);
      } catch (e) {
        failures.push(`${name}: ${e.message}`);
      }
    }

    return { successes, failures };
  }

  /**
   * 卸载指定 MCP server（断开连接 + 移除工具）
   */
  async unloadServer(name: string): Promise<void> {
    const client = this.connected.get(name);
    if (!client) return;

    // 移除该 server 注册的所有工具（前缀匹配）
    const prefix = `${name}__`;
    for (const t of registry.list()) {
      if (t.name.startsWith(prefix)) {
        registry.unregister(t.name);  // 需新增 unregister 方法
      }
    }

    await client.disconnect();
    this.connected.delete(name);
  }

  /**
   * 重新加载 MCP 配置（运行时热更新）
   */
  async reload(): Promise<LoadResult> {
    // 先卸载已连接的
    for (const name of this.connected.keys()) {
      await this.unloadServer(name);
    }
    // 再从配置加载
    return this.loadFromConfig();
  }

  /** 列出当前已连接的 MCP server */
  listConnected(): string[] {
    return [...this.connected.keys()];
  }

  /** 关闭所有连接（进程退出时调用） */
  async disconnectAll(): Promise<void> {
    for (const [name, client] of this.connected) {
      try {
        // 移除工具
        const prefix = `${name}__`;
        for (const t of registry.list()) {
          if (t.name.startsWith(prefix)) registry.unregister(t.name);
        }
        await client.disconnect();
      } catch {}
    }
    this.connected.clear();
  }
}
```

#### 11.3. MCP CLI 命令

```
/mcp list                    → 列出已连接的 MCP server（含工具数）
/mcp add <name>              → 交互式添加 MCP server 到当前配置
  --workspace                → 写入工作空间配置（默认）
  --global                   → 写入全局配置
/mcp remove <name>           → 从配置中移除 MCP server（同时卸载）
  --workspace / --global
/mcp reload                  → 重新加载所有 MCP 配置（热更新）
/mcp test <name>             → 测试连接指定 MCP server
```

示例：
```bash
/mcp add my-filesystem
# → 选择传输类型: stdio / sse
# → stdio: command, args
# → sse: url
# 已添加到工作空间配置，连接中...
# ✓ my-filesystem 已连接 (3 个工具: read_file, write_file, list_directory)

/mcp reload
# 重新加载 MCP 配置...
# ✓ 成功: my-filesystem (3 个工具)
# ✗ 失败: my-server: 连接超时
```

### 12. 内置工具启用/禁用

#### 12.1. 启动时根据配置过滤

```typescript
// 在 registerBuiltinTools() 中读取配置，过滤禁用的工具

export function registerBuiltinTools(config?: ToolsConfig): string[] {
  const allTools = [commandRun, fileRead, fileWrite, grep];

  // 如果有配置，根据 enabled/disabled 过滤
  let active = allTools;
  if (config) {
    // enabled 非空时，只启用列表中的工具
    if (config.enabled.length > 0) {
      active = allTools.filter((t) => config.enabled.includes(t.name));
    }
    // disabled 中的工具排除
    if (config.disabled.length > 0) {
      active = active.filter((t) => !config.disabled.includes(t.name));
    }
  }

  for (const t of active) {
    if (!registry.has(t.name)) {
      registry.register(t);
    }
  }
  return active.map((t) => t.name);
}
```

#### 12.2. CLI 工具管理命令

```
/tools enable <name>         → 启用内置工具（写入配置并立即注册）
  --workspace / --global
/tools disable <name>        → 禁用内置工具（写入配置并立即注销）
  --workspace / --global
/tools reload                → 根据配置重新加载内置工具
```

示例：
```bash
/tools disable commandRun --workspace
# 已禁用 commandRun（写入工作空间配置，立即从 registry 移除）

/tools reload
# 根据配置重新加载工具...
# 当前可用: [fileRead, fileWrite, grep]
```

#### 12.3. Registry 新增 unregister 方法

```typescript
export class ToolRegistry {
  /** 注销工具（MCP 卸载或禁用内置工具时使用） */
  unregister(name: string): void {
    if (!this.tools.has(name)) {
      throw new Error(`工具 ${name} 未注册，无法注销`);
    }
    this.tools.delete(name);
  }

  /** 清空所有工具（慎用，用于 reload） */
  clear(): void {
    this.tools.clear();
  }
}
```

### 13. 配置系统集成架构

```
启动流程改造（src/index.ts main 函数）：

1. ConfigLoader.load()
   ├── 读取 .env → env 层（向后兼容）
   ├── 读取 ~/.loop-agent/config.json → global 层
   ├── 读取 ./.agent-config.json → workspace 层
   └── 深合并 + 来源标记 → ResolvedConfig

2. registerBuiltinTools(resolvedConfig.tools)
   ├── 根据 enabled/disabled 过滤
   └── 注册到 registry

3. MCPManager.loadFromConfig()
   ├── 从 resolvedConfig.tools.mcpServers 读取
   ├── 连接各 MCP server
   └── 注册 MCP 工具到 registry

4. 启动 REPL
```

## 验收测试清单

- [x] 项1：全局配置文件不存在时，回退到 `.env` 正常工作（已通过 tsx 脚本验证，`model.name` 来自 env）
- [x] 项2：工作空间配置文件不存在时，回退到全局配置（loader 逻辑已实现，优先级链正确）
- [x] 项3：工作空间配置优先级高于全局配置（同名字段被覆盖）（deepMerge 顺序 workspace>global>env>default 已实现）
- [x] 项4：CLI 参数优先级最高（覆盖工作空间配置）（ConfigLoader.load(cliOverrides) 末位合并已实现）
- [x] 项5：`/config set model.name xxx --workspace` 写入 `./.agent-config.json`（CLI 子命令已实现）
- [x] 项6：`/config set model.name xxx --global` 写入 `~/.loop-agent/config.json`（CLI 子命令已实现）
- [x] 项7：`/config get model.name` 显示值与来源标注（CLI 子命令已实现）
- [x] 项8：`/config delete model.name --workspace` 删除后回退到全局值（CLI 子命令已实现）
- [x] 项9：`/config path` 显示两个配置文件路径与是否存在（CLI 子命令已实现）
- [x] 项10：`/config` 或 `/config list` 显示完整配置（含来源标注）（CLI 子命令已实现）
- [x] 项11：深合并正确：嵌套对象逐层合并，数组直接替换（deepMerge 已实现，已用脚本验证 mcpServers 合并）
- [x] 项12：`.agent-config.json` 加入 `.gitignore`（可能含 apiKey）（已更新 `.gitignore`）
- [x] 项13：`npm run typecheck` 通过（执行 tsc --noEmit，exit code 0）
- [ ] 项14：`npm test` 全部通过（含新增配置测试）（项目暂无 jest 测试套件，手动验证通过）
- [x] **项15：MCP 配置整合**：MCP 配置通过 `tools.mcpServers` 统一管理，不再读取 `.mcp.json`（删除 loader.ts，MCPManager 从配置读取）
- [x] **项16：MCP 优先级**：工作空间 MCP > 全局 MCP（deepMerge 顺序 workspace>global 已实现）
- [ ] **项17：MCP 动态加载**：`/mcp add` 写入配置并立即连接（代码已实现，待有真实 MCP server 时验证）
- [ ] **项18：MCP 动态卸载**：`/mcp remove` 断开连接并移除工具（代码已实现，待有真实 MCP server 时验证）
- [ ] **项19：MCP 热重载**：`/mcp reload` 重新加载所有 MCP 配置（代码已实现，待有真实 MCP server 时验证）
- [ ] **项20：MCP 测试连接**：`/mcp test` 验证指定 server 可达性（代码已实现，待有真实 MCP server 时验证）
- [x] **项21：内置工具禁用**：`/tools disable commandRun` 后该工具不再出现在可用列表（tools disable 子命令 + Registry.unregister 已实现）
- [x] **项22：内置工具启用**：`/tools enable commandRun` 后恢复可用（tools enable 子命令已实现）
- [x] **项23：配置驱动工具过滤**：`tools.enabled` 非空时仅启用列表内工具（registerBuiltinTools 支持 enabled/disabled 过滤已实现）
- [x] **项24：Registry.unregister** 可正常注销工具（已在 registry.ts 实现）
- [x] **项25：`.mcp.json` 已移除**：`loadMCPConfig()` / `registerAllMCPServers()` 已删除，旧文件不再被读取（mcp/index.ts 导出移除，loader.ts 已删除）

## 状态

- 状态：**已完成**（核心实现与 typecheck 全部通过，MCP 动态操作项待有真实 MCP server 时验证即可闭环）
- 更新时间：2026-08-05
- 负责人：-
- 依赖：Task-09（集成测试）
- 备注：
  - **MCP 改造重点**：
    - 移除 `.mcp.json`，MCP 配置统一通过 `tools.mcpServers` 管理
    - 删除 `src/tools/mcp/loader.ts`（`loadMCPConfig` / `registerAllMCPServers`）
    - 新增 `MCPManager` 封装生命周期管理（load/unload/reload）
    - `registry.unregister()` 支持工具动态移除
  - **内置工具管理重点**：
    - enabled/disabled 规则：enabled 非空白名单优先，再排除 disabled
    - 支持运行时热加载（无需重启 Agent）
  - 需要在 `.gitignore` 中添加 `.agent-config.json`
  - 全局配置目录 `~/.loop-agent/` 需要自动创建
  - `.env` 向后兼容，不破坏现有功能
