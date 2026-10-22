# 💾 会话持久化

> [⬅ 返回 README](../../../README.md)

Agent 内置了基于文件系统的会话持久化能力：对话历史（messages + steps）加密存储到本地磁盘，重启 CLI 后可通过 `/session load <id>` 恢复上下文继续对话。

### 存储结构

```
~/.loop-agent/
├── .keyfile                      # 🔑 主密钥文件（首次自动生成，权限 0600）
├── config.json                   # 全局配置（可选）
├── logs/
│   └── debug-YYYY-MM-DD.log      # 📝 调试日志（见下节）
└── sessions/
    └── {workspaceId}/            # 按工作空间隔离（canonical 化路径的 SHA-256 前 16 位：大小写/分隔符/尾斜杠归一）
        ├── meta.json             # 工作空间元信息
        ├── sessions.json         # 会话索引（仅元信息，不含消息内容）
        └── sess_{wsId8}_YYYYMMDD_HHMMSS.enc   # 加密的会话数据文件（id 含空间段，wsId8 = workspaceId 前 8 位）
```

> **sessionId 空间命名空间**：新格式为 `sess_<wsId8>_<时间戳>`，按 id 即可定位会话所属空间（HTTP 端点不再因此切换"当前空间"）；老格式 `sess_<时间戳>`（无空间段）永久兼容读取，经全量扫描回退定位。

### 加密机制

- **主密钥**：首次使用时自动生成 256-bit 随机密钥，保存于 `~/.loop-agent/.keyfile`（`0600` 权限），无需用户输入密码
- **数据加密**：会话消息通过 **PBKDF2（100,000 次迭代）派生** + **AES-256-GCM** 加密，附带认证标签保证完整性
- **密钥校验**：密钥文件包含校验 token，读取时会验证密钥完整性，损坏则报错
- **索引明文**：`sessions.json` 仅存储会话元信息（ID、标题、消息数、时间），消息内容全部加密

### 自动保存 / 恢复

- **自动保存**：`run()` 结束后，若 `session.autoSave=true` 且已设置 SessionStore，自动创建新会话或更新当前会话
- **自动恢复**：`session.autoRestore=true` 时，CLI 启动会自动加载最近一次会话，无缝续接上次对话
- **手动控制**：可通过 `/session` 子命令随时 list / load / save / new / delete

### 密钥管理（Keychain）

`src/session/keychain.ts` 提供密钥生命周期管理：

| 方法 | 说明 |
|---|---|
| `keychain.ensureUnlocked()` | 确保密钥已加载（首次自动生成密钥文件） |
| `keychain.exportKey()` | 导出主密钥（base64，用于备份） |
| `keychain.importKey(base64)` | 从备份导入主密钥（用于迁移/恢复） |
| `keychain.reset()` | 删除密钥文件（⚠️ 会导致所有加密会话无法解密） |

> ⚠️ **重要**：`.keyfile` 是解密会话的唯一凭证。丢失该文件将导致所有加密会话无法恢复，建议定期 `exportKey()` 备份。
