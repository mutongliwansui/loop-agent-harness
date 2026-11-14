/**
 * `@loop-agent/main` 对外导出面。
 *
 * 分三块：宿主入口、持久化注册中心、清单类型。
 * 不导出内部实现细节（写队列、加载器内部路径解析等），
 * 以免使用方依赖到「本可自由重构」的结构。
 */

// ── 宿主入口 ──
export { createMainHost, MAIN_SERVICE_KEYS } from './host.js';
export type { HomeService, Logger, MainHost, MainHostOptions } from './host.js';

// ── 持久化插件注册中心 ──
export { PersistentPluginRegistry, defaultLoadPlugin } from './registry.js';
export type { PersistentPluginRegistryOptions } from './registry.js';

// ── 清单存储 ──
export { createPluginStore } from './store.js';
export type { PluginStore, PluginStoreOptions } from './store.js';

// ── 清单与诊断类型 ──
export { MANIFEST_SCHEMA_VERSION, emptyManifest } from './types.js';
export type { PluginManifest, PluginManifestEntry, RegistryDiagnostic } from './types.js';

// ── 用户目录 ──
export { loopAgentHome, pluginsDir } from './home.js';
