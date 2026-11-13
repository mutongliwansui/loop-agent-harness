# 🔍 故障排查

> [⬅ 返回 README](../../../README.md)

### API Key 无效或已过期

```
错误：API Key 无效或已过期，请检查 .env 中的 OPENAI_API_KEY
```

**解决**：检查 `.env` 中 `OPENAI_API_KEY` 是否正确，是否与 `OPENAI_BASE_URL` 对应的服务商匹配。也可通过 `/config set model.apiKey <key>` 运行时修改。

### 模型不存在（404）

```
错误：模型不存在（404），请检查 .env 中的 MODEL_NAME（当前: xxx）
```

**解决**：确认 `MODEL_NAME` 在目标服务商上可用。通过 `/config set model.name <新模型名>` 运行时修改。

### 请求过于频繁（429）

```
错误：请求过于频繁（429），请稍后重试或降低调用频率
```

**解决**：降低调用频率。集成测试（`tests/integration/`）默认串行执行（`fileParallelism: false`）避免并发限速；unit 层测试均为 mock，可并行执行。

### 集成测试显示 6 个用例 skipped

全量回归输出里 `a-no-tool` / `b-single-tool` / `c-multi-tool` / `d-tool-failure` / `f-max-iterations` / `g-parallel-tools` 六个用例被跳过（用例名后带「已跳过：…」原因），**属预期行为**：它们需要真实模型，默认关闭门禁。

**解决**：需要真实联调时设置 `LOOP_AGENT_LIVE_MODEL=1` 并确保凭据可用（`OPENAI_API_KEY`，或 `~/.loop-agent/config.json` 的 `model.apiKey`），再跑 `npm run test:integration`。详见开发文档。

### 工具执行超时

```
错误：工具执行超时 (30000ms)
```

**解决**：`commandRun` 工具默认 30s 超时，可通过 `timeout` 参数调整。复杂命令建议拆分为多步执行。

### Windows 终端中文乱码

**解决**：CLI 启动时已自动执行 `chcp 65001` 切换到 UTF-8。如仍乱码，手动运行 `chcp 65001` 后再启动。

### 达到最大迭代次数

```
错误：达到最大迭代次数 100，Agent 未能给出最终答案
```

**解决**：增大 `.env` 中 `MAX_ITERATIONS`，或通过 `/config set agent.maxIterations 20` 运行时修改。也可以简化问题描述，让 Agent 在更少步骤内完成。

### 工具未注册

```
错误：工具 xxx 未注册
```

**解决**：调用 `registerBuiltinTools()` 注册内置工具，或通过 `registry.register(tool)` 注册自定义工具。也可通过 `/tools reload` 重新加载。

### MCP 连接失败

```
错误：MCP server xxx 连接失败
```

**解决**：检查 MCP 配置是否正确，可执行 `/mcp test <name>` 测试连接。使用 `/mcp remove <name>` 移除后重新 `/mcp add <name>` 添加。

### Skill 未找到

```
错误：Skill "xxx" 未找到。可用的 Skill: ...
```

**解决**：确认 Skill 已放入 `~/.loop-agent/skills/`（自需求 20261112-008 起为唯一 Skill 目录，工作空间目录不再扫描），且 `SKILL.md` 包含合法的 `name` 和 `description` frontmatter。通过 `/skill list` 查看扫描结果，`/skill reload` 重新扫描。

### 记忆系统未启用

```
⚠ 记忆系统未启用，请在配置中设置 memory.enabled=true
```

**解决**：通过 `/config set memory.enabled true` 开启，或直接编辑 `~/.loop-agent/config.json`。`/memory status` 可查看当前启用状态与各层统计。

### 会话无法加载 / 解密失败

```
错误：密钥文件损坏，验证失败
错误：密钥未加载，无法读取会话
```

**解决**：
- 检查 `~/.loop-agent/.keyfile` 是否存在且未损坏
- 若误删/损坏，可通过备份的 `exportKey()` 导出的 base64 调用 `keychain.importKey()` 恢复
- 若无法恢复，可删除损坏的会话文件（`/session delete <id>`）后重新开始

### 调试日志未生成

**解决**：确认已通过 `DEBUG=true` 环境变量或 `/config set agent.debug true` 开启调试模式，日志输出到 `~/.loop-agent/logs/debug-YYYY-MM-DD.log`。开启后 CLI 启动 banner 会显示调试日志目录提示。

### 配置来源追踪

当配置未按预期生效时，可通过 `/config list` 查看每个字段的实际来源（cli / workspace / global / env / default），快速定位是哪一层覆盖了配置。

### Web UI 跨空间会话无法发送

**现象**：侧栏中其他工作空间的会话无法发消息（旧版前端曾标记为"只读"）。

**解决**：跨空间会话自 20261021-010 起可直接续聊。遇到此现象说明浏览器缓存了旧版前端——强制刷新（`Ctrl+F5`）；若自行构建过前端，重新执行 `npm run build:webui`。

### 同空间并发发消息返回 409 busy

**现象**：向同一会话并发发送消息，后一条返回 409（`busy`）。

**说明**：这属预期行为——同一会话同时只处理一条消息。跨工作空间互不影响：A 空间运行中，B 空间可正常新建会话、发消息；若跨空间也遇 busy，请升级到含 20261021-010 的版本。
