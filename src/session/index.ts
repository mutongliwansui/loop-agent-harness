// 会话系统聚合入口
export { SessionStore, workspaceId, SessionNotFoundError } from './store.js';
export { canonicalWorkspacePath, isSameWorkspace, lexicalWorkspacePath } from './path-utils.js';
export { Keychain, keychain } from './keychain.js';
export { encrypt, decrypt } from './crypto.js';
export type {
  SessionMeta,
  SessionData,
  WorkspaceMeta,
  WorkspaceSummary,
  SessionConfig,
} from './types.js';
export { DEFAULT_SESSION_CONFIG } from './types.js';
